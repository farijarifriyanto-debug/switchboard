/**
 * The system prompt must carry a fresh "Today is …" line so the model can
 * resolve relative dates and date recent web_search queries.
 *
 *   node scripts/test-date.mjs
 */
import assert from 'node:assert/strict'
import { withDateContext } from '../dist/plugins/agent.js'

const now = new Date(2026, 9, 6, 12, 0, 0) // local time, Tue 6 Oct 2026
const out = withDateContext('base prompt', now)
assert.match(out, /^base prompt\n\nToday is Tuesday, 2026-10-06 \(/, 'date line is appended with weekday and local date')
assert.ok(out.includes('web_search'), 'the line tells the model to date recent searches')
assert.equal(withDateContext(out, new Date(2027, 0, 1)), out, 'an existing date line is never doubled')

const fresh = withDateContext('x')
const year = new Date().getFullYear()
assert.ok(fresh.includes(`Today is`), 'default uses the current clock')
assert.ok(fresh.includes(String(year)), 'default year matches today')

console.log('date: OK')
