/**
 * Undo journal for file-tool writes.
 *
 *   node scripts/test-undo.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'

const ws = await mkdtemp(path.join(tmpdir(), 'sb-undo-ws-'))
const dir = await mkdtemp(path.join(tmpdir(), 'sb-undo-dir-'))
const host = await createHost({
  workspace: { root: ws },
  tools: { fs: { root: ws } },
  undo: { dir },
  approval: { mode: 'off' },
  metrics: { persist: '', load: false },
  sessions: { dir: '', load: false },
})
const { ctx } = host
const call = (name, args, sessionId = 's1') => ctx.tools.call(name, args, { sessionId, workspace: ws })
const exists = (f) => access(f).then(() => true, () => false)
const file = (n) => path.join(ws, n)

try {
  await writeFile(file('a.txt'), 'original', 'utf8')
  await call('write_file', { path: 'a.txt', content: 'v1' })
  await call('write_file', { path: 'a.txt', content: 'v2' })
  await call('write_file', { path: 'new.txt', content: 'fresh' })
  const list = await ctx.undo.list('s1')
  assert.deepEqual(list.map((e) => [path.basename(e.file), e.created]), [['a.txt', false], ['a.txt', false], ['new.txt', true]])

  // newest first: the created file disappears, then a.txt steps back one version at a time.
  let r = await ctx.undo.undo('s1')
  assert.equal(await exists(file('new.txt')), false)
  assert.equal(r.restored.length, 1)
  r = await ctx.undo.undo('s1')
  assert.equal(await readFile(file('a.txt'), 'utf8'), 'v1')
  r = await ctx.undo.undo('s1')
  assert.equal(await readFile(file('a.txt'), 'utf8'), 'original')
  r = await ctx.undo.undo('s1')
  assert.deepEqual(r, { restored: [], skipped: [] }, 'nothing left')

  // the user edited the file after the agent: refuse unless forced.
  await call('write_file', { path: 'b.txt', content: 'agent' }, 's2')
  await writeFile(file('b.txt'), 'user edit', 'utf8')
  r = await ctx.undo.undo('s2')
  assert.equal(r.restored.length, 0)
  assert.match(r.skipped[0].reason, /edited since/)
  assert.equal(await readFile(file('b.txt'), 'utf8'), 'user edit', 'user work survives')
  await call('write_file', { path: 'b.txt', content: 'agent2' }, 's2')
  await writeFile(file('b.txt'), 'user edit 2', 'utf8')
  r = await ctx.undo.undo('s2', 1, true)
  assert.equal(r.restored.length, 1, 'force overrides')
  assert.equal(await exists(file('b.txt')), true, 'b.txt existed before the second write, so it is restored, not deleted')

  // sessions are separate; a failed write leaves no entry.
  assert.equal((await ctx.undo.list('s1')).length, 0)
  await call('write_file', { path: '../escape.txt', content: 'x' }, 's3').catch(() => {})
  assert.equal(await exists(path.join(ws, '..', 'escape.txt')), false, 'the boundary still holds')
  assert.equal((await ctx.undo.list('s3')).length, 0)
  console.log('test-undo: all checks passed')
} finally {
  await rm(ws, { recursive: true, force: true })
  await rm(dir, { recursive: true, force: true })
}
