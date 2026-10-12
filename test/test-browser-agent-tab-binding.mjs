// The agent keeps its own tab. When the user focuses another tab in Chrome,
// tools without an explicit tabId must still act on the agent's tab.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const event = () => ({ addListener() {}, removeListener() {} });
const local = { permissionMode: 'auto_safe', approvedOrigins: ['http://127.0.0.1:8999'] };
const session = {};
const hostGrants = new Set(['http://127.0.0.1/*']);
const agentTab = { id: 10, windowId: 1, url: 'http://127.0.0.1:8999/form.html', title: 'Formulir Uji', active: false, groupId: -1 };
const userTab = { id: 20, windowId: 1, url: 'http://127.0.0.1:8999/index.html', title: 'Uji Switchboard', active: true, groupId: -1 };
const tabs = new Map([[10, agentTab], [20, userTab]]);
const targets = [];

const chrome = {
  storage: {
    local: {
      async get(keys) { return Object.fromEntries([].concat(keys).map(k => [k, local[k]])); },
      async set(values) { Object.assign(local, values); }
    },
    session: {
      async get(keys) { return Object.fromEntries([].concat(keys).map(k => [k, session[k]])); },
      async set(values) { Object.assign(session, values); }
    },
    onChanged: event()
  },
  permissions: {
    async contains({ origins }) { return origins.every(p => hostGrants.has(p)); },
    async remove({ origins }) { origins.forEach(p => hostGrants.delete(p)); return true; },
    async getAll() { return { origins: [...hostGrants] }; },
    onAdded: event(), onRemoved: event()
  },
  tabs: {
    // The user's focused tab is the active one; the agent's tab is not.
    async query(q = {}) { return q.active ? [userTab] : [agentTab, userTab]; },
    async get(id) { return tabs.get(id) ?? { id, url: 'http://127.0.0.1:8999/', title: 'x', active: false }; },
    async update(id, props) { return { ...tabs.get(id), ...props }; },
    onUpdated: event(), onActivated: event(), onRemoved: event()
  },
  tabGroups: { async get() { throw new Error('no group'); }, async update() { return {}; } },
  scripting: {
    async executeScript({ target, func }) {
      targets.push(target.tabId);
      const src = func.toString();
      if (src.includes('getAttribute')) return [{ result: '' }];
      if (src.includes('getBoundingClientRect')) return [{ result: { point: { x: 1, y: 1 }, clicked: true, text: 'ok' } }];
      return [{ result: { title: agentTab.title, url: agentTab.url, origin: 'http://127.0.0.1:8999', elements: [], text: '' } }];
    }
  },
  debugger: { async attach() {}, async detach() {}, async sendCommand() { return {}; } },
  downloads: { onCreated: event() },
  notifications: { create() {} },
  action: { onClicked: event(), async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  runtime: { id: 'a'.repeat(32), onStartup: event(), onInstalled: event(), onMessage: event() },
  windows: { onFocusChanged: event() },
  alarms: { onAlarm: event(), async create() {} },
  sidePanel: { async open() {} }
};

const ctx = vm.createContext({
  chrome, URL, Date, Promise, WebSocket: { OPEN: 1 },
  setTimeout, clearTimeout, setInterval, clearInterval, console,
  fetch: async () => ({ ok: true })
});
vm.runInContext(readFileSync('browser-extension/background.js', 'utf8'), ctx);
const run = expr => vm.runInContext(expr, ctx);

// 1. The agent selects its tab (tab 10). Focus stays on tab 20 (the user's tab).
await run('handleToolExecution("browser_tab_select", { tabId: 10 })');

// 2. Tools without a tabId must act on the agent's tab, not the focused tab.
targets.length = 0;
for (const [tool, args] of [['browser_dom_snapshot', {}], ['browser_click', { selector: '#kirim' }], ['browser_type', { selector: '#nama', text: 'Budi' }]]) {
  try { await run(`handleToolExecution(${JSON.stringify(tool)}, ${JSON.stringify(args)})`); } catch (_) { /* result shape is not under test here */ }
}
assert.ok(targets.length > 0, 'tools reached the browser');
assert.ok(targets.every(id => id === 10), `every action targets the agent tab (10), got ${JSON.stringify(targets)}`);
console.log('PASS tools without tabId stay on the agent tab while the user focuses another tab');

// 3. An explicit tabId still wins.
targets.length = 0;
try { await run('handleToolExecution("browser_dom_snapshot", { tabId: 20 })'); } catch (_) {}
assert.ok(targets.includes(20), 'explicit tabId is honored');
console.log('PASS explicit tabId overrides the agent tab');

// 4. The tab list marks the agent tab, so the model does not guess it from titles.
const list = await run('handleToolExecution("browser_tabs_list", {})');
assert.equal(list.agentTabId, 10, 'list reports the agent tab id');
assert.equal(list.tabs.find(t => t.id === 10).agent, true, 'agent tab is marked');
assert.equal(list.tabs.find(t => t.id === 20).agent, false, 'focused tab is not the agent tab');
console.log('PASS tab list marks the agent tab');

console.log('=== Agent tab binding contract PASSED ===');
