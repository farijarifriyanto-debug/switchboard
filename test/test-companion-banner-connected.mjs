import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
const read = (url) => readFileSync(fileURLToPath(new URL(url, import.meta.url)), 'utf8')
const js = read('../web/companion-onboarding.js')
const css = read('../web/app.css')
const E = (id) => ({ id, hidden: false, textContent: '', value: '', disabled: false,
  addEventListener() {}, removeAttribute() {}, setAttribute() {}, href: '' })
const ids = ['companion-onboarding', 'companion-onboarding-state',
  'companion-onboarding-description', 'companion-onboarding-install',
  'companion-onboarding-open', 'companion-onboarding-code',
  'companion-onboarding-code-status', 'companion-onboarding-preview', 'preset-mini']
const elements = new Map(ids.map(id => [id, E(id)]))
elements.get('preset-mini').value = 'browser'
let service = { bridgeReady: true, connected: true,
  connectedExtensionOrigin: 'chrome-extension://miehnbiiokkciokmepnhgmlhjpabbkna',
  storeUrls: {} }
let sent
let handleMessage
let tick
const origin = 'http://127.0.0.1:7777'
const window = { addEventListener(type, fn) { if (type === 'message') handleMessage = fn },
  postMessage(data) { sent = data } }
const sandbox = { window, document: { getElementById(id) { return elements.get(id) } },
  navigator: { userAgent: 'Chrome/154' }, location: { origin },
  crypto: webcrypto, setTimeout() {}, setInterval(fn) { tick = fn },
  fetch: async () => ({ ok: true, json: async () => service }) }
runInNewContext(js, sandbox)
const frame = elements.get('companion-onboarding')
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)) }
await flush()
assert.equal(frame.hidden, false, 'Banner should appear until a matching local companion is discovered')
assert.equal(sent.action, 'ping')
handleMessage({ source: window, origin, data: {
  type: 'switchboard:companion:reply', action: 'ping', nonce: sent.nonce,
  status: 'installed', extensionId: 'miehnbiiokkciokmepnhgmlhjpabbkna' } })
assert.equal(frame.hidden, true, 'Connected companion must not obstruct the chat timeline')
service = { ...service, connected: false }
tick()
await flush()
assert.equal(frame.hidden, false, 'Banner must reappear after disconnect for recovery')
assert.equal(elements.get('companion-onboarding-state').textContent, 'Pairing needed')
service = { ...service, connected: true,
  connectedExtensionOrigin: 'chrome-extension://maaiobpoekgkcgmdklepdajjoojbbjfj' }
tick()
await flush()
assert.equal(frame.hidden, false, 'Banner must remain visible when another browser owns the bridge')
assert.equal(elements.get('companion-onboarding-state').textContent, 'Connected elsewhere')
service = { ...service, connectedExtensionOrigin: 'chrome-extension://miehnbiiokkciokmepnhgmlhjpabbkna' }
tick()
await flush()
assert.equal(frame.hidden, true, 'Reconnect to the current extension should restore chat space')
elements.get('preset-mini').value = 'default'
tick()
await flush()
assert.equal(frame.hidden, true, 'Banner is browser-preset-only')
assert.match(css, /\.companion-onboarding\s*\{[^}]*background:\s*var\(--sb-alias-bg-layer-2\)/s)
assert.match(css, /\.companion-onboarding\s*\{[^}]*color:\s*var\(--sb-alias-label-primary\)/s)
console.log('COMPANION_BANNER_CONNECTED_HIDDEN_PASS')
console.log('COMPANION_BANNER_RECOVERY_VISIBLE_PASS')
console.log('COMPANION_BANNER_THEME_TOKENS_PASS')
