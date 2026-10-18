import { createHost } from '../dist/index.js';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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
 server=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end("<!DOCTYPE html><html lang=\"id\"><head><meta charset=\"utf-8\"><title>Claude Switchboard parity fixture</title></head><body><h1>QA-BICO-731</h1><p>Halaman uji lokal tidak memuat data pribadi, sesi, cookie, atau akun.</p><button id=\"qa-button\">Ready</button><p>Nama situs uji: Parity Fixture.</p></body></html>")});
 await new Promise(r=>server.listen(pagePort,'127.0.0.1',r));
 host=await createHost({settings:{dir:profile},llm:{baseURL:localBaseURL,apiKey:'ollama',defaultModel:localModel,retries:0,timeoutMs:120000},agent:{maxSteps:5,maxTokens:384,temperature:0},tools:{shell:{disabled:true}},sessions:{dir:'',load:false},metrics:{persist:'',load:false},approval:{mode:'risky'},browser:{port:bridgePort,host:'127.0.0.1',token,defaultMode:'auto_safe'},web:{enabled:true,port:webPort,host:'127.0.0.1',token:randomBytes(24).toString('hex')}});
 const chromeBin=process.env.SBX_TEST_CHROME_PATH; if(!chromeBin)throw Error('Set SBX_TEST_CHROME_PATH to Chrome for Testing chrome.exe');
 chrome=spawn(chromeBin,['--no-first-run','--no-default-browser-check','--disable-gpu','--remote-allow-origins=*',`--remote-debugging-port=${chromePort}`,`--user-data-dir=${profile}`,`--load-extension=${path.join(process.cwd(),'browser-extension')}`,`--disable-extensions-except=${path.join(process.cwd(),'browser-extension')}`,`http://127.0.0.1:${pagePort}/`],{stdio:'ignore'});
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
 const prompt="Pada tab halaman uji lokal ini, sebutkan persis teks judul H1 dan label tombol yang terlihat. Jangan mengklik, mengetik di halaman, membuka tab lain, atau mengubah situs. Jawab: Judul: ... ; Tombol: ...";
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
 if(finalState.status!=='Completed.'||!/QA-BICO-731/.test(finalState.answer)||!/Ready/.test(finalState.answer))throw Error('Real local AI did not correctly read the fixture via panel');

 const pageTarget=(await browser.call('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url==='http://127.0.0.1:'+pagePort+'/');
 if(!pageTarget)throw Error('QA fixture tab missing');
 const verifySession=(await browser.call('Target.attachToTarget',{targetId:pageTarget.targetId,flatten:true})).sessionId;
 await browser.call('Runtime.enable',{},verifySession);
 const actual=(await browser.call('Runtime.evaluate',{expression:'({h1:document.querySelector("h1")?.textContent,button:document.querySelector("#qa-button")?.textContent})',returnByValue:true},verifySession)).result?.value;
 console.log('CLAUDE_PARITY_QA_CHROME_DOM='+JSON.stringify(actual));
 if(actual?.h1!=='QA-BICO-731'||actual?.button!=='Ready')throw Error('Fixture was modified unexpectedly');
 console.log('PASS_SWITCHBOARD_ORIGINAL_CLAUDE_SAME_READONLY_FIXTURE');
 await browser.close();
}catch(e){console.error('FAIL_REAL_CHROME_EXTENSION_WORKER_E2E:',e.message);process.exitCode=1}
finally{
 try{await host?.dispose()}catch{}
 if(chrome?.pid){try{execFileSync('taskkill',['/PID',String(chrome.pid),'/T','/F'],{stdio:'ignore'})}catch{try{chrome.kill()}catch{}}}
 if(server)await new Promise(r=>server.close(r));
 await sleep(500);try{await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200})}catch{}
}