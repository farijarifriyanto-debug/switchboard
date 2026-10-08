/**
 * Real-browser smoke test for the Playwright MCP integration. NOT part of
 * `npm test` (it needs Chromium): run by the `Browser smoke` workflow, or by
 * hand after `npx playwright install chromium`.
 *
 *   node scripts/browser-smoke.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHost } from '../dist/index.js'

const VERSION = process.env.PLAYWRIGHT_MCP_VERSION || '0.0.83'
const page = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>Smoke page</title><h1>hello switchboard</h1><button>Press me</button><p id="note">untrusted page text</p>')
})
await new Promise((r) => page.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${page.address().port}/`

const host = await createHost({
  llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub', retries: 0 },
  metrics: { persist: '', load: false },
  sessions: { dir: '' },
  settings: { dir: '' },
  approval: { mode: 'off' },
  mcp: {
    servers: {
      browser: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', `@playwright/mcp@${VERSION}`, '--headless', '--isolated', '--browser', 'chromium', '--no-sandbox'],
        toolCallTimeoutMs: 120_000,
      },
    },
  },
})
try {
  await host.ctx.mcp.ready()
  const status = host.ctx.mcp.status()
  console.log('mcp status:', JSON.stringify(status))
  const tools = host.ctx.tools.list().map((t) => t.name).filter((n) => n.startsWith('mcp__browser__'))
  console.log('browser tools:', tools.join(', '))
  assert.ok(tools.length > 5, 'the browser server exposes its tools')
  const call = (name, args = {}) => host.ctx.tools.call(`mcp__browser__${name}`, args, { sessionId: 'smoke' })

  let nav = await call('browser_navigate', { url })
  if (/not installed|install/i.test(nav) && tools.includes('mcp__browser__browser_install')) {
    console.log('installing the browser via the MCP tool…')
    console.log((await call('browser_install')).slice(0, 300))
    nav = await call('browser_navigate', { url })
  }
  console.log('navigate:', nav.slice(0, 300))
  const snapshot = await call('browser_snapshot')
  console.log('snapshot:', snapshot.slice(0, 600))
  assert.match(snapshot, /hello switchboard/, 'the snapshot has the page text')
  assert.match(snapshot, /Press me/, 'the snapshot lists the button')

  // the built-in `browser` preset hides everything but the browser tools, web_search and load_skill
  const all = host.ctx.tools.list().map((t) => t.name)
  const resolved = host.ctx.presets.resolve('browser', all)
  const visible = all.filter((n) => !resolved.excludeTools.includes(n))
  assert.ok(visible.includes('mcp__browser__browser_snapshot') && !visible.includes('run_command') && !visible.includes('write_file'))
  console.log('browser-smoke: OK')
} finally {
  await host.dispose()
  page.close()
  page.closeAllConnections?.()
}
