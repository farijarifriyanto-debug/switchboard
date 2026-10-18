import { createHost } from '../dist/index.js';
import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
const localModel=process.env.SBX_LOCAL_MODEL||'botconnector-fast:latest';
const localBaseURL=process.env.SBX_LOCAL_BASE_URL||'http://127.0.0.1:11666/v1';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p};
async function session(url){const ws=new WebSocket(url);await new Promise((r,e)=>{ws.onopen=r;ws.onerror=e});let id=0;const pending=new Map();ws.onmessage=e=>{let m=JSON.parse(e.data);if(pending.has(m.id)){let [r,j]=pending.get(m.id);pending.delete(m.id);m.error?j(Error(m.error.message)):r(m.result)}};return{call:(method,params={},sessionId)=>new Promise((r,j)=>{const i=++id;pending.set(i,[r,j]);ws.send(JSON.stringify({id:i,method,params,...(sessionId?{sessionId}:{})}))}),close:()=>ws.close()}};
const bridgePort=await port(),chromePort=await port(),pagePort=await port(),webPort=await port();
const profile=await mkdtemp(path.join(tmpdir(),'switchboard-chrome-worker-audit-'));
const token=randomBytes(32).toString('hex');
let host,chrome,server;
try{
 server=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<html><head><title>Switchboard Real Chrome Test</title></head><body><button id="counter" onclick="this.textContent=\'Clicks: \'+(Number(this.dataset.n||0)+1);this.dataset.n=Number(this.dataset.n||0)+1">Clicks: 0</button><h1>Chrome DOM test</h1></body></html>')});
 await new Promise(r=>server.listen(pagePort,'127.0.0.1',r));
 host=await createHost({settings:{dir:profile},llm:{baseURL:localBaseURL,apiKey:'ollama',defaultModel:localModel,retries:0,timeoutMs:120000},agent:{maxSteps:5,maxTokens:384,temperature:0},tools:{shell:{disabled:true}},sessions:{dir:'',load:false},metrics:{persist:'',load:false},approval:{mode:'risky'},browser:{port:bridgePort,host:'127.0.0.1',token,defaultMode:'auto_safe'},web:{enabled:true,port:webPort,host:'127.0.0.1',token:randomBytes(24).toString('hex')}});
 const chromeBin=process.env.SBX_TEST_CHROME_PATH; if(!chromeBin)throw Error('Set SBX_TEST_CHROME_PATH to Chrome for Testing chrome.exe');
 let extensionDir=process.env.SBX_TEST_EXTENSION_DIR;
 if(!extensionDir){
  // The panel's shipped default is the conventional web port 7777. An isolated
  // test copy points those API calls at this run's dynamic web port so a live
  // `sbx web` on 7777 cannot receive the test chat. No product source changes.
  extensionDir=path.join(profile,'extension-under-test');
  await cp(path.join(process.cwd(),'browser-extension'),extensionDir,{recursive:true});
  const panelFile=path.join(extensionDir,'panel.js');
  const panelText=await readFile(panelFile,'utf8');
  await writeFile(panelFile,panelText.replaceAll('127.0.0.1:7777',`127.0.0.1:${webPort}`),'utf8');
  console.log('REAL_PANEL_EXTENSION_COPY '+JSON.stringify({webPort,source:'browser-extension'}));
 }
 chrome=spawn(chromeBin,['--no-first-run','--no-default-browser-check','--disable-gpu','--remote-allow-origins=*',`--remote-debugging-port=${chromePort}`,`--user-data-dir=${profile}`,`--load-extension=${extensionDir}`,`--disable-extensions-except=${extensionDir}`,`http://127.0.0.1:${pagePort}/`],{stdio:'ignore'});
 let version;
 for(let i=0;i<50;i++){try{let r=await fetch(`http://127.0.0.1:${chromePort}/json/version`);if(r.ok){version=await r.json();break}}catch{}await sleep(250)}
 if(!version)throw Error('Chrome CDP unavailable');
 const browser=await session(version.webSocketDebuggerUrl);
 let worker,swSession;
 for(let attempt=0;attempt<40&&!worker;attempt++){
   const targets=(await browser.call('Target.getTargets')).targetInfos.filter(x=>x.type==='service_worker'&&x.url.startsWith('chrome-extension://')&&x.url.endsWith('/background.js'));
   for(const target of targets){
     let attached;
     try{
       attached=await browser.call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
       await browser.call('Runtime.enable',{},attached.sessionId);
       const result=await browser.call('Runtime.evaluate',{expression:'chrome.runtime?.getManifest?.().name',returnByValue:true},attached.sessionId);
       if(result.result?.value==='Switchboard Browser Companion'){
         worker=target;swSession=attached.sessionId;break;
       }
     }catch{/* try the next worker */}
     if(attached?.sessionId&&!worker){
       try{await browser.call('Target.detachFromTarget',{sessionId:attached.sessionId})}catch{}
     }
   }
   if(!worker)await sleep(200);
 }
 if(!worker)throw Error('Switchboard Browser Companion service worker not found');
 async function evalSw(expression){const v=await browser.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},swSession);if(v.exceptionDetails)throw Error('SW exception: '+v.exceptionDetails.text);return v.result?.value;}
 const name=await evalSw('chrome.runtime.getManifest().name');
 if(name!=='Switchboard Browser Companion')throw Error('Wrong Chrome extension loaded: '+JSON.stringify(name));
 console.log('PASS real Chrome installed extension and evaluated MV3 worker');
 const connection=await evalSw(`pairBridge({url:'http://127.0.0.1:${bridgePort}',code:'${host.ctx.browserCompanion.pairingCode}'})`);
 if(!connection?.ok||!connection?.connected)throw Error('Chrome background pairing failed: '+JSON.stringify(connection));
 console.log('PASS real background service worker paired using single-use code');
 const connected=await evalSw('bridgeStatus().connected');
 if(!connected||!host.ctx.browserCompanion.isClientConnected())throw Error('Local backend WebSocket not connected');
 console.log('PASS authenticated real Chrome background WebSocket connects to Switchboard');
 await evalSw(`chrome.storage.local.set({approvedOrigins:['http://127.0.0.1:${pagePort}'],permissionMode:'auto_safe'})`);
 await sleep(300);
 const state=host.ctx.browserCompanion.getActiveTab();
 console.log('Active tab reported by Chrome extension: '+(state?.url?.startsWith('http://127.0.0.1:')?'LOCAL_HTTP_TAB':'NONE'));
 const webReady=await host.ctx.web.ready();
 console.log('REAL_LOCAL_WEB_READY '+JSON.stringify({port:webPort,ready:Boolean(webReady)}));
 const qaTab=(await evalSw("chrome.tabs.query({}).then(t=>t.filter(x=>x.url?.startsWith('http://127.0.0.1:')).map(x=>({id:x.id,url:x.url})))"))[0];
 if(!qaTab||!qaTab.url.endsWith('/'))throw Error('Local QA target missing');
 await evalSw('bindAgentTab('+qaTab.id+')');
 const otherTarget=await browser.call('Target.createTarget',{url:'http://127.0.0.1:'+pagePort+'/other'});
 let otherTabId;
 for(let i=0;i<20;i++){
   const tablist=await evalSw('chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url})))');
   const other=tablist.find(t=>t.url?.endsWith('/other'));
   if(other){otherTabId=other.id;break}
   await sleep(100);
 }
 if(!otherTabId)throw Error('Second QA tab missing');
 await evalSw('chrome.tabs.update('+qaTab.id+', {active:true})');
 const extensionId=worker.url.split('/')[2];
 const panelTarget=await browser.call('Target.createTarget',{url:'chrome-extension://'+extensionId+'/panel.html'});
 const panelSession=(await browser.call('Target.attachToTarget',{targetId:panelTarget.targetId,flatten:true})).sessionId;
 await browser.call('Runtime.enable',{},panelSession);
 const evalPanel=async (expression,userGesture=false)=>{
   const x=await browser.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture},panelSession);
   if(x.exceptionDetails)throw Error('Panel CDP '+x.exceptionDetails.text);
   return x.result?.value;
 };
 let ready=false;
 for(let i=0;i<65;i++){
   try{
     const x=await evalPanel("({form:!!document.getElementById('task-send'),connected:typeof companionToken==='string'&&companionToken.length>10,bridge:document.getElementById('companion-badge')?.textContent})");
     if(x.form&&x.connected&&x.bridge==='Connected'){ready=true;break}
   }catch{}
   await sleep(200);
 }
 if(!ready)throw Error('Real panel did not initialize paired with the bridge');
 console.log('PASS_REAL_PANEL_PAIRED');
 const prompt='On the previously selected Chrome QA test tab, click the button #counter exactly once, read it back using browser_dom_snapshot, and report the new button count. Do not touch the second QA tab. Do not navigate away.';
 const send=await evalPanel("(()=>{document.getElementById('task-prompt').value="+JSON.stringify(prompt)+";document.getElementById('task-send').click();return 'sent'})()",true);
 if(send!=='sent')throw Error('Panel submit did not run');
 console.log('PANEL_REAL_AI_SUBMITTED');
 const start=Date.now();
 let approvals=0,finalState,lastStatus='',hasProgress=false;
 while(Date.now()-start<240000){
   const state=await evalPanel("({status:document.getElementById('task-status')?.textContent,answer:[...document.querySelectorAll('#chat-log .msg-agent .answer')].at(-1)?.textContent||'',stepText:[...document.querySelectorAll('#chat-log .msg-agent .steps')].at(-1)?.textContent||'',sendEnabled:!document.getElementById('task-send')?.disabled,approval:document.getElementById('approval-banner')?.classList.contains('visible'),approvalText:document.getElementById('approval-desc')?.textContent,notes:[...document.querySelectorAll('#chat-log .msg-note')].map(x=>x.textContent).slice(-2),session:typeof conversationId==='string'?conversationId:null})");
   if(state.status!==lastStatus){lastStatus=state.status; console.log('PANEL_TASK_STATUS '+JSON.stringify({elapsedMs:Date.now()-start,status:state.status}));}
   if(state.stepText?.includes('langkah')||state.stepText?.includes('Bekerja'))hasProgress=true;
   if(state.approval&&approvals<7){
     const ap=host.ctx.approvals.pending()[0];
     const valid=ap&&ap.sessionId===state.session&&['browser_dom_snapshot','browser_click','browser_tabs_list','browser_tab_select'].includes(ap.tool)&& (!ap.args?.selector || ap.args.selector==='#counter');
     if(!valid)throw Error('Unexpected approval; will not authorize: '+JSON.stringify({tool:ap?.tool,args:ap?.args,session:state.session}));
     await evalPanel("document.getElementById('btn-approve-once').click();'approved'",true);
     approvals++;
     console.log('PANEL_REAL_OPERATOR_APPROVED '+JSON.stringify({tool:ap.tool,n:approvals}));
   }
   if(state.sendEnabled&&['Completed.','Failed.','Stopped.','Stopped at step limit.'].includes(state.status)){finalState=state;break}
   await sleep(300);
 }
 if(!finalState)throw Error('Real panel agent timed out after 240s');
 console.log('PANEL_FINAL '+JSON.stringify({status:finalState.status,answer:finalState.answer.slice(0,400),hasProgress,approvals,notes:finalState.notes}));
 if(finalState.status!=='Completed.'||!/\b1\b/.test(finalState.answer))throw Error('Real local AI did not return correct panel final');
 const pageTarget=(await browser.call('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url==='http://127.0.0.1:'+pagePort+'/');
 const s1=(await browser.call('Target.attachToTarget',{targetId:pageTarget.targetId,flatten:true})).sessionId;
 await browser.call('Runtime.enable',{},s1);
 const readDom=await browser.call('Runtime.evaluate',{expression:'({label:document.querySelector("#counter")?.textContent,n:document.querySelector("#counter")?.dataset.n})',returnByValue:true},s1);
 const actual=readDom.result?.value;
 console.log('REAL_CHROME_DOM '+JSON.stringify(actual));
 if(actual.label!=='Clicks: 1'||actual.n!=='1')throw Error('AI final does not match actual Chrome DOM');
 console.log('PASS_FULL_PANEL_REAL_AI_AUTO_BROWSER_FINAL_E2E');
 const expectedUrl='http://127.0.0.1:'+pagePort+'/';
 await evalSw('chrome.tabs.update('+otherTabId+',{active:true})');
 const bound=await host.ctx.browserCompanion.executeOnBrowser('browser_dom_snapshot',{});
 if(!JSON.stringify(bound).includes('Clicks: 1'))throw Error('Agent tab binding lost on user tab switch');
 const actualOther=await evalSw("chrome.tabs.get("+otherTabId+").then(t=>({id:t.id,url:t.url}))");
 if(actualOther.url!=='http://127.0.0.1:'+pagePort+'/other')throw Error('Wrong second tab');
 console.log('PASS_MULTITAB_BOUND_AGENT_CONTEXT_PERSISTED');
 await evalSw('stopSocket()');
 for(let i=0;i<30&&host.ctx.browserCompanion.isClientConnected();i++)await sleep(50);
 if(host.ctx.browserCompanion.isClientConnected())throw Error('Socket did not disconnect');
 const reconnected=await evalSw('ensureBridgeSocket()');
 if(!reconnected)throw Error('Paired Chrome worker did not reconnect automatically');
 for(let i=0;i<50&&!host.ctx.browserCompanion.isClientConnected();i++)await sleep(100);
 if(!host.ctx.browserCompanion.isClientConnected())throw Error('Backend not reconnected');
 console.log('PASS_PAIRED_RECONNECT_WITHOUT_REPAIR');
 const counterAfter=await browser.call('Runtime.evaluate',{expression:'document.querySelector("#counter")?.dataset.n',returnByValue:true},s1);
 if(counterAfter.result?.value!=='1')throw Error('Reconnect duplicated browser action');
 console.log('PASS_RECONNECT_NO_DUPLICATE_ACTION');
 await browser.close();
}catch(e){console.error('FAIL_REAL_CHROME_EXTENSION_WORKER_E2E:',e.message);process.exitCode=1}
finally{
 try{await host?.dispose()}catch{}
 if(chrome?.pid){try{execFileSync('taskkill',['/PID',String(chrome.pid),'/T','/F'],{stdio:'ignore'})}catch{try{chrome.kill()}catch{}}}
 if(server)await new Promise(r=>server.close(r));
 await sleep(500);try{await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200})}catch{}
}