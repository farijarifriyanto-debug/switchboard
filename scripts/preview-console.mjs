/** Local UI preview: no API keys, external providers, or persistent user data.
 * npm run build && node scripts/preview-console.mjs
 * Responses are fixtures; this is a visual demo, not a working AI provider.
 */
import http from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'

const workspace = await mkdtemp(path.join(tmpdir(), 'sbx-console-demo-'))
await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'welcome-project', version: '1.0.0' }))
await writeFile(path.join(workspace, 'README.md'), '# Welcome project\n\nAn isolated workspace for the Switchboard console preview.\n')
const provider = http.createServer(async (req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'Demo model (no API calls)', context_length: 128000 }] }))
  }
  for await (const _ of req) { /* Drain request; never record prompts or headers. */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const answer = '## A clearer next step\n\nThis is a **local interface demo** with a simulated response. No AI provider was called.\n\n1. Choose a project to work in.\n2. Connect your preferred model using the setup guide.\n3. Describe what you want to accomplish.\n\nYour project files have not been changed.'
  for (const content of answer.match(/.{1,24}/gs)) {
    if (res.destroyed) return
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 125, completion_tokens: 70, total_tokens: 195 } })}\n\n`)
  res.end('data: [DONE]\n\n')
})
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
let host
try {
  host = await createHost({
    llm: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: '', defaultModel: 'Demo model (no API calls)', retries: 0, contextCatalogUrl: '' },
    workspace: { root: workspace, remember: false },
    sessions: { dir: '', load: false },
    metrics: { persist: '', load: false },
    trace: { dir: '' },
    tools: { shell: { disabled: true } },
    web: { enabled: true, port: 0 },
  })
} catch (error) {
  provider.close()
  await rm(workspace, { recursive: true, force: true })
  throw error
}
console.log(`Switchboard UI demo: ${(await host.ctx.web.ready()).url}`)
console.log('Fixture responses only. No credentials or paid API calls. Ctrl+C to close.')
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await host.dispose()
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
  await rm(workspace, { recursive: true, force: true })
}
process.once('SIGINT', () => void stop().then(() => process.exit(0)))
process.once('SIGTERM', () => void stop().then(() => process.exit(0)))
// Also allows a pipe-based test runner to request graceful cleanup.
process.stdin.on('data', data => { if (data.toString().trim() === 'stop') void stop().then(() => process.exit(0)) })
