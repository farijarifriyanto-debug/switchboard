import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const manifest=JSON.parse(readFileSync('browser-extension/manifest.json','utf8'));
assert.ok(!manifest.host_permissions.includes('<all_urls>'),'websites must not be granted at install time');
assert.deepEqual(manifest.optional_host_permissions,['http://*/*','https://*/*']);
const panelSource=readFileSync('browser-extension/panel.js','utf8');
assert.match(panelSource,/chrome\.permissions\.request\(\{\s*origins:\s*\[sitePattern\(origin\)\]/,
  'Chrome permission request must come directly from the panel user gesture');
const modeHandler=panelSource.slice(panelSource.indexOf("$('permission-mode-select').addEventListener"),panelSource.indexOf('function sitePattern'));
assert.doesNotMatch(modeHandler,/chrome\.permissions\.(?:request|remove)/,
  'changing action mode must not grant or revoke Chrome site access');

const listeners=()=>({addListener(){}});
const local={ permissionMode:'auto_safe', approvedOrigins:['https://legacy-only.invalid'] };
const session={};
const testResults={};
const hostGrants=new Set(['http://127.0.0.1/*']);
let tab={id:42,url:'http://127.0.0.1:7777/',title:'Switchboard',active:true};
let agentTab=null;
let toolbarHandler=null, openedPanels=0, runtimeMessageHandler=null;
const updates=[], badges=[], created=[];
let pageScriptCalls=0;
const bridgeResponses=[];
const chrome={
 storage:{
  local:{
   async get(keys){return Object.fromEntries([].concat(keys).map(k=>[k,local[k]]));},
   async set(values){Object.assign(local,values);}
  },
  session:{
   async get(keys){return Object.fromEntries([].concat(keys).map(k=>[k,session[k]]));},
   async set(values){Object.assign(session,values);}
  },
  onChanged:listeners()
 },
 permissions:{
  async contains({origins}){return origins.every(p=>hostGrants.has(p));},
  async remove({origins}){origins.forEach(p=>hostGrants.delete(p));return true;},
  async getAll(){return {origins:[...hostGrants]};},
  onAdded:listeners(),onRemoved:listeners()
 },
 tabs:{
  async query(){return [tab];},
  async get(id){return id===43?agentTab:tab;},
  async update(id,values){ updates.push(values); if(id===43){agentTab={...agentTab,...values,status:'complete'};return agentTab;} tab={...tab,...values};return tab; },
  async create(options){ created.push(options); agentTab={id:43,url:options.url,title:"",active:true,status:'complete'}; return agentTab; },
  async group(){ return 7; },
  onUpdated:{addListener(){},removeListener(){}},onActivated:listeners()
 },
 action:{
  onClicked:{addListener(callback){toolbarHandler=callback;}},
  async setBadgeText(args){badges.push(args.text)},
  async setBadgeBackgroundColor(){},
  async setTitle(){}
 },
 scripting:{async executeScript(){pageScriptCalls++;return [{result:{title:'Switchboard',text:'Local test page',origin:new URL(tab.url).origin,elements:[]}}];}},
 windows:{onFocusChanged:listeners()},
 alarms:{onAlarm:listeners(),async create(){}},
 tabGroups:{async get(){throw new Error("no group");},async update(){return {};}},
 sidePanel:{async open(){openedPanels++;}},
  runtime:{id:'a'.repeat(32),onStartup:listeners(),onInstalled:listeners(),onMessage:{addListener(callback){runtimeMessageHandler=callback;}}}
};
const context=vm.createContext({
  chrome, URL, Date, Promise, WebSocket:{OPEN:1}, testResults,
  setTimeout,clearTimeout,setInterval,clearInterval,console,
  fetch:async(url,init)=>{if(String(url).endsWith('/api/browser-companion/response'))bridgeResponses.push(JSON.parse(init.body));return {ok:true};}
});
vm.runInContext(readFileSync('browser-extension/background.js','utf8'),context);
const run=(code)=>vm.runInContext(code,context);
const extensionSender={id:chrome.runtime.id,url:`chrome-extension://${chrome.runtime.id}/panel.html`};
const sendRuntimeMessage=(message,sender=extensionSender)=>new Promise(resolve=>{
  const keepChannel=runtimeMessageHandler(message,sender,resolve);
  if(keepChannel===false) resolve({ignored:true});
});

// Agent may list tabs before permission, without injecting page content.
const listing=await run('handleToolExecution("browser_tabs_list")');
assert.equal(listing.tabs[0].title,'Switchboard');
assert.equal(await run('siteAccessGranted("https://legacy-only.invalid")'),false,
  'legacy Switchboard site allowlist cannot grant Chrome access');
console.log('PASS listing tabs does not require site access');

hostGrants.delete('http://127.0.0.1/*');
const missingScreenshotGrant=run('handleToolExecution("browser_screenshot",{})');
await new Promise(r=>setTimeout(r,25));
assert.equal(await run('pendingSiteRequests.has("http://127.0.0.1:7777")'),true,
  'browser screenshot must wait for the Chrome site grant, including bridge tool execution');
await run('settleSiteAccess("http://127.0.0.1:7777",false)');
await assert.rejects(missingScreenshotGrant,/User denied site access/);
hostGrants.add('http://127.0.0.1/*');
session.agentTabId=null;
run('agentTabId=null');
console.log('PASS screenshot execution fails closed when native site access is denied');

// Manual action approval must not ask again for a Chrome site permission that already exists.
const existingPermission=run('waitForSiteAccess("http://127.0.0.1:7777","browser_type",true)');
await new Promise(r=>setTimeout(r,25));
const redundantPrompt=await run('pendingSiteRequests.has("http://127.0.0.1:7777")');
if (redundantPrompt) await run('settleSiteAccess("http://127.0.0.1:7777",false)');
await existingPermission.catch(()=>{});
assert.equal(redundantPrompt,false,'action mode must not create a second site-permission prompt');
console.log('PASS existing Chrome site grant is not gated again for a protected action');

// The authenticated CLI bridge is not a substitute for a Chrome site permission.
const bridgePermission=run('sendBridgeResult({id:"bridge-deny",tool:"browser_navigate",args:{url:"https://bridge-only.example/"}},"http://127.0.0.1:7778","test-token")');
await new Promise(r=>setTimeout(r,25));
const bridgeBypass=await run('pendingSiteRequests.has("https://bridge-only.example")');
if (bridgeBypass) await run('settleSiteAccess("https://bridge-only.example",false)');
await bridgePermission;
assert.equal(bridgeBypass,true,'CLI bridge calls must still wait for Chrome site permission');
assert.equal(bridgeResponses.at(-1).ok,false,'bridge must return a failed tool result after site access is denied');
console.log('PASS CLI bridge does not bypass the Chrome site permission');

// Request external origin, ensure it is pending and no navigation occurs.
const navigate=run('handleToolExecution("browser_navigate",{url:"https://botconnector.id/"})');
await new Promise(r=>setTimeout(r,35));
assert.equal(updates.length,0,'navigation MUST wait for user consent');
assert.equal(session.pendingSiteAccess.origin,'https://botconnector.id');
assert.equal(badges.at(-1),'!');
console.log('PASS unapproved target waits without mutating Chrome tab');

// Authorization-target labels are page data and must not be inspected before site permission.
hostGrants.delete('http://127.0.0.1/*');
pageScriptCalls=0;
const protectedClick=run('handleToolExecution("browser_click",{selector:"#authorize"})');
await new Promise(r=>setTimeout(r,25));
assert.equal(await run('pendingSiteRequests.has("http://127.0.0.1:7777")'),true);
assert.equal(pageScriptCalls,0,'unapproved site must not be read to classify an authorization click');
await run('settleSiteAccess("http://127.0.0.1:7777",false)');
await assert.rejects(protectedClick,/User denied site access/);
hostGrants.add('http://127.0.0.1/*');
console.log('PASS site permission is checked before inspecting action targets');

// Settlement must only accept a real native Chrome host grant.
assert.equal((await run('settleSiteAccess("https://nothing-pending.example",true)')).ok,false);
assert.equal((await run('settleSiteAccess("https://botconnector.id",true)')).ok,false,
  'Switchboard cannot approve a site without Chrome granting its host permission');
console.log('PASS site settlement requires the Chrome host grant');

// Simulate Chrome's permission prompt being accepted by the panel click handler.
hostGrants.add('https://botconnector.id/*');
const granted=await run('settleSiteAccess("https://botconnector.id",true)');
assert.equal(granted.ok,true);
assert.equal(await run('siteAccessGranted("https://botconnector.id")'),true);
assert.deepEqual(local.approvedOrigins,['https://legacy-only.invalid'],
  'legacy site metadata stays informational and is not mutated into authorization');
const result=await navigate;
assert.equal(result.ok,true);
assert.equal(created.length,1,"navigate without a bound tab opens its own grouped tab");
assert.equal(created[0].url,"https://botconnector.id/");
assert.equal(tab.id,42,"the user tab is not navigated");
assert.equal((await run('chrome.storage.session.get("captured")')).captured,undefined);
assert.ok(hostGrants.has('https://botconnector.id/*'),'persistent Chrome permission remains granted');
const grantsBeforeModeChanges=[...hostGrants].sort();
for (const mode of ['manual','auto','skip']) {
 local.permissionMode=mode;
 assert.equal(await run('siteAccessGranted("https://botconnector.id")'),true,
   `${mode} action mode does not change the native Chrome site grant`);
 assert.deepEqual([...hostGrants].sort(),grantsBeforeModeChanges);
}
const agentPanelTab=await sendRuntimeMessage({type:'SWITCHBOARD_ACTIVE_TAB'});
assert.equal(agentPanelTab.tab.id,43,'panel context should follow the stable agent tab, not Chrome active tab');
assert.equal(agentPanelTab.tab.url,'https://botconnector.id/');
console.log('PASS side-panel site context remains bound to the agent tab');
console.log('PASS native Chrome grant resumes navigation and remains the source of truth');
{
  testResults.firstOnceResolved=false;
  testResults.secondOnceError='';
  run(`pendingSiteRequests.set("https://once-concurrent.example",{origin:"https://once-concurrent.example",tool:"browser_click",requestedAt:Date.now(),waiting:[
    {resolve(){testResults.firstOnceResolved=true},reject(error){testResults.firstOnceError=error.message},timer:null},
    {resolve(){testResults.secondOnceResolved=true},reject(error){testResults.secondOnceError=error.message},timer:null}
  ]})`);
  hostGrants.add('https://once-concurrent.example/*');
  await run('settleSiteAccess("https://once-concurrent.example",true,true)');
  assert.equal(testResults.firstOnceResolved,true);
  assert.equal(testResults.secondOnceResolved,undefined);
  assert.match(testResults.secondOnceError,/reserved for another browser action/,
    'one native grant must resume only one of multiple waiting tool calls');
  await run('releaseOneTimeGrants()');
  assert.ok(!hostGrants.has('https://once-concurrent.example/*'));
  console.log('PASS one-action grant resumes only one concurrent waiting tool call');
}
hostGrants.add('https://once-lock.example/*');
run('oneTimeOrigins.add("https://once-lock.example")');
await assert.rejects(run('waitForSiteAccess("https://once-lock.example","browser_click")'),/in use by another browser action/,
  'a temporary native grant cannot be reused by a concurrent action');
run('oneTimeOrigins.delete("https://once-lock.example")');
hostGrants.delete('https://once-lock.example/*');
console.log('PASS one-action grant cannot be reused by a concurrent tool call');
// "Allow this action" grants access for that one tool call only.
{
  const pending=run('handleToolExecution("browser_navigate",{url:"https://once.example/"})');
  await new Promise(r=>setTimeout(r,35));
  hostGrants.add('https://once.example/*');
  await run('settleSiteAccess("https://once.example",true,true)');
  await pending;
  assert.equal(await run('siteAccessGranted("https://once.example")'),false,'one-time approval ends with the tool call');
  assert.ok(!hostGrants.has('https://once.example/*'),'temporary host permission is removed after one tool call');
  console.log('PASS Allow this action removes its native Chrome grant after one tool call');
}
{
  const pageSender={id:chrome.runtime.id,url:'http://127.0.0.1:7777/onboarding-bridge.js',tab:{id:42,url:'http://127.0.0.1:7777/'}};
  hostGrants.add('https://botconnector.id/*');
  const pageStatus=await sendRuntimeMessage({type:'SWITCHBOARD_SITE_ACCESS_STATUS',origin:'https://botconnector.id'},pageSender);
  assert.deepEqual(pageStatus,{ignored:true},'a localhost content script cannot inspect extension site grants');
  const pageRevoke=await sendRuntimeMessage({type:'SWITCHBOARD_SITE_ACCESS_REVOKE',origin:'https://botconnector.id'},pageSender);
  assert.deepEqual(pageRevoke,{ignored:true},'a localhost content script cannot revoke native site grants');
  run(`pendingSiteRequests.set("https://botconnector.id",{origin:"https://botconnector.id",tool:"browser_type",requestedAt:Date.now(),waiting:[]})`);
  const pageSettle=await sendRuntimeMessage({type:'SWITCHBOARD_SITE_APPROVAL_GRANTED',origin:'https://botconnector.id'},pageSender);
  assert.deepEqual(pageSettle,{ignored:true},'a localhost content script cannot settle the panel site grant request');
  assert.equal(await run('pendingSiteRequests.has("https://botconnector.id")'),true);
  run('pendingSiteRequests.delete("https://botconnector.id")');
  console.log('PASS localhost content scripts cannot control Chrome site permissions');
}
{
  const status=await sendRuntimeMessage({type:'SWITCHBOARD_SITE_ACCESS_STATUS',origin:'https://botconnector.id'});
  assert.equal(status.granted,true);
  assert.ok(status.origins.includes('https://botconnector.id/*'));
  const revoked=await sendRuntimeMessage({type:'SWITCHBOARD_SITE_ACCESS_REVOKE',origin:'https://botconnector.id'});
  assert.equal(revoked.removed,true);
  assert.equal(await run('siteAccessGranted("https://botconnector.id")'),false);
  console.log('PASS panel status and revoke reflect native Chrome permissions');
}
console.log('=== Browser native-permission integration contract PASSED ===');
