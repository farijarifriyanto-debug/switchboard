/**
 * Timeout/cancel must stop the whole process tree, not just the shell wrapper.
 *
 *   node scripts/test-kill-tree.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'

if (process.platform === 'win32') {
  console.log('kill-tree: skipped on Windows (taskkill /t covers it)')
  process.exit(0)
}

const alive = async (pid) => {
  try {
    process.kill(pid, 0)
    // Container PID 1 may leave killed grandchildren as zombies. They cannot
    // execute or hold pipes; signal 0 alone does not distinguish them from live work.
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '')
      if (!stat || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false
    }
    return true
  } catch {
    return false
  }
}
const scratch = await mkdtemp(path.join(tmpdir(), 'sbx-kill-'))
const host = await createHost({
  llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub', retries: 0 },
  metrics: { persist: '', load: false },
  sessions: { dir: '', load: false },
  workspace: { root: scratch, remember: false },
  approval: { mode: 'off' },
  tools: { fs: { root: scratch }, shell: { cwd: scratch, timeoutMs: 700 } },
})
try {
  // `sh -c` wraps the node grandchild; a plain child.kill() would leave it running.
  const started = Date.now()
  const out = await host.ctx.tools.call('run_command', {
    command: `node -e "require('fs').writeFileSync('pid', String(process.pid)); setTimeout(() => {}, 60000)"; true`,
  })
  assert.ok(Date.now() - started < 10_000, `timeout returns promptly (got ${Date.now() - started}ms)`)
  assert.match(out, /timed out/, 'timeout is reported to the model')
  const pid = Number(await readFile(path.join(scratch, 'pid'), 'utf8'))
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(await alive(pid), false, 'grandchild process was killed with the shell')
  console.log('kill-tree: OK')
} finally {
  await host.dispose()
  await rm(scratch, { recursive: true, force: true })
}
