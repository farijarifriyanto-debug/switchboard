import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const listeners=()=>({addListener(){}});
const local={ approvedOrigins:['http://127.0.0.1:7777'], permissionMode:'auto_safe' };
const session={};
const hostGrants=new Set(['http://127.0.0.1/*']);
let tab={id:42,url:'http://127.0.0.1:7777/',title:'Switchboard',active:true};
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
  async contains({origins}){return origins.every(p=>hostGrants.has(p));}
 },
 tabs:{
  async query(){return [tab];},
  async get(){return tab;},
  async update(id,values){ updates.push(values);tab={...tab,...values};return tab; },
  onUpdated:listeners(),onActivated:listeners()
 },
 action:{
  onClicked:listeners(),
  async setBadgeText(args){badges.push(args.text)},
  async setBadgeBackgroundColor(){},
  async setTitle(){}
 },
 scripting:{async executeScript(){return [{result:{title:'Switchboard',text:'Local test page',origin:new URL(tab.url).origin,elements:[]}}];}},
 windows:{onFocusChanged:listeners()},
 alarms:{onAlarm:listeners(),async create(){}},
 sidePanel:{async open(){}},
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

// A forged "approved" message without Chrome native permission must not resolve.
local.approvedOrigins.push('https://botconnector.id');
const premature=await run('settleSiteAccess("https://botconnector.id",true)');
assert.equal(premature.ok,false);
assert.equal(updates.length,0);
console.log('PASS storage-only approval cannot bypass Chrome permissions');

// Chrome grant and Switchboard consent together permit the original queued action.
hostGrants.add('https://botconnector.id/*');
const granted=await run('settleSiteAccess("https://botconnector.id",true)');
assert.equal(granted.ok,true);
const result=await navigate;
assert.equal(result.ok,true);
assert.equal(tab.url,'https://botconnector.id/');
assert.equal(badges.at(-1),'');
console.log('PASS explicit native Chrome + Switchboard grant resumes the exact original navigation');

// Next attempt to a new site must not inherit permission or grant all sites.
const rejected=run('handleToolExecution("browser_navigate",{url:"https://unauthorized.example/"})');
await new Promise(r=>setTimeout(r,35));
assert.equal(updates.length,1);
await run('settleSiteAccess("https://unauthorized.example",false)');
await assert.rejects(rejected,/User denied site access/);
assert.equal(updates.length,1,'denied action cannot navigate');
assert.ok(!local.approvedOrigins.includes('https://unauthorized.example'));
console.log('PASS rejection stops navigation and does not grant any other origin');

// Existing restricted mode still blocks mutating actions regardless of grants.
local.permissionMode='restricted';
await assert.rejects(run('handleToolExecution("browser_navigate",{url:"https://botconnector.id/other"})'),/Restricted/);
console.log('PASS Restricted mode remains fail-closed');
console.log('=== Browser native-permission integration contract PASSED ===');