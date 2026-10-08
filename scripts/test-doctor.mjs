/**
 * `sbx doctor` tests — diagnostics output and exit codes.
 *
 *   node scripts/test-doctor.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

function runDoctor(configPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'doctor', '-c', configPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      err += d
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

const dir = await mkdtemp(path.join(tmpdir(), 'sbx-doctor-'))
let server
try {
  // --- OK case: reachable endpoint + API key set.
  server = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model' }] }))
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const okConfig = path.join(dir, 'ok.config.jsonc')
  await writeFile(
    okConfig,
    JSON.stringify({
      llm: { baseURL: `http://127.0.0.1:${port}/v1`, defaultModel: 'stub-model' },
      metrics: { persist: '', load: false },
      sessions: { dir: path.join(dir, 'sessions'), load: false },
    }),
    'utf8',
  )
  const okEnv = { ...process.env, BOTCONNECTOR_API_KEY: 'test-key' }
  const ok = await runDoctor(okConfig, okEnv)
  assert.equal(ok.code, 0, `healthy setup should exit 0, got ${ok.code}\n${ok.out}${ok.err}`)
  assert.match(ok.out, /sbx doctor/, 'doctor should print its heading')
  assert.match(ok.out, /✓/, 'healthy checks should be marked with a check')

  // --- FAIL case: unreachable endpoint, no API key.
  const badConfig = path.join(dir, 'bad.config.jsonc')
  await writeFile(
    badConfig,
    JSON.stringify({
      llm: { baseURL: 'http://127.0.0.1:1/v1', defaultModel: 'stub-model' },
      metrics: { persist: '', load: false },
      sessions: { dir: path.join(dir, 'sessions2'), load: false },
    }),
    'utf8',
  )
  const badEnv = { ...process.env }
  delete badEnv.BOTCONNECTOR_API_KEY
  const bad = await runDoctor(badConfig, badEnv)
  assert.equal(bad.code, 1, `broken setup should exit 1, got ${bad.code}\n${bad.out}${bad.err}`)
  assert.match(bad.out + bad.err, /✗/, 'unreachable endpoint should be an error')
  assert.match(bad.out + bad.err, /BOTCONNECTOR_API_KEY/, 'missing API key should be reported')
} finally {
  if (server) await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
}

console.log('doctor: OK')
