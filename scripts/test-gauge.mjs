/**
 * Context gauge tests — prompt tokens vs model context window, rendered as a
 * compact status-bar segment. Loads the real source from web/gauge.js.
 *
 *   node scripts/test-gauge.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const src = await readFile(new URL('../web/gauge.js', import.meta.url), 'utf8').catch(() => '')
assert.ok(src.trim(), 'web/gauge.js should exist and be non-empty')
const factory = new Function(`${src}\n;return formatContextGauge`)
const formatContextGauge = factory()
assert.equal(typeof formatContextGauge, 'function', 'web/gauge.js should define formatContextGauge')

// Usage + window -> "used / window · pct%".
assert.equal(formatContextGauge(120, 128_000), '120 / 128,000 · 0%')
assert.equal(formatContextGauge(64_000, 128_000), '64,000 / 128,000 · 50%')
assert.equal(formatContextGauge(1_920, 128_000), '1,920 / 128,000 · 2%')
assert.equal(formatContextGauge(128_000, 128_000), '128,000 / 128,000 · 100%')

// No window or no usage yet -> hide the segment.
assert.equal(formatContextGauge(0, 0), '')
assert.equal(formatContextGauge(null, undefined), '')
assert.equal(formatContextGauge(500, 0), '')
assert.equal(formatContextGauge(undefined, 128_000), '')

console.log('gauge: OK')
