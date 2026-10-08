/**
 * Session recall: search_sessions finds live and archived text from other
 * conversations, skips the current transcript, ranks, and read_session pages.
 *
 *   node scripts/test-recall.mjs
 */
import assert from 'node:assert/strict'
import { createHost } from '../dist/index.js'
import { matchText } from '../dist/services/recall.js'

assert.equal(matchText('Deploy the app to staging', ['deploy', 'prod']), null, 'every word must match')
assert.ok(matchText('Deploy the app to staging', ['deploy', 'staging']).score >= 2)
assert.match(matchText(`${'x '.repeat(200)}needle${' y'.repeat(200)}`, ['needle']).snippet, /^….*needle.*…$/)

const host = await createHost({
  llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub', retries: 0 },
  metrics: { persist: '', load: false },
  sessions: { dir: '' },
  settings: { dir: '' },
  approval: { mode: 'off' },
})
try {
  const { ctx } = host
  const a = ctx.sessions.create({ title: 'Billing migration' })
  ctx.sessions.append(a.id, { role: 'user', content: 'We decided to use Postgres for the billing ledger.' })
  ctx.sessions.append(a.id, { role: 'assistant', content: 'Noted: postgres, with a ledger table per tenant.' })
  const b = ctx.sessions.create({ title: 'Logo ideas' })
  ctx.sessions.append(b.id, { role: 'user', content: 'Make the logo blue.' })
  const current = ctx.sessions.create({ title: 'Now' })
  ctx.sessions.append(current.id, { role: 'user', content: 'what did we decide about postgres?' })
  // originals folded away by compaction live in the archive
  ctx.sessions.replaceMessages(current.id, [{ role: 'user', content: '[Summary of the earlier conversation]\nshort' }], [{ role: 'user', content: 'The staging password rotation happens on Fridays.' }])

  const call = (name, args, sessionId = current.id) => ctx.tools.call(name, args, { sessionId })

  const found = await call('search_sessions', { query: 'postgres ledger' })
  assert.match(found, /2 match\(es\)/)
  assert.match(found, new RegExp(`${a.id} "Billing migration" · user #0`))
  assert.ok(!found.includes(current.id), 'the current transcript does not appear')

  const live = await call('search_sessions', { query: 'what did we decide' })
  assert.match(live, /No earlier conversation mentions/, 'own live messages are skipped')
  const arch = await call('search_sessions', { query: 'password rotation' })
  assert.match(arch, new RegExp(`${current.id} "Now" · archived user #0`), 'archived originals are found')

  assert.match(await call('search_sessions', { query: 'x' }), /at least one word/)
  assert.match(await call('search_sessions', { query: 'zzzz-nothing' }), /No earlier conversation/)
  assert.match(await call('search_sessions', { query: 'logo', limit: 1 }), /1 match\(es\), showing 1/)

  // read_session pages
  for (let i = 0; i < 35; i += 1) ctx.sessions.append(b.id, { role: i % 2 ? 'assistant' : 'user', content: `line ${i}` })
  const page = await call('read_session', { id: b.id, limit: 100 })
  assert.match(page, /messages 0-29 of 36/, 'page size is capped at 30')
  assert.match(await call('read_session', { id: b.id, offset: 30 }), /messages 30-35 of 36/)
  assert.match(await call('read_session', { id: current.id, archived: true }), /archived messages 0-0 of 1:[\s\S]*#0 user: The staging password/)
  assert.match(await call('read_session', { id: 'nope' }), /no session/)
  assert.match(await call('read_session', { id: b.id, offset: 99 }), /nothing at offset 99/)
  console.log('recall: OK')
} finally {
  await host.dispose()
}
