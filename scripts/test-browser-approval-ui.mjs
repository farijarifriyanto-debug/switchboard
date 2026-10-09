/**
 * Approval presentation regression: exact browser action, site hint, selector,
 * and secret-safe input; API includes only origin without URL credentials.
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import { readFile } from 'node:fs/promises'
import { createHost } from '../dist/index.js'

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8')
const start = app.indexOf('/** Human-readable browser actions')
const end = app.indexOf('\nfunction ioSection(', start)
assert.ok(start > 0 && end > start)
const helpers = new Function('shortPath', app.slice(start, end) + '\nreturn { toolTitle, toolSummary, safeBrowserUrl, browserApprovalDetails, safeToolArguments }')((x) => x)
const { toolTitle, toolSummary, safeBrowserUrl, browserApprovalDetails, safeToolArguments } = helpers
assert.equal(toolTitle('browser_click'), 'Click browser element')
assert.equal(toolTitle('browser_type'), 'Type into browser')
assert.equal(toolTitle('read_file'), 'Read', 'other tools retain their existing names')
assert.equal(safeBrowserUrl('https://user:pw@example.org/pay?session=verysecret#key'), 'https://example.org/pay')
assert.equal(safeBrowserUrl('javascript:alert(1)'), 'Invalid website URL')
const lastReported = { connected: true, activeTab: { id: 45, origin: 'https://example.org' } }
const clicked = browserApprovalDetails('browser_click', { selector: '#increment', tabId: 45 }, lastReported)
assert.match(clicked, /Action: Click browser element \(browser_click\)/)
assert.match(clicked, /Requested tab ID: 45/)
assert.match(clicked, /Last reported active site: https:\/\/example\.org/)
assert.match(clicked, /Target selector: #increment/)
assert.ok(clicked.includes('\n'), 'rendered approval details use real line breaks')
assert.equal(clicked.includes('Working with project'), false)
const differentTab = browserApprovalDetails('browser_click', { selector: '#save', tabId: 8 }, lastReported)
assert.match(differentTab, /Active site: not verified/)
assert.doesNotMatch(differentTab, /Last reported active site: https:\/\/example.org/)
const typed = browserApprovalDetails('browser_type', { selector: '#email', text: 'supersecretpassword', clear: true, pressEnter: true }, lastReported)
assert.match(typed, /Target selector: #email/)
assert.match(typed, /Text: \[hidden; 19 characters\]/)
assert.match(typed, /Press Enter afterward: yes/)
assert.doesNotMatch(typed, /supersecretpassword/)
assert.doesNotMatch(toolSummary('browser_type', { selector: '#email', text: 'supersecretpassword' }), /supersecretpassword/)
assert.doesNotMatch(JSON.stringify(safeToolArguments('browser_type', { selector:'#email',text:'supersecretpassword' })), /supersecretpassword/)
assert.equal(safeToolArguments('browser_navigate',{url:'https://u:p@example.org/?session=SECRET'}).url,'https://example.org/')
const nav = browserApprovalDetails('browser_navigate', { url: 'https://user:pass@example.org/check?api_key=PRIVATE#secret' }, lastReported)
assert.match(nav, /Destination: https:\/\/example\.org\/check/)
assert.doesNotMatch(nav, /PRIVATE|user:pass|secret/)
assert.equal(browserApprovalDetails('write_file', {path:'a'}, lastReported), null)
assert.match(app, /ui\.approvalArgs\.textContent = humanRequest/, 'never render approval arguments as HTML')
console.log('PASS approval UI names exact browser action, selector, tab, and last-reported site')
console.log('PASS mismatched tabs do not receive a false site attribution')
console.log('PASS navigation URL, typed text and expanded tool cards protect private values')

const randomPort = async () => {
  const sock = net.createServer()
  await new Promise((resolve,reject) => { sock.once('error', reject); sock.listen(0, '127.0.0.1', resolve) })
  const port = sock.address().port
  await new Promise(resolve => sock.close(resolve))
  return port
}
const port = await randomPort()
const token = 't-' + 'a'.repeat(48)
const host = await createHost({
  llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub' },
  metrics: { persist: '', load: false },
  sessions: { dir: '', load: false },
  approval: { mode: 'risky', timeoutMs: 2000 },
  browser: { port, host: '127.0.0.1', token },
  web: { enabled: true, port: 0 },
})
try {
  const {url} = await host.ctx.web.ready()
  const status = await fetch('http://127.0.0.1:' + port + '/api/browser-companion/status', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ activeTab: {id:45, url:'https://user:pass@example.org/check?api_key=PRIVATE#secret', title: 'Safe preview'} }),
  })
  assert.equal(status.status, 200)
  const parked = host.ctx.tools.call('browser_click', { selector: '#increment', tabId:45 }, {sessionId:'ui-browser-test'})
  await new Promise(resolve => setImmediate(resolve))
  const gateResponse = await fetch(url+'api/approvals')
  assert.equal(gateResponse.status, 200, 'approval route must work with optional browser service')
  const approvals = await gateResponse.json()
  assert.equal(approvals.pending.length, 1)
  assert.equal(approvals.pending[0].tool,'browser_click')
  assert.equal(approvals.browser.activeTab.origin,'https://example.org')
  assert.equal(approvals.browser.activeTab.id,45)
  assert.ok(!JSON.stringify(approvals.browser).includes('PRIVATE'),'active tab URL queries must not leak')
  const state=await fetch(url+'api/state').then(r=>r.json())
  assert.equal(state.approval.browser.activeTab.origin,'https://example.org')
  host.ctx.approvals.decide(approvals.pending[0].id,'rejected')
  assert.match(await parked, /rejected/)
  console.log('PASS actual approval API carries origin-only context, never full URL')
  console.log('PASS original reject operation and risky approval enforcement remain active')
} finally {
  await host.dispose()
}
