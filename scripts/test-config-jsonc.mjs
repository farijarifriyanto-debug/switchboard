/**
 * JSONC config parser regression tests. The parser must accept every comment
 * style shown in the README's own examples (trailing `//` included) and must
 * never rewrite comment/comma lookalikes that live inside string values.
 *
 *   node scripts/test-config-jsonc.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseJsonc } from '../dist/config.js'

// Trailing line comments — the exact style used by README config examples.
{
  const parsed = parseJsonc('{"llm":{"defaultModel":"x"} // comment\n}')
  assert.equal(parsed.llm.defaultModel, 'x', 'trailing // comment after a value parses')
}
{
  const parsed = parseJsonc('{\n  // full-line comment\n  "agent": { "maxSteps": 3, /* inline block */ "temperature": 0.1 }\n}')
  assert.equal(parsed.agent.maxSteps, 3, 'full-line // comment parses')
  assert.equal(parsed.agent.temperature, 0.1, 'inline /* */ comment between fields parses')
}

// Comment markers inside string values survive untouched.
{
  const parsed = parseJsonc('{"agent":{"system":"use a /* b */ c, and https://example.com//path, } stays"}}')
  assert.equal(parsed.agent.system, 'use a /* b */ c, and https://example.com//path, } stays', 'comment lookalikes inside strings are preserved')
}

// Trailing commas are dropped; commas inside strings are not.
{
  const parsed = parseJsonc('{"a":[1,2,],"b":{"c":1,},"d":"x, }"}')
  assert.deepEqual(parsed.a, [1, 2], 'trailing comma in array dropped')
  assert.equal(parsed.b.c, 1, 'trailing comma in object dropped')
  assert.equal(parsed.d, 'x, }', 'comma+brace inside a string is preserved')
}

// Every fenced ```jsonc example in the README must parse — the docs are the contract.
{
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const blocks = [...readme.matchAll(/```jsonc\r?\n([\s\S]*?)```/g)].map((m) => m[1])
  assert.ok(blocks.length >= 5, `README carries jsonc examples (got ${blocks.length})`)
  blocks.forEach((block, i) => {
    // Whole-config blocks parse as-is. Fragment blocks ("key": value without
    // braces) parse wrapped; when a fragment is several independent lines with
    // no commas, fall back to validating each line wrapped on its own.
    const whole = block.trimStart().startsWith('{') ? block : `{${block}}`
    let parsed
    try {
      parsed = parseJsonc(whole)
    } catch {
      const lines = block.split(/\r?\n/).filter((line) => line.trim())
      lines.forEach((line, j) => {
        try {
          parsed = parseJsonc(`{${line}\n}`)
        } catch (error) {
          assert.fail(`README jsonc block #${i + 1} line ${j + 1} must parse: ${error.message}\n---\n${line.slice(0, 200)}`)
        }
      })
    }
    assert.equal(typeof parsed, 'object', `README jsonc block #${i + 1} parses to an object`)
  })
}

console.log('config-jsonc: OK')
