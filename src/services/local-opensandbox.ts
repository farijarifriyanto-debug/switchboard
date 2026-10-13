/** Locally managed official OpenSandbox server. Docker is an OPTIONAL dependency,
 * and the server API is only published on 127.0.0.1. Never expose the daemon
 * socket or share this auth key with a BotConnector Cloud tenant. */
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { chmod, lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const exec = promisify(execFile)
const IMAGE = 'opensandbox/server@sha256:de9f40d12563412de8fc6651b15182f14293d4d5a2c32b5bdf45c6fee1b27af3'
const CONTAINER_LABEL = 'botconnector.switchboard.opensandbox.install'
const CONFIG_NAME = 'server.toml'
const PORT_IN_CONTAINER = 18088
const DOCKER_SOCKET = '/var/run/docker.sock'

export interface ManagedLocal { installId: string; containerName: string; port: number }
export interface ProvisionedLocal { managed: ManagedLocal; endpoint: string; apiKey: string }
const docker = async (args: string[], timeout = 12000): Promise<string> => {
  try {
    const response = await exec('docker', args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
    return response.stdout.trim()
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') throw new Error('Docker Desktop / Docker Engine is required for Local OpenSandbox.')
    const stderr = String((error as { stderr?: string }).stderr ?? '')
    if (/failed to connect to the docker API|dockerDesktopLinuxEngine|cannot connect to the docker daemon|is the docker daemon running/i.test(stderr)) {
      throw new Error('Docker Desktop / Docker Engine is not running. Start Docker Desktop in Linux-container mode, then retry.')
    }
    if (/no space left|not enough space/i.test(stderr)) throw new Error('Docker has insufficient disk space for OpenSandbox.')
    if (/permission denied|access is denied/i.test(stderr)) throw new Error('Docker permission denied. Check the current account permissions.')
    if (/manifest unknown|pull access denied/i.test(stderr)) throw new Error('The pinned OpenSandbox image is unavailable from the official registry.')
    throw new Error('Docker operation failed. Make sure Docker is running and can download the server image.', { cause: error })
  }
}

function localDir(root: string, managed: ManagedLocal): string {
  if (!/^[a-f0-9-]{36}$/i.test(managed.installId) || !/^sbx-opensandbox-[a-f0-9]{12}$/.test(managed.containerName)) {
    throw new Error('Invalid managed Docker metadata')
  }
  return path.join(root, 'opensandbox-local', managed.installId)
}
async function choosePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); return reject(new Error('Cannot allocate a local port')) }
      const port = address.port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function isOwned(managed: ManagedLocal): Promise<boolean> {
  const found = await docker(['inspect', '--format', `{{index .Config.Labels "${CONTAINER_LABEL}"}}`, managed.containerName])
  return found === managed.installId
}

export async function stopLocalSandbox(root: string, managed: ManagedLocal): Promise<void> {
  // Distinguish a Docker daemon outage (cannot verify ownership) from a
  // previously deleted container. Do not refuse normal cleanup in the latter case.
  const names = (await docker(['container', 'ls', '-a', '--format', '{{.Names}}'])).split('\n')
  if (names.includes(managed.containerName)) {
    if (!(await isOwned(managed))) throw new Error('Existing Docker container is not owned by this Switchboard installation; refusing to remove it')
    await docker(['rm', '-f', managed.containerName], 25000)
  }
  const confDir = localDir(root, managed)
  // The directory was created by this installer and contains only its config.
  const type = await lstat(confDir)
  if (!type.isDirectory() || type.isSymbolicLink()) throw new Error('Managed OpenSandbox directory is unsafe to delete')
  await rm(confDir, { recursive: true, force: true })
}

export async function startLocalSandbox(root: string): Promise<ProvisionedLocal> {
  const platform = process.platform
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error('Local Docker sandbox is unsupported on this OS')
  const os = await docker(['version', '--format', '{{.Server.Os}}'])
  if (os !== 'linux') throw new Error('OpenSandbox requires Docker Linux containers. Switch Docker Desktop to Linux containers.')
  const installId = randomUUID()
  const managed: ManagedLocal = { installId, containerName: `sbx-opensandbox-${installId.replaceAll('-', '').slice(0, 12)}`, port: await choosePort() }
  const confDir = localDir(root, managed)
  const parent = path.dirname(confDir)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const parentStat = await lstat(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('Local Docker configuration directory is not a directory')
  await mkdir(confDir, { mode: 0o700 })
  const confPath = path.join(confDir, CONFIG_NAME)
  const apiKey = randomBytes(32).toString('hex')
  const content = `[server]\nhost = "0.0.0.0"\nport = ${PORT_IN_CONTAINER}\napi_key = "${apiKey}"\nmax_sandbox_timeout_seconds = 120\n[proxy]\nresolve_internal = true\n[log]\nlevel = "WARNING"\n[runtime]\ntype = "docker"\nexecd_image = "opensandbox/execd:v1.1.0"\n[store]\ntype = "sqlite"\npath = "/tmp/opensandbox-local.db"\n[docker]\nnetwork_mode = "bridge"\npublish_host = "127.0.0.1"\nno_new_privileges = true\npids_limit = 128\ndrop_capabilities = ["AUDIT_WRITE", "MKNOD", "NET_ADMIN", "NET_RAW", "SYS_ADMIN", "SYS_MODULE", "SYS_PTRACE", "SYS_TIME", "SYS_TTY_CONFIG"]\n[ingress]\nmode = "direct"\n`
  try {
    await writeFile(confPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chmod(confPath, 0o600)
    const mountSource = path.resolve(confPath)
    if (mountSource.includes(',')) throw new Error('Unsupported comma in user profile path for Docker mount')
    const args = [
      'run', '-d', '--name', managed.containerName,
      '--label', `${CONTAINER_LABEL}=${managed.installId}`,
      '--pull', 'missing', '--restart', 'unless-stopped',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '128', '--memory', '512m', '--cpus', '1',
      '--tmpfs', '/tmp:rw,nosuid,size=128m',
      '--publish', `127.0.0.1:${managed.port}:${PORT_IN_CONTAINER}`,
      '--mount', `type=bind,source=${mountSource},target=/etc/opensandbox/config.toml,readonly`,
      '--mount', `type=bind,source=${DOCKER_SOCKET},target=${DOCKER_SOCKET}`,
      IMAGE,
    ]
    await docker(args, 300000) // First install may download the official pinned image.
    let ok = false
    for (let i = 0; i < 32; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${managed.port}/health`, { signal: AbortSignal.timeout(2000) })
        if (response.ok) { ok = true; break }
      } catch { /* Server is not ready yet. */ }
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
    if (!ok) throw new Error('The local OpenSandbox container started but did not become healthy')
    return { managed, endpoint: `127.0.0.1:${managed.port}`, apiKey }
  } catch (error) {
    // docker run can return a transport/timeout error *after* creating the
    // container. Always attempt ownership-checked cleanup, even then.
    let cleanupVerified = false
    try {
      const names = (await docker(['container', 'ls', '-a', '--format', '{{.Names}}'])).split('\n')
      if (names.includes(managed.containerName)) {
        if (!(await isOwned(managed))) throw new Error('Docker container label ownership differs')
        await docker(['rm', '-f', managed.containerName], 25000)
      }
      cleanupVerified = true
    } catch { /* Preserve recovery evidence if Docker cleanup cannot be verified. */ }
    if (cleanupVerified) await rm(confDir, { recursive: true, force: true })
    else throw new Error('Local OpenSandbox failed; Docker cleanup could not be verified. Retained private configuration for operator recovery.', { cause: error })
    throw error
  }
}
