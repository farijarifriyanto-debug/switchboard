/**
 * Session store: a transcript larger than the reader's byte limit must still
 * survive a restart instead of silently disappearing (audit #3).
 *
 *   node scripts/test-session-store.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'

const dir = await mkdtemp(path.join(tmpdir(), 'sbx-session-store-'))
const host = await createHost({
  llm: { baseURL: 'http://127.0.0.1:1/v1', defaultModel: 'stub', retries: 0 },
  metrics: { persist: '', load: false },
  sessions: { dir, load: false, autosave: false, max: 5 },
  workspace: { root: dir, remember: false },
  web: { enabled: false },
})
try {
  const session = host.ctx.sessions.create({ title: 'big transcript' })
  const blob = 'x'.repeat(300_000)
  for (let i = 0; i < 34; i++) {
    session.messages.push({ role: 'user', content: `${i}:${blob}` })
    session.messages.push({ role: 'assistant', content: `answer ${i}` })
  }
  await host.ctx.sessions.checkpoint(session.id)

  const file = path.join(dir, `${session.id}.json`)
  const size = (await stat(file)).size
  assert.ok(size <= 8_000_000, `the persisted file stays under the reader limit (${size} bytes)`)

  const stored = await host.ctx.sessions.readStored(session.id)
  assert.ok(stored, 'a large session is still readable after a restart')
  assert.ok(stored.messages.length < session.messages.length, 'old turns are not part of the persisted transcript')
  assert.ok((stored.archived ?? []).length > 0, 'spilled turns stay searchable in archived')
  assert.equal(host.ctx.sessions.require(session.id).messages.length, session.messages.length, 'the live transcript is untouched')
  console.log('session store: OK')
} finally {
  await host.dispose()
  await rm(dir, { recursive: true, force: true })
}
