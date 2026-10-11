import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const listeners=()=>({addListener(){}});
const local={ approvedOrigins:['http://127.0.0.1:7777'], permissionMode:'auto_safe' };
const session={};
const hostGrants=new Set(['http://127.0.0.1/*']);
let tab={id:42,url:'http://127.0.0.1:7777/',title:'Switchboard',active:true};
let toolbarHandler=null, openedPanels=0;
const updates=[], badges=[];
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
  async remove({origins}){origins.forEach(p=>hostGrants.delete(p));return true;}
 },
 tabs:{
  async query(){return [tab];},
  async get(){return tab;},
  async update(id,values){ updates.push(values);tab={...tab,...values};return tab; },
  onUpdated:listeners(),onActivated:listeners()
 },
 action:{
  onClicked:{addListener(callback){toolbarHandler=callback;}},
  async setBadgeText(args){badges.push(args.text)},
  async setBadgeBackgroundColor(){},
  async setTitle(){}
 },
 scripting:{async executeScript(){return [{result:{title:'Switchboard',text:'Local test page',origin:new URL(tab.url).origin,elements:[]}}];}},
 windows:{onFocusChanged:listeners()},
 alarms:{onAlarm:listeners(),async create(){}},
 sidePanel:{async open(){openedPanels++;}},
 runtime:{id:'a'.repeat(32),onStartup:listeners(),onInstalled:listeners(),onMessage:listeners()}
};
const context=vm.createContext({
 chrome, URL, Date, Promise, WebSocket:{OPEN:1},
 setTimeout,clearTimeout,setInterval,clearInterval,console,
 fetch:async()=>({ok:true})
});
vm.runInContext(readFileSync('browser-extension/background.js','utf8'),context);
const run=(code)=>vm.runInContext(code,context);

// Agent may list tabs before permission, without injecting page content.
const listing=await run('handleToolExecution("browser_tabs_list")');
assert.equal(listing.tabs[0].title,'Switchboard');
console.log('PASS listing tabs does not require site access');

// Request external origin, ensure it is pending and no navigation occurs.
const navigate=run('handleToolExecution("browser_navigate",{url:"https://botconnector.id/"})');
await new Promise(r=>setTimeout(r,35));
assert.equal(updates.length,0,'navigation MUST wait for user consent');
assert.equal(session.pendingSiteAccess.origin,'https://botconnector.id');
assert.equal(badges.at(-1),'!');
console.log('PASS unapproved target waits without mutating Chrome tab');

// Site approval is Switchboard's own decision; a grant without a pending request does nothing.
assert.equal((await run('settleSiteAccess("https://nothing-pending.example",true)')).ok,false);
console.log('PASS approval without a pending request does nothing');

// Approval in Switchboard is the only site decision; it persists for the site.
const granted=await run('settleSiteAccess("https://botconnector.id",true)');
assert.equal(granted.ok,true);
assert.equal(await run('siteAccessGranted("https://botconnector.id")'),true);
assert.ok(local.approvedOrigins.includes('https://botconnector.id'));
const result=await navigate;
assert.equal(result.ok,true);
assert.equal((await run('chrome.storage.session.get("captured")')).captured,undefined);
console.log('PASS Switchboard approval persists the site and resumes the waiting navigation');
// "Allow this action" grants access for that one tool call only.
{
  const pending=run('handleToolExecution("browser_navigate",{url:"https://once.example/"})');
  await new Promise(r=>setTimeout(r,35));
  await run('settleSiteAccess("https://once.example",true,true)');
  await pending;
  assert.equal(await run('siteAccessGranted("https://once.example")'),false,'one-time approval ends with the tool call');
  assert.ok(!local.approvedOrigins.includes('https://once.example'));
  console.log('PASS Allow this action grants access for one tool call only');
}
console.log('=== Browser native-permission integration contract PASSED ===');