// Claude in Chrome parity: trusted clicks and screenshots through the DevTools Protocol,
// Protected authorization clicks and downloads, tab groups, and approval notifications.
// Runs background.js in a VM with a Chrome API mock (no browser needed).
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const event = () => ({ addListener() {}, removeListener() {} });
const local = { permissionMode: 'auto_safe' };
const temporary = {};
const hostGrants = new Set(['http://127.0.0.1/*']);
const tab = { id: 4, windowId: 1, url: 'http://127.0.0.1:7777/', title: 'Test', active: true, groupId: -1 };
const log = { debugger: [], captures: 0, groups: [], notifications: [] };
let clickPoint = { x: 10, y: 20 };
let label = '';
let downloadListeners = [];

const chrome = {
  storage: {
    local: {
      async get(keys) { return Object.fromEntries([].concat(keys).map(k => [k, local[k]])); },
      async set(values) { Object.assign(local, values); }
    },
    session: {
      async get(keys) { return Object.fromEntries([].concat(keys).map(k => [k, temporary[k]])); },
      async set(values) { Object.assign(temporary, values); }
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
    async query() { return [tab]; },
    async get() { return tab; },
    async create({ url }) { const t = { id: 9, url }; return t; },
    async group({ tabIds, groupId }) { log.groups.push({ tabIds, groupId }); return groupId ?? 1; },
    onUpdated: event(), onActivated: event(), onRemoved: event()
  },
  tabGroups: {
    async get(id) { if (id !== 1) throw new Error('no group'); return { id }; },
    async update(id, props) { log.groups.push({ update: id, ...props }); return { id }; }
  },
  scripting: {
    async executeScript({ func, args }) {
      const src = func.toString();
      if (args?.[0] === 'click') {
        const result = { point: clickPoint, clicked: args[1] };
        for (const cb of downloadListeners) cb({ filename: 'report.pdf', url: 'https://example.com/report.pdf' });
        return [{ result }];
      }
      if (src.includes('getAttribute')) return [{ result: label }];
      if (src.includes('querySelector') && !src.includes('getBoundingClientRect')) return [{ result: 'Clicks: 1' }];
      return [{ result: { ok: true } }];
    }
  },
  debugger: {
    async attach(target, version) { log.debugger.push(['attach', version]); },
    async detach() { log.debugger.push(['detach']); },
    async sendCommand(target, method, params) {
      log.debugger.push([method, params]);
      if (method === 'Page.captureScreenshot') return { data: 'AAAA' };
      return {};
    }
  },
  downloads: {
    onCreated: { addListener(cb) { downloadListeners.push(cb); }, removeListener(cb) { downloadListeners = downloadListeners.filter(x => x !== cb); } }
  },
  tabs_captureVisibleTab: null,
  notifications: { create(id, opts) { log.notifications.push({ id, ...opts }); } },
  action: { onClicked: event(), async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  runtime: { id: 'a'.repeat(32), onStartup: event(), onInstalled: event(), onMessage: event() },
  windows: { onFocusChanged: event() },
  alarms: { onAlarm: event(), async create() {} },
  sidePanel: { async open() {} }
};
chrome.tabs.captureVisibleTab = async () => { log.captures++; return 'data:image/jpeg;base64,BBBB'; };

const ctx = vm.createContext({
  chrome, URL, Date, Promise, WebSocket: { OPEN: 1 },
  setTimeout, clearTimeout, setInterval, clearInterval, console,
  fetch: async () => ({ ok: true })
});
vm.runInContext(readFileSync('browser-extension/background.js', 'utf8'), ctx);
const run = expr => vm.runInContext(expr, ctx);
const wait = () => new Promise(r => setTimeout(r, 35));

// 1. Trusted click: attach, three mouse events at the element center, detach.
{
  const r = await run("handleToolExecution('browser_click', { selector: '#go' })");
  assert.equal(r.ok, true);
  assert.deepEqual(log.debugger.map(e => e[0]), ['attach', 'Emulation.setFocusEmulationEnabled', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'detach']);
  const pressed = log.debugger.find(e => e[0] === 'Input.dispatchMouseEvent' && e[1].type === 'mousePressed');
  assert.deepEqual([pressed[1].x, pressed[1].y], [10, 20], 'click lands on the element center');
  assert.equal(r.result.point, undefined, 'point is internal and not returned to the agent');
  assert.equal(r.result.text, undefined, 'click result does not persist page or input values');
  console.log('PASS trusted click goes through CDP Input events and detaches');
}

// 2. Screenshot through CDP without the user-gesture capture path.
{
  log.debugger.length = 0;
  const r = await run("handleToolExecution('browser_screenshot', {})");
  assert.equal(r.dataUrl, 'data:image/jpeg;base64,AAAA');
  assert.equal(log.captures, 0, 'captureVisibleTab (gesture-bound) is not used');
  assert.ok(log.debugger.some(e => e[0] === 'Page.captureScreenshot'));
  console.log('PASS screenshot uses Page.captureScreenshot, no user gesture needed');
}

// 3. Site permission is not requested again for an action on an allowed site.
{
  label = 'Allow access to your account';
  log.debugger.length = 0;
  const r = await run("handleToolExecution('browser_click', { selector: '#consent' })");
  assert.equal(r.ok, true);
  assert.equal(run('pendingSiteRequests.size'), 0, 'no second site permission request for an allowed site');
  assert.ok(log.debugger.some(e => e[0] === 'Input.dispatchMouseEvent'));
  label = '';
  console.log('PASS allowed site does not trigger duplicate site permission for authorization click');
}

// 4. Download reports the file Chrome started; action approval is handled by Switchboard.
{
  log.debugger.length = 0;
  const r = await run("handleToolExecution('browser_download', { selector: '#dl' })");
  assert.equal(r.filename, 'report.pdf');
  assert.equal(run('pendingSiteRequests.size'), 0, 'download action does not trigger a duplicate site prompt');
  assert.equal(downloadListeners.length, 0, 'download listener cleaned up');
  console.log('PASS download reports the started file without another site prompt');
}

// 5. Tab creation groups the new tab under "Switchboard".
{
  hostGrants.add('https://example.org/*');
  log.groups.length = 0;
  const r = await run("handleToolExecution('browser_tab_create', { url: 'https://example.org/' })");
  assert.equal(r.ok, true);
  assert.ok(log.groups.some(g => g.update !== undefined && g.title === 'Switchboard'), 'new group titled Switchboard');
  console.log('PASS tab creation joins the "Switchboard" tab group');
}

// 6. Approval request raises a notification.
{
  const pending = run("handleToolExecution('browser_navigate', { url: 'https://new.example/' })");
  await wait();
  assert.ok(log.notifications.some(n => /new\.example/.test(n.message)), 'notification names the site');
  await run("settleSiteAccess('https://new.example', false)");
  await pending.catch(() => {});
  console.log('PASS site approval request raises a notification');
}

console.log('=== Browser CDP / parity contract PASSED ===');
