/**
 * AGENTS.md injection tests — project + global context files appended to the
 * system prompt (convention shared with Claude Code / OpenClaw / Hermes).
 *
 *   node scripts/test-agents-md.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const mod = await import('../dist/plugins/agent.js')
assert.equal(typeof mod.withAgentsMd, 'function', 'withAgentsMd should be exported from dist/plugins/agent.js')

const dir = await mkdtemp(path.join(tmpdir(), 'sbx-agents-'))
try {
  const base = 'You are Switchboard.'
  const globalFile = path.join(dir, 'global-AGENTS.md')

  // No files: prompt unchanged.
  assert.equal(mod.withAgentsMd(base, dir, globalFile).trim(), base, 'no AGENTS.md files leaves the prompt unchanged')

  // Project file injected with a marker, base prompt stays first.
  await writeFile(path.join(dir, 'AGENTS.md'), '# Rules\nAlways answer in Indonesian.', 'utf8')
  const withProject = mod.withAgentsMd(base, dir, globalFile)
  assert.match(withProject, /Project instructions \(AGENTS\.md\)/)
  assert.match(withProject, /Always answer in Indonesian\./)
  assert.ok(withProject.startsWith(base), 'base prompt comes first')

  // Global file injected too.
  await writeFile(globalFile, 'Global rule: be terse.', 'utf8')
  const both = mod.withAgentsMd(base, dir, globalFile)
  assert.match(both, /Global instructions/)
  assert.match(both, /be terse\./)

  // Missing project dir: no throw, global still included.
  const missing = mod.withAgentsMd(base, path.join(dir, 'nope'), globalFile)
  assert.match(missing, /Global instructions/)

  // Oversized file is truncated with a marker.
  await writeFile(path.join(dir, 'AGENTS.md'), 'x'.repeat(40_000), 'utf8')
  const capped = mod.withAgentsMd(base, dir, globalFile)
  assert.ok(capped.length < base.length + 33_000, 'oversized AGENTS.md should be truncated')
  assert.match(capped, /truncated/)
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log('agents-md: OK')
