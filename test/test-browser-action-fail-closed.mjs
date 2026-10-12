import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const event = () => ({ addListener() {} });
const local = { permissionMode: 'auto_safe' };
const temporary = {};
const tab = { id: 4, url: 'http://127.0.0.1:7777/', title: 'Test', active: true };
let mockResult = null;
let runInjectedScript = false;
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
  scripting: { async executeScript(details) {
    if (runInjectedScript) return [{ result: await details.func(...(details.args || [])) }];
    return [{ result: mockResult }];
  } },
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
mockResult = null;
await assert.rejects(call(), /Browser action did not complete/i);
console.log('PASS missing injected script result fails closed');
assert.equal(local.auditLog?.at(0)?.status, 'error');

mockResult = { ok: false, error: 'Security violation: interaction with sensitive credential or payment fields is blocked.' };
await assert.rejects(call(), /Security violation/);
assert.equal(local.auditLog?.at(0)?.status, 'error');
console.log('PASS sensitive-field rejection reaches the agent and records an error');

mockResult = { typedLength: 4, selector: '#name', verified: true };
const ok = await call();
assert.equal(ok.ok,true);
assert.equal(JSON.stringify(ok.result),JSON.stringify({typed:true,selector:'#name',verified:true}));
mockResult = { typedLength: 13, selector: '#name', verified: true, text: 'private@example.test', value: 'private@example.test' };
const privacy = await call();
assert.doesNotMatch(JSON.stringify(privacy), /private@example\.test/,
  'browser_type result must not persist the text that was entered');
assert.equal(privacy.result.verified, true,
  'browser_type exposes a value-free confirmation that the resulting field value matched');
assert.equal(local.auditLog?.at(0)?.status,'success');
console.log('PASS genuine browser input execution still succeeds');

const SensitiveInput = vm.runInContext(`class HTMLInputElement {
  constructor(){ this._value=''; this.id=''; this.labels=[{textContent:'CVV'}]; this.readOnly=false; this.disabled=false; this.isContentEditable=false; }
  get value(){ return this._value; } set value(value){ this._value=value; }
  getAttribute(name){ return name === 'placeholder' ? 'CVV' : null; }
  matches(){ return false; } scrollIntoView(){} dispatchEvent(){}
}; globalThis.HTMLInputElement=HTMLInputElement; class HTMLTextAreaElement {}; globalThis.HTMLTextAreaElement=HTMLTextAreaElement; class Event {}; globalThis.Event=Event; HTMLInputElement`,ctx);
const sensitiveInput = new SensitiveInput();
ctx.document = { querySelector(){ return sensitiveInput; }, getElementById(){ return null; } };
runInjectedScript = true;
await assert.rejects(call(), /sensitive credential or payment fields/i,
  'placeholder/associated-label hints must be checked again at mutation time');
runInjectedScript = false;
console.log('PASS placeholder-only sensitive field is blocked at the mutation boundary');

const normalInput = new SensitiveInput();
normalInput.id = 'name';
normalInput.name = 'name';
normalInput.type = 'text';
normalInput.labels = [];
normalInput.value = 'existing-';
normalInput.getAttribute = () => null;
normalInput.events = [];
normalInput.dispatchEvent = event => normalInput.events.push(event.type);
ctx.document = { querySelector(){ return normalInput; }, getElementById(){ return null; } };
runInjectedScript = true;
const verifiedInput = await call();
runInjectedScript = false;
assert.equal(normalInput.value, 'existing-test', 'append behavior remains unchanged');
assert.equal(verifiedInput.result.verified, true, 'the actual injected action verifies the live value without returning it');
assert.doesNotMatch(JSON.stringify(verifiedInput), /existing-test/,
  'live-value verification must not expose the resulting text');
console.log('PASS live input value is verified without exposing it');

console.log('PASS browser-action-fail-closed regression');
