/** Actual visible Windows Chrome Settings > Models: desktop and simulated 390px viewport. */
import assert from 'node:assert/strict'
import { createHost } from '../dist/index.js'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
const chromePath = process.env.SBX_TEST_CHROME_PATH
if (!chromePath) throw new Error('SBX_TEST_CHROME_PATH required for actual Chrome QA')
const sleep = ms => new Promise(r=>setTimeout(r,ms))
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n}
const temp = await mkdtemp(path.join(os.tmpdir(),'sbx-local-ui-resp-'))
const artifacts = path.join(temp,'evidence')
await mkdir(artifacts)
const chromePort = await freePort()
let host, chrome, ws
try {
  host=await createHost({
    llm:{baseURL:'http://127.0.0.1:65534/v1',retries:0,defaultModel:'offline-qa'},
    settings:{dir:path.join(temp,'settings')},sessions:{dir:path.join(temp,'sessions'),load:false},
    metrics:{persist:'',load:false},web:{enabled:true,host:'127.0.0.1',port:0},
    browser:{host:'127.0.0.1',port:0}
  })
  const {url}=await host.ctx.web.ready()
  chrome=spawn(chromePath,['--no-first-run','--no-default-browser-check',`--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${path.join(temp,'profile')}`,'--window-size=1365,840','--new-window',url],{stdio:'ignore'})
  let tab
  for(let i=0;i<70;i++){
    try{const list=await fetch(`http://127.0.0.1:${chromePort}/json/list`).then(r=>r.json());tab=list.find(t=>t.type==='page'&&t.url.startsWith(url));if(tab)break;}catch{}
    await sleep(200)
  }
  assert.ok(tab,'Chrome did not load Switchboard webapp')
  ws=new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
  let id=0;const waiting=new Map()
  ws.onmessage=e=>{const x=JSON.parse(e.data);if(!x.id)return;const p=waiting.get(x.id);if(!p)return;waiting.delete(x.id);x.error?p.reject(Error(x.error.message)):p.resolve(x.result)}
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;waiting.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))})
  const evalPage=async script=>{const r=await call('Runtime.evaluate',{expression:script,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails).slice(0,300));return r.result?.value}
  await call('Runtime.enable')
  for(let i=0;i<60;i++){if(await evalPage("Boolean(document.getElementById('btn-settings'))"))break;await sleep(250)}
  await evalPage("document.getElementById('btn-settings').click()")
  for(let i=0;i<35;i++){if(await evalPage("Boolean(document.getElementById('settings-dialog')?.open)"))break;await sleep(250)}
  await evalPage("document.querySelector('.settings-tab[data-settings-tab=\"models\"]').click()")
  for(const [label,w,h,mobile] of [['desktop',1365,768,false],['mobile390',390,844,true]]){
    await call('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:1,mobile})
    await sleep(450)
    const state=await evalPage(`(()=>{const p=document.querySelector('.settings-panel[data-settings-panel="models"]');const h=[...p?.querySelectorAll('h3')||[]].find(x=>x.textContent.includes('AI Lokal'));const b=h?.parentElement?.getBoundingClientRect();return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,hasLocal:Boolean(h),localBox:b?{left:b.left,right:b.right,width:b.width}:null,settingsOpen:Boolean(document.getElementById('settings-dialog')?.open)}})()`)
    assert.equal(state.width,w)
    assert.equal(state.hasLocal,true,JSON.stringify(state))
    assert.equal(state.settingsOpen,true)
    const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})
    const output=path.join(artifacts,label+'.png')
    await writeFile(output,Buffer.from(shot.data,'base64'))
    console.log('REAL_CHROME_LOCAL_UI_'+label.toUpperCase()+' '+JSON.stringify(state)+' screenshot='+output)
    assert.ok(state.scrollWidth<=w+10,'horizontal page overflow at '+label+': '+JSON.stringify(state))
  }
  console.log('LOCAL_UI_DESKTOP_390_QA_PASS')
}catch(e){console.error('LOCAL_UI_DESKTOP_390_QA_FAIL '+e.message);process.exitCode=1}
finally{
  try{ws?.close()}catch{}
  try{await host?.dispose()}catch{}
  if(chrome?.pid){try{execFileSync('taskkill',['/PID',String(chrome.pid),'/T','/F'],{stdio:'ignore'})}catch{try{chrome.kill()}catch{}}}
  // Keep screenshots to aid direct visual review; only the disposable Chrome profile is removed.
  await rm(path.join(temp,'profile'),{recursive:true,force:true,maxRetries:2,retryDelay:200}).catch(()=>{})
}
