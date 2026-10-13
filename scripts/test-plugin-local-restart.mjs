/** Restart/reconnect: install local plugin, dispose host, create a new host
 * with the SAME settings dir (simulated app restart) and verify reconnect. */
import assert from 'node:assert/strict'
import { createHost } from '../dist/index.js'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileP = promisify(execFile)
const dir = await mkdtemp(path.join(tmpdir(), 'sbx-local-restart-'))
let host1
let managed
try {
  // --- Session 1: install
  host1 = await createHost({
    llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'fixture', retries: 0 },
    sessions: { dir: '', load: false }, metrics: { persist: '', load: false }, approval: { mode: 'off' },
    settings: { dir }, web: { enabled: true, port: 0, host: '127.0.0.1' },
  })
  const res = await fetch(`${(await host1.ctx.web.ready()).url}api/plugin-catalog/install`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'opensandbox', mode: 'local' }),
  })
  const reply = await res.json()
  assert.equal(reply.plugin.state, 'up')
  console.log('RESTART_INSTALL_PASS tools:', reply.plugin.toolCount)
  const registry = JSON.parse(await readFile(path.join(dir, 'installed-mcp.json'), 'utf8'))
  managed = registry.installed.find((x) => x.id === 'opensandbox')?.local
  assert.ok(managed?.containerName)
  const cname = managed.containerName
  await host1.dispose()
  host1 = undefined
  console.log('RESTART_HOST_DISPOSED_PASS')

  // --- Session 2 (simulated app restart): same settings dir, plugin must reconnect
  const host2 = await createHost({
    llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'fixture', retries: 0 },
    sessions: { dir: '', load: false }, metrics: { persist: '', load: false }, approval: { mode: 'off' },
    settings: { dir }, web: { enabled: true, port: 0, host: '127.0.0.1' },
  })
  try {
    const status = host2.ctx.mcp.status().find((s) => s.name === 'opensandbox')
    assert.ok(status, 'opensandbox MCP must be present after restart')
    assert.equal(status.state, 'up', `state=${status.state}`)
    assert.ok(status.tools.length >= 20, `tools=${status.tools.length}`)
    console.log('RESTART_MCP_RECONNECT_PASS tools:', status.tools.length)
    // catalog shows local mode persisted
    const item = host2.ctx.pluginCatalog.list().find((p) => p.id === 'opensandbox')
    assert.equal(item.mode, 'local')
    assert.equal(item.state, 'up')
    console.log('RESTART_CATALOG_PERSISTED_PASS')
    // real exec through the reconnected MCP
    const created = await host2.ctx.tools.callResult('mcp__opensandbox__sandbox_create', {
      image: process.env.SBX_TEST_OPENSANDBOX_IMAGE || 'opensandbox/code-interpreter:latest',
      resource: { cpu: '500m', memory: '512Mi' }, timeout_seconds: 100, ready_timeout_seconds: 45,
    })
    assert.notEqual(created.isError, true, created.content)
    const data = created.structuredContent || JSON.parse(created.content)
    const sid = data.sandbox_id || data.id
    const run = await host2.ctx.tools.callResult('mcp__opensandbox__command_run', { sandbox_id: sid, command: 'echo reconnect-ok' })
    assert.match(JSON.stringify(run.content ?? run), /reconnect-ok/)
    console.log('RESTART_REAL_EXEC_PASS')
    await host2.ctx.tools.callResult('mcp__opensandbox__sandbox_kill', { sandbox_id: sid })
    // same container still owned by the same installId across restart
    const label = await execFileP('docker', ['inspect', '--format', '{{index .Config.Labels "botconnector.switchboard.opensandbox.install"}}', cname])
    assert.equal(label.stdout.trim(), managed.installId)
    console.log('RESTART_CONTAINER_OWNERSHIP_INTACT_PASS')
    await host2.ctx.pluginCatalog.uninstall('opensandbox')
    managed = undefined
    const gone = await execFileP('docker', ['container', 'inspect', cname]).then(() => false, () => true)
    assert.equal(gone, true)
    console.log('RESTART_CLEAN_UNINSTALL_PASS')
  } finally { await host2.dispose() }
  console.log('RESTART_RECONNECT_FULL_PASS')
} finally {
  if (host1) await host1.dispose().catch(() => {})
  if (managed) {
    try { await execFileP('docker', ['rm', '-f', managed.containerName]) } catch {}
    await rm(path.join(dir, 'opensandbox-local'), { recursive: true, force: true }).catch(() => {})
  }
  await rm(dir, { recursive: true, force: true })
}