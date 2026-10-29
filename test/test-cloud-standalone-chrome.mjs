// Visible Chrome acceptance for extension-only BotConnector Cloud with NO sbx web.
// The fixed HTTPS gateway is intercepted with a deterministic response; this
// tests real browser DOM tool execution, UI, storage and no backend dependency,
// not a real paid cloud inference.
import assert from 'node:assert/strict'
import http from 'node:http'
import {spawn} from 'node:child_process'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import net from 'node:net'
const chromeBin=process.env.SBX_TEST_CHROME_PATH
if(!chromeBin)throw Error('Set SBX_TEST_CHROME_PATH')
const profile=await mkdtemp(path.join(tmpdir(),'sbx-cloud-standalone-'))
const fixture=http.createServer((req,res)=>{
  res.writeHead(200,{'content-type':'text/html'})
  res.end('<!doctype html><title>QA_SCREEN</title><h1>QA_SCREEN</h1><p>Browser source says qa_731</p><button id="qa-click" onclick="this.dataset.count=Number(this.dataset.count||0)+1">Click test</button>')
})
await new Promise(r=>fixture.listen(0,'127.0.0.1',r))
const url='http://127.0.0.1:'+fixture.address().port+'/'
const portServer=net.createServer()
await new Promise(r=>portServer.listen(0,'127.0.0.1',r))
const port=portServer.address().port
await new Promise(r=>portServer.close(r))
const dir=path.resolve('browser-extension')
const chrome=spawn(chromeBin,[
  '--no-first-run','--no-default-browser-check','--disable-gpu',
  '--remote-allow-origins=*','--remote-debugging-port='+port,
  '--user-data-dir='+profile,'--load-extension='+dir,'--disable-extensions-except='+dir,url
],{stdio:'ignore'})
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
let ws
try{
  let version
  for(let i=0;i<70;i++){try{const r=await fetch('http://127.0.0.1:'+port+'/json/version');if(r.ok){version=await r.json();break}}catch{} await sleep(200)}
  assert.ok(version,'Chrome starts')
  ws=new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
  const pending=new Map();let seq=0,dialogCount=0
  ws.onmessage=e=>{
    const m=JSON.parse(e.data)
    if(m.method==='Page.javascriptDialogOpening'){
      dialogCount++
      const id=++seq
      ws.send(JSON.stringify({id,method:'Page.handleJavaScriptDialog',params:{accept:true},sessionId:m.sessionId}))
      return
    }
    const call=pending.get(m.id);if(!call)return
    pending.delete(m.id);m.error?call.reject(Error(m.error.message)):call.resolve(m.result)
  }
  const cdp=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const id=++seq;pending.set(id,{resolve,reject})
    ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))
  })
  let worker,sw
  for(let i=0;i<55&&!worker;i++){
    const targets=(await cdp('Target.getTargets')).targetInfos.filter(t=>t.type==='service_worker' && t.url.endsWith('/background.js'))
    for(const t of targets){
      const session=(await cdp('Target.attachToTarget',{targetId:t.targetId,flatten:true})).sessionId
      await cdp('Runtime.enable',{},session)
      const probe=await cdp('Runtime.evaluate',{expression:'chrome.runtime?.getManifest?.().name',returnByValue:true},session)
      if(probe.result?.value==='Switchboard Browser Companion'){worker=t;sw=session;break}
      await cdp('Target.detachFromTarget',{sessionId:session}).catch(()=>{})
    }
    if(!worker)await sleep(200)
  }
  assert.ok(worker,'real extension worker')
  const run=async (expr,session=sw)=>{
    const r=await cdp('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true},session)
    if(r.exceptionDetails)throw Error('Chrome runtime: '+r.exceptionDetails.text)
    return r.result?.value
  }
  if(!(await run('chrome.tabs.query({}).then(x=>x.length)')))
    await run('chrome.tabs.create({url:'+JSON.stringify(url)+'})')
  let tab
  for(let i=0;i<60;i++){
    const tabs=await run('chrome.tabs.query({}).then(x=>x.map(t=>({id:t.id,url:t.url})))')
    tab=tabs.find(t=>t.url===url)
    if(tab)break
    if(tabs[0]&&i===0)await run('chrome.tabs.update('+tabs[0].id+',{url:'+JSON.stringify(url)+'})')
    await sleep(150)
  }
  assert.ok(tab,'fixture tab')
  await run('bindAgentTab('+tab.id+')')
  assert.equal((await run('bridgeStatus()')).connected,false,'No local sbx pairing/socket')
  const extId=worker.url.split('/')[2]
  const target=await cdp('Target.createTarget',{url:'chrome-extension://'+extId+'/panel.html'})
  const session=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId
  await cdp('Runtime.enable',{},session)
  await cdp('Page.enable',{},session)
  let ready=false
  for(let i=0;i<65;i++){
    ready=await run("document.readyState==='complete' && typeof SwitchboardCloud==='object' && !!document.getElementById('byok-form')",session).catch(()=>false)
    if(ready)break
    await sleep(150)
  }
  assert.ok(ready,'real side panel cloud agent loaded')
  const live=process.env.SBX_CLOUD_LIVE==='1'
  const testKey=live ? process.env.BOTCONNECTOR_API_KEY : 'qa-extension-only-key-no-network'
  if(!testKey)throw Error('SBX_CLOUD_LIVE requires BOTCONNECTOR_API_KEY')
  if(!live)await run(`(()=>{
    const orig=window.fetch.bind(window);
    window.fetch=(url,options)=>{
      if(String(url)==='https://api.botconnector.id/v1/models'){
        if(options.headers.authorization!=='Bearer qa-extension-only-key-no-network')throw Error('Wrong catalog auth');
        return Promise.resolve({ok:true,json:async()=>({data:[
          {id:'agnes-3.0-flash',botconnector_name:'Agnes 3.0 Flash',botconnector_access:'free',
            botconnector_family:'Agnes',botconnector_capabilities:{tools:'supported'},
            botconnector_funding:{available_now:true}},
          {id:'claude-sonnet-5-5',botconnector_name:'Claude Sonnet 5.5',botconnector_access:'plan',
            botconnector_family:'Anthropic',botconnector_capabilities:{tools:'supported'},
            botconnector_funding:{available_now:true}},
          {id:'no-tools',botconnector_name:'Unsupported',botconnector_access:'plan',
            botconnector_capabilities:{tools:'unknown'}}
        ]})});
      }
      return orig(url,options);
    };return true})()`,session)
  await run("(()=>{document.getElementById('byok-provider').value='botconnector';"+
    "document.getElementById('byok-key').value="+JSON.stringify(testKey)+";"+
    "document.getElementById('byok-form').requestSubmit();return true})()",session)
  let stored=false
  for(let i=0;i<50;i++){
    stored=await run("Boolean(cloudConfig?.enabled && document.getElementById('byok-key').value==='')",session).catch(()=>false)
    if(stored)break
    await sleep(120)
  }
  assert.ok(stored,'Key saved directly by the extension without sbx web')
  assert.equal((await run("chrome.storage.local.get('cloudConfig').then(x=>x.cloudConfig.model)",session)),'agnes-3.0-flash')
  const options=await run("Array.from(document.getElementById('byok-model').options).map(o=>({id:o.value,text:o.textContent}))",session)
  assert.ok(options.some(o=>o.id==='agnes-3.0-flash'), 'Verified free model is in dropdown')
  assert.ok(options.every(o=>o.id!=='no-tools'), 'Unknown-tools model is excluded')
  if(!live) {
    await run("(()=>{document.getElementById('byok-model-search').value='Sonnet';document.getElementById('byok-model-search').dispatchEvent(new Event('input'));return true})()",session)
    assert.deepEqual(await run("Array.from(document.getElementById('byok-model').options).map(o=>o.value)",session),['claude-sonnet-5-5'])
    await run("(()=>{document.getElementById('byok-model-search').value='';document.getElementById('byok-model-search').dispatchEvent(new Event('input'));return true})()",session)
    await run("(()=>{const s=document.getElementById('cloud-quick-model');s.value='claude-sonnet-5-5';s.dispatchEvent(new Event('change'));return true})()",session)
    for(let i=0;i<25;i++){
      const picked=await run("chrome.storage.local.get('cloudConfig').then(x=>x.cloudConfig.model)",session)
      if(picked==='claude-sonnet-5-5')break
      await sleep(100)
    }
    assert.equal(await run("chrome.storage.local.get('cloudConfig').then(x=>x.cloudConfig.model)",session),'claude-sonnet-5-5','Quick-switch persists without reentering API key')
    await run("(()=>{const s=document.getElementById('cloud-quick-model');s.value='agnes-3.0-flash';s.dispatchEvent(new Event('change'));return true})()",session)
    for(let i=0;i<25;i++){
      if((await run("chrome.storage.local.get('cloudConfig').then(x=>x.cloudConfig.model)",session))==='agnes-3.0-flash')break
      await sleep(100)
    }
    assert.equal(await run("chrome.storage.local.get('cloudConfig').then(x=>x.cloudConfig.model)",session),'agnes-3.0-flash')
    console.log('PASS searchable Cloud model dropdown and composer quick-switch with no key re-entry')
  }
  const mock=`(()=>{
    let n=0;
    const original=window.fetch.bind(window);
    window.__cloudProof={calls:0,usedRealSnapshot:false,backendCalls:0};
    window.fetch=async (target,options)=>{
      const u=String(target);
      if(u.includes('127.0.0.1:7777')||u.includes('127.0.0.1:7778')){window.__cloudProof.backendCalls++;throw Error('Backend prohibited')}
      if(u!=='https://api.botconnector.id/v1/chat/completions')return original(target,options);
      const payload=JSON.parse(options.body);
      if(payload.model!=='agnes-3.0-flash')throw Error('Wrong model');
      window.__cloudProof.calls++;
      if(++n===1)return {ok:true,json:async()=>({choices:[{message:{content:null,tool_calls:[{
        id:'qa_snapshot',type:'function',function:{name:'browser_dom_snapshot',arguments:'{}'}
      }]}}]})};
      const last=payload.messages.at(-1);
      if(last.role!=='tool'||!last.content.includes('QA_SCREEN'))throw Error('No real Chrome DOM evidence');
      window.__cloudProof.usedRealSnapshot=true;
      return {ok:true,json:async()=>({choices:[{message:{content:'Ringkasan terverifikasi: QA_SCREEN qa_731'}}]})};
    };return true})()`
  if(!live)await run(mock,session)
  await run("(()=>{document.getElementById('task-prompt').value='Baca halaman yang sedang terbuka dan sebutkan kode unik yang tertulis di sana, jangan menebak';"+
    "document.getElementById('task-form').requestSubmit();return true})()",session)
  let done=false
  for(let i=0;i<(live?260:120);i++){
    done=await run("Boolean(!activeTask && document.getElementById('chat-log').textContent.includes('qa_731'))",session).catch(()=>false)
    if(done)break
    await sleep(live?250:120)
  }
  const status=await run("document.getElementById('task-status').textContent",session)
  if(!done) {
    const diagnostic=await run("(()=>({busy:Boolean(activeTask),catalog:cloudModelCatalog.length,model:cloudConfig?.model,chat:document.getElementById('chat-log').textContent.slice(-380),status:document.getElementById('byok-status').textContent.slice(0,180)}))()",session)
    // No API keys printed. Fixture only; do not dump secrets or request headers.
    console.log('QA_DIAGNOSIS '+JSON.stringify(diagnostic))
  }
  assert.ok(done,'standalone task must read actual DOM and answer from browser evidence; status '+status)
  if(live){
    const toolEvidence=await run("document.getElementById('chat-log').querySelectorAll('.step.done').length",session)
    assert.ok(toolEvidence>=1,'Real provider must use at least one browser tool')
    console.log('PASS REAL CLOUD standalone E2E: actual BotConnector gateway + Chrome DOM tool + qa_731; no sbx web')
  }else{
    const proof=await run('window.__cloudProof',session)
    assert.equal(proof.backendCalls,0,'No localhost backend traffic from cloud agent')
    assert.equal(proof.calls,2,'Two cloud completion calls')
    assert.equal(proof.usedRealSnapshot,true,'AI completion receives actual Chrome DOM snapshot')
    console.log('PASS REAL CHROME standalone: saved key, direct HTTPS agent, real DOM snapshot, final answer; NO sbx web')
    // Simulate a one-time explicit user approval and prove a real Chrome click
    // happens exactly once through the existing background browser executor.
    const clickMock = `(()=>{
      let n=0;
      window.fetch=async (target,options)=>{
        if(String(target)!=='https://api.botconnector.id/v1/chat/completions')throw Error('Unexpected local/backend fetch');
        const data=JSON.parse(options.body);
        if(++n===1)return {ok:true,json:async()=>({choices:[{message:{content:null,tool_calls:[{
          id:'qa_click_tool',type:'function',function:{name:'browser_click',arguments:'{"selector":"#qa-click"}'}
        }]}}]})};
        if(!data.messages.at(-1).content.includes('"ok":true'))throw Error('Click not confirmed');
        return {ok:true,json:async()=>({choices:[{message:{content:'Klik QA berhasil'}}]})};
      };
      return true
    })()`
    await run(clickMock,session)
    await run("(()=>{document.getElementById('task-prompt').value='Klik tombol test';"+
      "document.getElementById('task-form').requestSubmit();return true})()",session)
    let clicked=false
    for(let i=0;i<100;i++){
      clicked=await run("Boolean(!activeTask && document.getElementById('chat-log').textContent.includes('Klik QA berhasil'))",session).catch(()=>false)
      if(clicked)break
      await sleep(120)
    }
    assert.ok(clicked,'Cloud agent completed a user-approved click')
    assert.equal(dialogCount,1,'Real Chrome displayed one native confirmation dialog before clicking')
    const clickCount=await run("chrome.scripting.executeScript({target:{tabId:"+tab.id+"},func:()=>Number(document.querySelector('#qa-click').dataset.count||0)}).then(x=>x[0].result)",sw)
    assert.equal(clickCount,1,'Real browser click exactly once')
    console.log('PASS REAL CHROME cloud action: approved visible-label click, real DOM count=1, no local backend')
  }
  // Cloud can be disabled and re-enabled without deleting/re-entering the key.
  await run("(()=>{document.getElementById('byok-default').checked=false;document.getElementById('byok-form').requestSubmit();return true})()",session)
  for(let i=0;i<30;i++){
    if(await run("cloudConfig?.enabled===false",session))break
    await sleep(100)
  }
  assert.equal(await run("chrome.storage.local.get('cloudConfig').then(x=>x.cloudConfig.enabled)",session),false,'Cloud disabled with key retained')
  assert.equal(await run("chrome.storage.local.get('cloudConfig').then(x=>x.cloudConfig.apiKey.length)",session),testKey.length)
  await run("(()=>{document.getElementById('byok-default').checked=true;document.getElementById('byok-form').requestSubmit();return true})()",session)
  for(let i=0;i<30;i++){
    if(await run("cloudConfig?.enabled===true",session))break
    await sleep(100)
  }
  assert.equal(await run("chrome.storage.local.get('cloudConfig').then(x=>x.cloudConfig.enabled)",session),true)
  console.log('PASS Cloud toggle retains key without requiring re-entry')
  // Key revocation must clear extension-local credentials; no local CLI needed.
  await run("document.getElementById('cloud-remove-key').click()",session)
  let cleared=false
  for(let i=0;i<40;i++){
    cleared=await run("chrome.storage.local.get('cloudConfig').then(x=>!x.cloudConfig)",session).catch(()=>false)
    if(cleared)break
    await sleep(100)
  }
  assert.ok(cleared,'Cloud API key is removed from extension local storage')
  console.log('PASS Chrome Cloud credential deletion directly in side panel')
}finally{
  try{ws?.close()}catch{}
  chrome.kill()
  await new Promise(r=>fixture.close(r))
  await sleep(500)
  await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:250})
}