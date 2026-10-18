/**
 * Trace persistence must never let a caller-controlled session id escape the
 * trace directory. This is a regression test for `list(?session=...)` and for
 * every event that carries a session id.
 *
 *   node scripts/test-trace.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'

const dir = await mkdtemp(path.join(tmpdir(), 'sbx-trace-'))
const escapeName = `${path.basename(dir)}-escape.jsonl`
const outside = path.resolve(dir, '..', '..', escapeName)
await rm(outside, { force: true })

const boot = () => createHost({
  sessions: { dir: '' },
  metrics: { persist: '', load: false },
  trace: { dir, limit: 50 },
})

let host = await boot()
try {
  const { ctx } = host
  const unsafe = [
    `../../${path.basename(dir)}-escape`,
    `..\\..\\${path.basename(dir)}-escape`,
    '..',
    '.',
    's/../../escape',
    'C:\\absolute\\escape',
  ]
  for (const sessionId of unsafe) {
    ctx.trace.record({ kind: 'status', sessionId, level: 'info', summary: `bad:${sessionId}` })
    assert.deepEqual(await ctx.trace.list(sessionId), [], `no entries for unsafe key ${sessionId}`)
  }
  ctx.trace.record({ kind: 'status', sessionId: 's-valid-trace', level: 'info', summary: 'good' })
  await ctx.trace.flush()
  assert.equal(await stat(outside).then(() => true, () => false), false, 'unsafe key wrote outside the trace directory')
  assert.match(await readFile(path.join(dir, 's-valid-trace.jsonl'), 'utf8'), /good/)

  await host.dispose()
  host = await boot()
  const hydrated = await host.ctx.trace.list('s-valid-trace')
  assert.equal(hydrated.length, 1, 'valid trace still hydrates after restart')
  assert.equal(hydrated[0].summary, 'good')
  console.log('trace: OK')
} finally {
  await host.dispose()
  await rm(outside, { force: true })
  await rm(dir, { recursive: true, force: true })
}
