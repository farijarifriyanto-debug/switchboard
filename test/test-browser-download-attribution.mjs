/**
 * The download tool must report the download its own approved click started,
 * not any download that happens to begin while it waits.
 *
 *   node test/test-browser-download-attribution.mjs
 */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const event = () => ({ addListener() {} })
const local = {}
const temporary = {}
const tab = { id: 4, url: 'https://shop.example/orders', title: 'Orders', active: true }
const created = []
const chrome = {
  storage: {
    local: {
      async get(keys) { return Object.fromEntries([].concat(keys).map((key) => [key, local[key]])) },
      async set(values) { Object.assign(local, values) },
    },
    session: {
      async get(keys) { return Object.fromEntries([].concat(keys).map((key) => [key, temporary[key]])) },
      async set(values) { Object.assign(temporary, values) },
    },
    onChanged: event(),
  },
  permissions: { async contains() { return true } },
  tabs: { async query() { return [tab] }, async get() { return tab }, onUpdated: event(), onActivated: event() },
  scripting: { async executeScript() { return [{ result: null }] } },
  action: { onClicked: event(), async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  runtime: { id: 'a'.repeat(32), onStartup: event(), onInstalled: event(), onMessage: event() },
  windows: { onFocusChanged: event() },
  alarms: { onAlarm: event(), async create() {} },
  sidePanel: { async open() {} },
  downloads: {
    onCreated: {
      addListener(fn) { created.push(fn) },
      removeListener(fn) { const at = created.indexOf(fn); if (at >= 0) created.splice(at, 1) },
    },
  },
}

const ctx = vm.createContext({
  chrome, URL, Date, Promise, WebSocket: { OPEN: 1 },
  setTimeout, clearTimeout, setInterval, clearInterval, console,
  fetch: async () => ({ ok: true }),
})
vm.runInContext(readFileSync('browser-extension/background.js', 'utf8'), ctx)

const matches = (item, origin) => vm.runInContext(
  `downloadMatches(${JSON.stringify(item)}, ${JSON.stringify(tab)}, ${JSON.stringify(origin)})`,
  ctx,
)
assert.equal(matches({ tabId: 4, url: 'https://shop.example/orders/invoice.pdf' }, 'https://shop.example'), true)
assert.equal(matches({ tabId: 9, url: 'https://shop.example/orders/invoice.pdf' }, 'https://shop.example'), false, 'another tab is not the approved click')
assert.equal(matches({ tabId: 4, url: 'https://cdn.evil.example/setup.exe' }, 'https://shop.example'), false, 'another origin is not the approved click')
assert.equal(matches({ tabId: 4, url: 'not a url' }, 'https://shop.example'), false, 'an unparsable url is never attributed')
assert.equal(matches({ tabId: 4, url: 'https://shop.example/orders/invoice.pdf' }, ''), false, 'a missing page origin never matches')

// A wrong download arriving first must not be reported as the click's result.
vm.runInContext('executeBrowserAction = async () => {}', ctx)
const pending = vm.runInContext("downloadViaClick({ id: 4, url: 'https://shop.example/orders' }, { selector: '#invoice' })", ctx)
await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(created.length, 1, 'the tool listens for the download it started')
created[0]({ tabId: 9, url: 'https://shop.example/orders/invoice.pdf', filename: 'invoice.pdf' })
created[0]({ tabId: 4, url: 'https://cdn.evil.example/setup.exe', filename: 'setup.exe' })
created[0]({ tabId: 4, url: 'https://shop.example/orders/invoice.pdf', filename: 'invoice.pdf' })
const result = await pending
assert.equal(result.url, 'https://shop.example/orders/invoice.pdf', 'the reported download belongs to the approved click')
assert.equal(result.filename, 'invoice.pdf')
assert.equal(local.auditLog?.at(0)?.url, 'https://shop.example/orders/invoice.pdf', 'the audit entry records the matching download')

console.log('PASS download attribution uses tab and origin')
