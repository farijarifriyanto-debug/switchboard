/**
 * Console follow-scroll: a tall block appended while the reader is at the bottom is followed;
 * a reader who scrolled up is left alone.
 *
 *   node scripts/test-scroll.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const src = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const start = src.indexOf('function atBottom()')
const end = src.indexOf('function setStatus(')
assert.ok(start > 0 && end > start, 'atBottom/scrollDown are still where the test expects them')
const make = new Function('state', 'ui', `${src.slice(start, end)}\n;return { atBottom, scrollDown }`)

const body = { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 }
const state = { pinned: true }
const { atBottom, scrollDown } = make(state, { scrollBody: body })

// reader at the bottom, then a block 300px tall is appended: still followed
body.scrollTop = 500
assert.equal(atBottom(), true)
body.scrollHeight = 1300 // the append; no scroll event fires
assert.equal(atBottom(), false, 'the old condition would now say "not at the bottom"')
scrollDown()
assert.equal(body.scrollTop, 1300, 'pinned: follows the new block')

// reader scrolled up (the scroll listener sets pinned = false): left alone
state.pinned = false
body.scrollTop = 200
body.scrollHeight = 1800
scrollDown()
assert.equal(body.scrollTop, 200, 'not pinned: the view does not jump')
scrollDown(true)
assert.equal(body.scrollTop, 1800, 'force always goes to the bottom')
console.log('scroll: OK')
