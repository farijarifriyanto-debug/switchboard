/**
 * Store-onboarding contract: protected API, correct install states, and a
 * presentation-only content bridge. No fake market listing is published.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import vm from 'node:vm'
import { createHost } from '../dist/index.js'

const randomPort = async () => {
  const socket = net.createServer()
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve) })
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return port
}
const envKeys = ['SWITCHBOARD_CHROME_WEB_STORE_URL', 'SWITCHBOARD_EDGE_ADDONS_URL']
const original = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
process.env.SWITCHBOARD_CHROME_WEB_STORE_URL = 'https://attacker.example/extension'
process.env.SWITCHBOARD_EDGE_ADDONS_URL = 'https://microsoftedge.microsoft.com/addons/detail/switchboard-browser-companion/' + 'a'.repeat(32)
const bridgeToken = randomBytes(24).toString('hex')
const webToken = randomBytes(24).toString('hex')
const host = await createHost({
  llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub', retries: 0 },
  sessions: { dir: '', load: false },
  metrics: { persist: '', load: false },
  browser: { port: await randomPort(), host: '127.0.0.1', token: bridgeToken },
  web: { enabled: true, port: 0, token: webToken },
})
try {
  const { url } = await host.ctx.web.ready()
  const authorized = { authorization: 'Bearer ' + webToken }
  assert.equal((await fetch(url + 'api/browser-companion-setup/code')).status, 401, 'code must require Web UI auth')
  assert.equal((await fetch(url + 'api/browser-companion-setup/status')).status, 401, 'onboarding status must require Web UI auth')
  const deniedOrigin = await fetch(url + 'api/browser-companion-setup/code', {
    headers: { ...authorized, origin: 'http://malicious.example' },
  })
  assert.equal(deniedOrigin.status, 403, 'origin fence rejects another webpage')
  const stateRes = await fetch(url + 'api/state', { headers: authorized })
  assert.equal(stateRes.status, 200)
  const state = await stateRes.json()
  assert.equal(state.browserCompanion.bridgeReady, true)
  assert.equal(state.browserCompanion.connected, false)
  assert.equal(state.browserCompanion.connectedExtensionOrigin, null)
  assert.equal(state.browserCompanion.storeUrls.chrome, null, 'unverified Chrome URL not shown')
  assert.equal(state.browserCompanion.storeUrls.edge, process.env.SWITCHBOARD_EDGE_ADDONS_URL)
  assert.ok(!JSON.stringify(state.browserCompanion).includes(bridgeToken))
  assert.ok(!JSON.stringify(state.browserCompanion).includes(host.ctx.browserCompanion.pairingCode))
  const statusRes = await fetch(url + 'api/browser-companion-setup/status', { headers: authorized })
  assert.equal(statusRes.status, 200)
  assert.equal((await statusRes.json()).bridgeReady, true)
  const codeRes = await fetch(url + 'api/browser-companion-setup/code', { headers: authorized })
  assert.equal(codeRes.status, 200)
  assert.match(codeRes.headers.get('cache-control'), /no-store/)
  const oneTime = await codeRes.json()
  assert.match(oneTime.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
  assert.ok(!JSON.stringify(oneTime).includes(bridgeToken))
  console.log('PASS authenticated on-demand pairing code, code excluded from state polling')
  console.log('PASS store URL allowlist, status availability, strict cross-origin guard')
} finally {
  await host.dispose()
  for (const key of envKeys) {
    if (original[key] === undefined) delete process.env[key]
    else process.env[key] = original[key]
  }
}

// The content script exposes exactly presentation-only ping/open messages.
const content = await readFile(new URL('../browser-extension/onboarding-bridge.js', import.meta.url), 'utf8')
let handler, allowedOpenMessages = [], posts = []
const loc = { hostname: '127.0.0.1', origin: 'http://127.0.0.1:7777' }
const browserContext = {
  window: {
    addEventListener: (type, fn) => { if (type === 'message') handler = fn },
    postMessage: (data, origin) => posts.push({ data, origin }),
  },
  chrome: { runtime: { id: 'a'.repeat(32), sendMessage: async (msg) => {
    allowedOpenMessages.push(msg)
    return { ok: true }
  } } },
  location: loc,
  Date: { now: () => 123456 },
}
vm.runInNewContext(content, browserContext)
assert.equal(typeof handler, 'function')
const nonce = '0123456789abcdef01234567'
const message = (action, origin = loc.origin) =>
  handler({ source: browserContext.window, origin, data: { type: 'switchboard:companion:request', nonce, action } })
await message('ping')
assert.equal(posts.length, 1)
assert.equal(posts[0].data.status, 'installed')
assert.equal(posts[0].data.extensionId, 'a'.repeat(32))
assert.equal(posts[0].origin, loc.origin)
await message('execute_browser_tool')
await message('pair')
await message('open', 'http://malicious.example')
assert.equal(allowedOpenMessages.length, 0, 'no privileged actions permitted from page messages')
await message('open')
assert.equal(allowedOpenMessages.length, 1)
assert.equal(allowedOpenMessages[0].type, 'SWITCHBOARD_OPEN_COMPANION')
assert.equal(posts.at(-1).data.status, 'opened')
assert.doesNotMatch(JSON.stringify(posts), /token|secret|pairingCode/i)
console.log('PASS content bridge responds to local ping and opens only its own panel')
console.log('PASS content bridge never accepts page-originated browser tools or pairing')

// Store-facing package must include a proper icon, all loopback-only content scripts.
const manifest = JSON.parse(await readFile(new URL('../browser-extension/manifest.json', import.meta.url)))
assert.deepEqual(manifest.content_scripts[0].matches, ['http://127.0.0.1/*', 'http://localhost/*'])
assert.deepEqual(manifest.content_scripts[0].js, ['onboarding-bridge.js'])
assert.equal(manifest.icons['128'], 'icons/bico-128.png')
console.log('PASS installation detection restricted to loopback hosts and icon manifest ready')

// Browser UI uses null store links until the operator supplies verified store listing URLs.
const script = await readFile(new URL('../web/companion-onboarding.js', import.meta.url), 'utf8')
for (const value of ['copy pairing code', 'Not detected', 'Pairing needed', 'Connected', 'Connected elsewhere']) {
  assert.ok(script.toLowerCase().includes(value.toLowerCase()), value)
}
assert.ok(script.includes("'/api/browser-companion-setup/code'"))
assert.ok(script.includes("'switchboard:companion:request'"))
assert.ok(!script.includes('SWITCHBOARD_EXECUTE_TOOL'))
console.log('PASS Web UI three states and explicit user-click-only code retrieval')
