import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const event = () => ({ addListener() {} });
const local = { approvedOrigins: ['http://127.0.0.1:7777'], permissionMode: 'auto_safe' };
const temporary = {};
const tab = { id: 4, url: 'http://127.0.0.1:7777/', title: 'Test', active: true };
let mockResult = null;
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
  permissions: { async contains() { return true; } },
  tabs: { async query() { return [tab]; }, async get() { return tab; }, onUpdated: event(), onActivated: event() },
  scripting: { async executeScript() { return [{ result: mockResult }]; } },
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
const call = () => vm.runInContext("handleToolExecution('browser_type',{selector:'#name',value:'test'})",ctx);
// browser_type is a protected action: it always asks, so the test approves the one prompt.
const callApproved = async () => {
  const pending = call();
  await new Promise(r => setTimeout(r, 35));
  await vm.runInContext("settleSiteAccess('http://127.0.0.1:7777', true, true)", ctx);
  return pending;
};

mockResult = null;
await assert.rejects(callApproved(), /Browser action did not complete/i);
console.log('PASS missing injected script result fails closed');
assert.equal(local.auditLog?.at(0)?.status, 'error');

mockResult = { ok: false, error: 'Security violation: interaction with sensitive credential or payment fields is blocked.' };
await assert.rejects(callApproved(), /Security violation/);
assert.equal(local.auditLog?.at(0)?.status, 'error');
console.log('PASS sensitive-field rejection reaches the agent and records an error');

mockResult = { typedLength: 4, selector: '#name' };
const ok = await callApproved();
assert.equal(ok.ok,true);
assert.equal(ok.result.typedLength,4);
assert.equal(local.auditLog?.at(0)?.status,'success');
console.log('PASS genuine browser input execution still succeeds');
console.log('PASS browser-action-fail-closed regression');
