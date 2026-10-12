// browser_tab_close and browser_key: runs background.js in a VM with a Chrome API mock.
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const event = () => ({ addListener() {}, removeListener() {} })
const local = { permissionMode: 'auto', approvedOrigins: ['http://127.0.0.1:8999'] }
const session = {}
const hostGrants = new Set(['http://127.0.0.1/*'])
const agentTab = { id: 30, windowId: 1, groupId: 5, url: 'http://127.0.0.1:8999/form.html', title: 'Formulir Uji', active: true }
const userTab = { id: 31, windowId: 1, groupId: -1, url: 'http://127.0.0.1:8999/index.html', title: 'Tab saya', active: false }
const foreignGroupTab = { id: 32, windowId: 1, groupId: 9, url: 'http://127.0.0.1:8999/x.html', title: 'Grup lain', active: false }
const tabs = new Map([[30, agentTab], [31, userTab], [32, foreignGroupTab]])
const removed = []
const events = []
let focus = { tag: 'input', sensitive: false, editable: true }

const chrome = {
  storage: {
    local: {
      async get(keys) { return Object.fromEntries([].concat(keys).map(k => [k, local[k]])) },
      async set(values) { Object.assign(local, values) }
    },
    session: {
      async get(keys) { return Object.fromEntries([].concat(keys).map(k => [k, session[k]])) },
      async set(values) { Object.assign(session, values) }
    },
    onChanged: event()
  },
  permissions: {
    async contains({ origins }) { return origins.every(p => hostGrants.has(p)) },
    async remove() { return true },
    async getAll() { return { origins: [...hostGrants] } },
    onAdded: event(), onRemoved: event()
  },
  tabs: {
    async query(q = {}) { return q.active ? [agentTab] : [...tabs.values()] },
    async get(id) { if (!tabs.has(id)) throw new Error('No tab with id ' + id); return tabs.get(id) },
    async update(id, props) { return { ...tabs.get(id), ...props } },
    async remove(id) { removed.push(id); tabs.delete(id) },
    onUpdated: event(), onActivated: event(), onRemoved: event()
  },
  tabGroups: {
    async get(id) {
      if (id === 5) return { id, title: 'Switchboard' }
      if (id === 9) return { id, title: 'Research' }
      throw new Error('no group')
    },
    async update() { return {} }
  },
  scripting: {
    async executeScript({ func }) {
      if (func.toString().includes('activeElement')) return [{ result: focus }]
      return [{ result: { ok: true } }]
    }
  },
  debugger: {
    async attach() {}, async detach() {},
    async sendCommand(target, method, params) { events.push({ method, ...params }); return {} }
  },
  downloads: { onCreated: event() },
  notifications: { create() {} },
  action: { onClicked: event(), async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  runtime: { id: 'a'.repeat(32), onStartup: event(), onInstalled: event(), onMessage: event() },
  windows: { onFocusChanged: event() },
  alarms: { onAlarm: event(), async create() {} },
  sidePanel: { async open() {} }
}

const ctx = vm.createContext({
  chrome, URL, Date, Promise, WebSocket: { OPEN: 1 },
  setTimeout, clearTimeout, setInterval, clearInterval, console,
  fetch: async () => ({ ok: true })
})
vm.runInContext(readFileSync('browser-extension/background.js', 'utf8'), ctx)
const call = (tool, args) => vm.runInContext(`handleToolExecution(${JSON.stringify(tool)}, ${JSON.stringify(args)})`, ctx)

// ---- browser_tab_close ------------------------------------------------------
await assert.rejects(call('browser_tab_close', { tabId: 31 }), /Only tabs opened by Switchboard/, 'a user tab cannot be closed')
await assert.rejects(call('browser_tab_close', { tabId: 32 }), /Only tabs opened by Switchboard/, 'a tab in another group cannot be closed')
assert.deepEqual(removed, [], 'nothing was closed so far')
await assert.rejects(call('browser_tab_close', {}), /tabId is required/)
const closed = await call('browser_tab_close', { tabId: 30 })
assert.equal(closed.ok, true)
assert.deepEqual(removed, [30], 'the Switchboard tab was closed')
console.log('PASS browser_tab_close only closes tabs opened by Switchboard')

// Restore the agent tab for the key tests.
tabs.set(30, agentTab)
await call('browser_tab_select', { tabId: 30 })

// ---- browser_key ------------------------------------------------------------
for (const key of ['a', 'ctrl+a', 'Ctrl+V', 'F12', 'constructor', '']) {
  await assert.rejects(call('browser_key', { key }), /Unsupported key/, `"${key}" is not an allowed key`)
}
assert.equal(events.length, 0, 'unsupported keys send nothing')
console.log('PASS only named keys are accepted (no characters, shortcuts or prototype names)')

focus = { tag: 'input', sensitive: true, editable: true }
await assert.rejects(call('browser_key', { key: 'Enter' }), /sensitive credential/, 'sensitive fields are blocked')
assert.equal(events.length, 0, 'nothing is sent to a sensitive field')
console.log('PASS keys are blocked while a sensitive field has focus')

focus = { tag: 'button', sensitive: false, editable: false }
await assert.rejects(call('browser_key', { key: 'Enter' }), /Use browser_click/, 'Enter on a button must use browser_click')
await assert.rejects(call('browser_key', { key: 'Space' }), /Use browser_click/, 'Space on a button must use browser_click')
assert.equal(events.length, 0, 'no activation key reaches a button')
console.log('PASS Enter and Space on buttons and links are refused')

focus = { tag: 'input', sensitive: false, editable: true }
const enter = await call('browser_key', { key: 'Enter' })
assert.equal(JSON.stringify(enter.result), JSON.stringify({ key: 'Enter' }))
assert.deepEqual(events.map(e => [e.method, e.type]), [['Input.dispatchKeyEvent', 'keyDown'], ['Input.dispatchKeyEvent', 'keyUp']])
assert.equal(events[0].text, '\r', 'Enter carries its character')
assert.equal(events[0].windowsVirtualKeyCode, 13)
console.log('PASS Enter in a text field is sent as a trusted key event')

events.length = 0
focus = { tag: 'button', sensitive: false, editable: false }
await call('browser_key', { key: 'Tab' })
assert.deepEqual(events.map(e => e.type), ['rawKeyDown', 'keyUp'], 'Tab uses a raw key event')
events.length = 0
await call('browser_key', { key: 'Shift+Tab' })
assert.equal(events[0].modifiers, 8, 'Shift+Tab sets the shift modifier')
console.log('PASS navigation keys work from a button and Shift+Tab sets the modifier')

console.log('=== browser_tab_close and browser_key contract PASSED ===')
