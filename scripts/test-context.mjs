/**
 * Context management checks.
 *
 *   node scripts/test-context.mjs
 */
import assert from 'node:assert/strict'
import { estimateMessages, trimMessages } from '../dist/context.js'

const m = (role, content, extra = {}) => ({ role, content, ...extra })

// 1. Under budget: untouched.
const small = [m('system', 'sys'), m('user', 'hi')]
const keep = trimMessages(small, { maxPromptTokens: 1000 })
assert.equal(keep.dropped, 0)
assert.equal(keep.messages.length, 2)

// 2. Over budget: oldest turns are dropped, system survives.
const long = [
  m('system', 'system prompt'),
  ...Array.from({ length: 20 }, (_, i) => m('user', `turn ${i} ` + 'x'.repeat(400))),
]
const trimmed = trimMessages(long, { maxPromptTokens: 500, keepRecent: 2 })
assert.ok(trimmed.dropped > 0, 'should drop something')
assert.ok(trimmed.messages[0].role === 'system', 'system message must survive')
assert.equal(trimmed.messages[1].role, 'user')
assert.ok(trimmed.estimatedTokens <= 900, `trimmed estimate too big: ${trimmed.estimatedTokens}`)
console.log(`trim: dropped=${trimmed.dropped} estimate=${trimmed.estimatedTokens}`)

// 3. Never keep an orphaned tool result as the first non-system message.
const withTools = [
  m('system', 'sys'),
  m('user', 'a'),
  m('assistant', 'b' + 'y'.repeat(600), { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] }),
  m('tool', 'result'.repeat(40), { tool_call_id: 'c1', name: 'x' }),
  m('user', 'c'),
]
const t2 = trimMessages(withTools, { maxPromptTokens: 150, keepRecent: 2 })
assert.notEqual(t2.messages[1]?.role, 'tool', 'must not start on an orphaned tool result')
console.log(`tool-orphan guard: kept=${t2.messages.map((x) => x.role).join(',')}`)

// 4. Estimator is monotonic.
assert.ok(estimateMessages(long) > estimateMessages(small))

console.log('context: OK')
