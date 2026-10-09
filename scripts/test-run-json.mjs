/**
 * `sbx run --json`: stdout is JSON Lines only, the last line is the result, exit code follows the run.
 *
 *   node scripts/test-run-json.mjs
 */
import http from 'node:http'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js')
const sse = (t) => [
  `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}`,
  'data: [DONE]',
  '',
].join('\n\n')

async function run(status) {
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (status !== 200) return res.writeHead(status, { 'content-type': 'application/json' }).end('{"error":{"message":"mock"}}')
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse('hello json'))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const home = await mkdtemp(path.join(tmpdir(), 'sb-runjson-'))
  const cfg = path.join(home, 'c.json')
  await writeFile(cfg, JSON.stringify({ llm: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 't', retries: 0 } }))
  const child = spawn(process.execPath, [cli, 'run', '--json', '--yes', '--no-session', '-c', cfg, 'say hi'], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, BOTCONNECTOR_API_KEY: '', OPENAI_API_KEY: '' },
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.resume()
  const code = await new Promise((r) => child.on('close', r))
  server.close()
  await rm(home, { recursive: true, force: true })
  return { code, lines: out.split('\n').filter(Boolean) }
}

{
  const { code, lines } = await run(200)
  const events = lines.map((l) => JSON.parse(l)) // throws if anything but JSON reached stdout
  assert.equal(code, 0)
  const last = events.at(-1)
  assert.equal(last.type, 'result')
  assert.equal(last.ok, true)
  assert.equal(last.text, 'hello json')
  assert.ok(typeof last.sessionId === 'string')
  assert.ok(events.some((e) => e.type === 'delta'), 'events are streamed before the result')
}
{
  const { code, lines } = await run(500)
  const events = lines.map((l) => JSON.parse(l))
  assert.equal(code, 1, 'a failed run exits 1')
  assert.equal(events.at(-1).ok, false)
  assert.ok(events.some((e) => e.type === 'error'))
}
console.log('test-run-json: all checks passed')
