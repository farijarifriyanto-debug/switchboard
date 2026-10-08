/**
 * Unit-ish test for the approval gate and workspace boundary services.
 *
 *   node scripts/test-approval.mjs
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHost } from '../dist/index.js'

const scratch = await mkdtemp(path.join(os.tmpdir(), 'sb-approval-'))
await writeFile(path.join(scratch, 'note.txt'), 'hello', 'utf8')

const host = await createHost({
  llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub' },
  metrics: { persist: '', load: false },
  sessions: { dir: '', load: false },
  workspace: { root: scratch, remember: false },
  approval: { mode: 'risky', timeoutMs: 250 },
  tools: { shell: {} },
})

try {
  const { ctx } = host

  // ---------------------------------------------------------------- risky gate
  assert.equal(ctx.approvals.mode, 'risky')
  assert.equal(ctx.approvals.needsApproval('run_command'), true, 'run_command is risky')
  assert.equal(ctx.approvals.needsApproval('write_file'), true, 'write_file is risky')
  assert.equal(ctx.approvals.needsApproval('read_file'), false, 'read_file is safe')

  assert.equal(ctx.approvals.needsApproval('external_tool', 's', 'risky'), true, 'a tool marked risky is gated in risky mode')
  assert.equal(ctx.approvals.needsApproval('external_tool', 's'), false, 'unmarked tools are not')

  // A listener that decides synchronously (the CLI operator) must find the pending record.
  const off = ctx.on('approval/request', ({ id }) => {
    ctx.approvals.decide(id, 'rejected')
  })
  assert.match(await ctx.tools.call('run_command', { command: 'echo nope' }, { sessionId: 's-sync' }), /rejected/, 'synchronous decide() works')
  off()

  // A risky call parks in `pending` until decided; the tool then really runs.
  const parked = ctx.tools.call('run_command', { command: 'echo parked' }, { sessionId: 's-test' })
  await new Promise((r) => setImmediate(r))
  const pending = ctx.approvals.pending()
  assert.equal(pending.length, 1, 'the call should sit in the gate')
  assert.equal(pending[0].tool, 'run_command')
  assert.equal(pending[0].sessionId, 's-test')

  const decided = ctx.approvals.decide(pending[0].id, 'approved')
  assert.equal(decided, true)
  const out = await parked
  assert.match(out, /parked/, 'approved call actually executed')

  // The audit trail knows the tool name even after settle.
  assert.equal(ctx.approvals.recent[0].tool, 'run_command')
  assert.equal(ctx.approvals.recent[0].decision, 'approved')

  // --------------------------------------------------------------- rejection
  const rejected = ctx.tools.call('write_file', { path: 'nope.txt', content: 'x' })
  await new Promise((r) => setImmediate(r))
  const [item] = ctx.approvals.pending()
  ctx.approvals.decide(item.id, 'rejected')
  const rejectedResult = await rejected
  assert.match(rejectedResult, /rejected/, 'a rejected call returns an error string')
  assert.equal(
    await rm(path.join(scratch, 'nope.txt'), { force: true }).then(() => 'gone').catch(() => 'exists'),
    'gone',
    'rejected write must not touch disk',
  )
  assert.equal(ctx.approvals.recent[0].decision, 'rejected')
  assert.equal(ctx.approvals.recent[0].tool, 'write_file', 'audit names the rejected tool')

  // -------------------------------------------------------------- audit trail
  {
    const entry = ctx.approvals.recent.find((e) => e.id === item.id)
    assert.ok(entry, 'settled id appears in the audit trail')
    assert.equal(entry.tool, 'write_file')
  }

  // ------------------------------------------------------------------ timeout
  // The unref'd gate timer would otherwise let an idle loop exit; hold the
  // process open so the auto-reject actually fires.
  const keepAlive = setInterval(() => {}, 500)
  const timedOut = ctx.tools.call('run_command', { command: 'echo never' })
  const result = await timedOut
  clearInterval(keepAlive)
  assert.match(result, /timed out/, 'an abandoned gate auto-rejects')
  assert.equal(ctx.approvals.recent[0].decision, 'timeout')
  assert.equal(ctx.approvals.recent[0].tool, 'run_command', 'timeout audit names the tool')

  // ------------------------------------------------------- workspace boundary
  assert.equal(ctx.workspace.root, path.resolve(scratch))
  assert.throws(() => ctx.workspace.resolve('../outside'), /escapes workspace/)
  // Absolute paths outside the root escape on every OS (drive-rooted on win32).
  assert.throws(() => ctx.workspace.resolve('/etc/passwd'), /escapes workspace/)
  // `C:\elsewhere` only counts as absolute on Windows; elsewhere it is a plain
  // (odd) relative file name inside the root, so it must NOT throw there.
  if (process.platform === 'win32') {
    assert.throws(() => ctx.workspace.resolve('C:\\elsewhere'), /escapes workspace/)
  }

  const sibling = await mkdtemp(path.join(os.tmpdir(), 'sb-ws-'))
  await writeFile(path.join(sibling, 'marker.txt'), 'sibling', 'utf8')
  const switched = await ctx.workspace.use(sibling)
  assert.equal(switched, path.resolve(sibling))

  // tools-fs follows the changed boundary: read_file inside the new root works.
  const read = await ctx.tools.call('read_file', { path: 'marker.txt' })
  assert.equal(read, 'sibling', 'fs tools re-point after workspace switch')
  // ...and the old root is now outside the boundary.
  const oldRead = await ctx.tools.call('read_file', { path: path.join(scratch, 'note.txt') })
  assert.match(oldRead, /escapes workspace/, 'the previous root is out of bounds now')

  // Recents list remembers both roots, newest first.
  assert.equal(ctx.workspace.recents[0], path.resolve(sibling))

  await rm(sibling, { recursive: true, force: true })
  console.log('test-approval: all checks passed')
} finally {
  await host.dispose()
  await rm(scratch, { recursive: true, force: true })
}

// ------------------------------------------------------------ default mode
{
  const fresh = await createHost({
    llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub' },
    metrics: { persist: '', load: false },
    sessions: { dir: '', load: false },
  })
  try {
    assert.equal(fresh.ctx.approvals.mode, 'risky', 'new installs gate risky tools by default')
  } finally {
    await fresh.dispose()
  }
}
