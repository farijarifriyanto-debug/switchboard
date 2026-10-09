import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'

export type SandboxMode = 'off' | 'bwrap' | 'docker'

export interface SandboxConfig {
  /**
   * `bwrap` (Linux, bubblewrap, no daemon) or `docker`. `off` runs commands on
   * the host as you. When a sandbox is chosen but unavailable the command is
   * refused: there is no silent fallback to the host.
   */
  mode?: SandboxMode
  /** Let sandboxed commands reach the network. Default false. */
  network?: boolean
  /** `rw` (default) or `ro` for the project folder. */
  workspace?: 'rw' | 'ro'
  /** Extra host folders mounted read-only at the same path (e.g. a toolchain outside /usr). */
  readOnly?: string[]
  /** Names of host env vars to pass in. Default none: API keys stay out of reach. */
  passEnv?: string[]
  /** docker: image to run in (default node:24-alpine); pull it first. */
  image?: string
  /** docker: memory limit (default 1g). */
  memory?: string
  /** docker: CPU limit (default 1). */
  cpus?: number
  /** docker: process limit (default 256). */
  pids?: number
}

export interface SandboxCommand {
  file: string
  args: string[]
  /** docker only: the container to `docker kill` when the command is stopped. */
  container?: string
}

/** Where the project appears inside the sandbox. */
export const SANDBOX_WORKDIR = '/workspace'
const BASE_PATH = '/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin'

/** True when `p` exists on the host. */
const has = (p: string): boolean => existsSync(p)
const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function passedEnv(config: SandboxConfig): Array<[string, string]> {
  return (config.passEnv ?? []).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && process.env[name] !== undefined).map((name) => [name, process.env[name] as string])
}

/** Builds the wrapper command line. Pure apart from reading which host paths exist. */
export function buildSandboxCommand(config: SandboxConfig, opts: { workspace: string; command: string; name: string; uid?: number; gid?: number }): SandboxCommand {
  const ro = config.workspace === 'ro'
  if (config.mode === 'docker') {
    const container = `sbx-${opts.name}`
    const args = [
      'run', '--rm', '--name', container, '--init',
      '--network', config.network ? 'bridge' : 'none',
      '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=256m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', String(config.pids ?? 256), '--memory', config.memory ?? '1g', '--cpus', String(config.cpus ?? 1),
      ...(opts.uid !== undefined && opts.gid !== undefined ? ['--user', `${opts.uid}:${opts.gid}`] : []),
      '-e', 'HOME=/tmp',
      ...passedEnv(config).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      '-v', `${opts.workspace}:${SANDBOX_WORKDIR}${ro ? ':ro' : ''}`,
      ...(config.readOnly ?? []).flatMap((dir) => ['-v', `${dir}:${dir}:ro`]),
      '-w', SANDBOX_WORKDIR,
      config.image ?? 'node:24-alpine', 'sh', '-c', opts.command,
    ]
    return { file: 'docker', args, container }
  }
  // bubblewrap: a fresh empty root with only what a command needs
  const args = ['--unshare-all', ...(config.network ? ['--share-net'] : []), '--die-with-parent', '--new-session', '--clearenv']
  args.push('--ro-bind', '/usr', '/usr')
  for (const dir of ['bin', 'sbin', 'lib', 'lib32', 'lib64']) if (isLink(`/${dir}`)) args.push('--symlink', `usr/${dir}`, `/${dir}`)
    else if (has(`/${dir}`) && !isLink(`/${dir}`)) args.push('--ro-bind', `/${dir}`, `/${dir}`)
  for (const file of ['/etc/ssl', '/etc/ca-certificates', '/etc/alternatives', ...(config.network ? ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf'] : [])]) if (has(file)) args.push('--ro-bind', file, file)
  for (const dir of config.readOnly ?? []) if (has(dir)) args.push('--ro-bind', dir, dir)
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp')
  args.push(ro ? '--ro-bind' : '--bind', opts.workspace, SANDBOX_WORKDIR, '--chdir', SANDBOX_WORKDIR)
  args.push('--setenv', 'PATH', BASE_PATH, '--setenv', 'HOME', '/tmp', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'TERM', 'dumb')
  for (const [k, v] of passedEnv(config)) args.push('--setenv', k, v)
  args.push('/bin/sh', '-c', opts.command)
  return { file: 'bwrap', args }
}

const checked = new Map<string, string | null>()

/**
 * Returns null when the sandbox can run, otherwise why not. Cached per mode+image
 * for the process: a probe is a real (cheap) run, not a version check.
 */
export function sandboxProblem(config: SandboxConfig): string | null {
  const key = `${config.mode}|${config.image ?? ''}`
  if (checked.has(key)) return checked.get(key) ?? null
  let problem: string | null = null
  if (config.mode === 'bwrap') {
    if (process.platform !== 'linux') problem = 'bubblewrap only runs on Linux; use mode "docker"'
    else {
      const probe = spawnSync('bwrap', ['--unshare-all', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', ...(isLink('/lib64') ? ['--symlink', 'usr/lib64', '/lib64'] : []), 'true'], { timeout: 10_000 })
      if (probe.error) problem = 'bubblewrap (bwrap) is not installed'
      else if (probe.status !== 0) problem = `bubblewrap cannot create a sandbox here (${String(probe.stderr ?? '').trim().split('\n')[0] || `exit ${probe.status}`}); user namespaces may be disabled`
    }
  } else if (config.mode === 'docker') {
    const info = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 })
    if (info.error || info.status !== 0) problem = 'docker is not available (is the daemon running and are you allowed to use it?)'
    else {
      const image = config.image ?? 'node:24-alpine'
      const found = spawnSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { timeout: 10_000 })
      if (found.status !== 0) problem = `docker image "${image}" is not present; run: docker pull ${image}`
    }
  }
  checked.set(key, problem)
  return problem
}

/** Stops a sandboxed docker command: killing the client leaves the container running. */
export function killContainer(container: string): void {
  spawn('docker', ['kill', container], { stdio: 'ignore' }).on('error', () => undefined)
}

export function describeSandbox(config: SandboxConfig): string {
  if (!config.mode || config.mode === 'off') return ''
  const net = config.network ? 'network allowed' : 'no network'
  return `Commands run inside a ${config.mode} sandbox: the project is mounted at ${SANDBOX_WORKDIR} (${config.workspace === 'ro' ? 'read-only' : 'writable'}), the rest of the machine and the host environment are not visible, ${net}, and the system is a minimal ${config.mode === 'docker' ? `container (${config.image ?? 'node:24-alpine'})` : 'view of /usr'}. The shell there is sh, not bash (a minimal container may have no bash at all).`
}

