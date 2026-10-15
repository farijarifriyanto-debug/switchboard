import { createHost } from '../dist/index.js';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p};
async function session(url){const ws=new WebSocket(url);await new Promise((r,e)=>{ws.onopen=r;ws.onerror=e});let id=0;const pending=new Map();ws.onmessage=e=>{let m=JSON.parse(e.data);if(pending.has(m.id)){let [r,j]=pending.get(m.id);pending.delete(m.id);m.error?j(Error(m.error.message)):r(m.result)}};return{call:(method,params={},sessionId)=>new Promise((r,j)=>{const i=++id;pending.set(i,[r,j]);ws.send(JSON.stringify({id:i,method,params,...(sessionId?{sessionId}:{})}))}),close:()=>ws.close()}};
const bridgePort=await port(),chromePort=await port(),pagePort=await port();
const profile=await mkdtemp(path.join(tmpdir(),'switchboard-chrome-worker-audit-'));
const token=randomBytes(32).toString('hex');
let host,chrome,server;
try{
 server=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<html><head><title>Switchboard Real Chrome Test</title></head><body><button id="counter" onclick="this.textContent=\'Clicks: 1\'">Clicks: 0</button><h1>Chrome DOM test</h1></body></html>')});
 await new Promise(r=>server.listen(pagePort,'127.0.0.1',r));
 host=await createHost({sessions:{dir:'',load:false},metrics:{persist:'',load:false},approval:{mode:'off'},browser:{port:bridgePort,host:'127.0.0.1',token,defaultMode:'skip'}});
 const chromeBin=process.env.SBX_TEST_CHROME_PATH;
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
       if(result.result?.value==='Switchboard Browser Companion'){worker=target;swSession=attached.sessionId;break}
     }catch{/* try next Chrome extension worker */}
     if(attached?.sessionId&&!worker){try{await browser.call('Target.detachFromTarget',{sessionId:attached.sessionId})}catch{}}
   }
   if(!worker)await sleep(200);
 }
 if(!worker)throw Error('Switchboard Browser Companion service worker missing');
 async function evalSw(expression){const v=await browser.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},swSession);if(v.exceptionDetails)throw Error('SW exception: '+v.exceptionDetails.text);return v.result?.value;}
 const name=await evalSw('chrome.runtime.getManifest().name');
 if(name!=='Switchboard Browser Companion')throw Error('Wrong Chrome extension loaded: '+name+'; target='+worker.url);
 console.log('PASS real Chrome installed extension and evaluated MV3 worker');
 const connection=await evalSw(`pairBridge({url:'http://127.0.0.1:${bridgePort}',code:'${host.ctx.browserCompanion.pairingCode}'})`);
 if(!connection?.ok||!connection?.connected)throw Error('Chrome background pairing failed: '+JSON.stringify(connection));
 console.log('PASS real background service worker paired using single-use code');
 const connected=await evalSw('bridgeStatus().connected');
 if(!connected||!host.ctx.browserCompanion.isClientConnected())throw Error('Local backend WebSocket not connected');
 console.log('PASS authenticated real Chrome background WebSocket connects to Switchboard');
 await evalSw(`chrome.storage.local.set({approvedOrigins:['http://127.0.0.1:${pagePort}'],permissionMode:'skip'})`);
 await sleep(300);
 const state=host.ctx.browserCompanion.getActiveTab();
 console.log('Active tab reported by Chrome extension: '+(state?.url?.startsWith('http://127.0.0.1:')?'LOCAL_HTTP_TAB':'NONE'));
 console.log('PANEL_UI_VISUAL_QA_NO_MODEL');
 const extensionId=worker.url.split('/')[2];
 const panelTarget=await browser.call('Target.createTarget',{url:'chrome-extension://'+extensionId+'/panel.html'});
 const attached=await browser.call('Target.attachToTarget',{targetId:panelTarget.targetId,flatten:true});
 const panelSession=attached.sessionId;
 await browser.call('Runtime.enable',{},panelSession);
 const evalPanel=async expression=>{
   const result=await browser.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},panelSession);
   if(result.exceptionDetails)throw Error('Panel exception: '+result.exceptionDetails.text);
   return result.result?.value;
 };
 let ready=false;
 for(let i=0;i<35;i++){
  try{
   const probe=await evalPanel("({ready:document.readyState,prompt:!!document.getElementById('task-prompt'),connected:typeof companionToken === 'string' && companionToken.length>10})");
   if(probe.prompt&&probe.connected){ready=true;break}
  }catch{}
  await sleep(160);
 }
 if(!ready)throw Error('Panel task form did not initialize with bridge token');
 console.log('PASS_REAL_CHROME_PANEL_RENDERED_PAIRED');
 const setupExpression='(' + (() => {
   const originalFetch=window.fetch.bind(window);
   window.__qaKind='success';
   window.fetch=(url,init={})=>{
     if(String(url).includes('/api/chat')){
       if(window.__qaKind==='slow'){
         return new Promise((resolve,reject)=>{
           if(init.signal?.aborted)return reject(new DOMException('QA aborted','AbortError'));
           init.signal?.addEventListener('abort',()=>reject(new DOMException('QA aborted','AbortError')),{once:true});
         });
       }
       const byKind={
         success:[{type:'session',sessionId:'qa-session'}, {type:'tool_call',name:'browser_tabs_list',id:'qa-call'}, {type:'tool_result',name:'browser_tabs_list',id:'qa-call',result:'ok'}, {type:'final',content:'Observed Chrome page counter: 1',stopReason:'answer'}],
         incomplete:[{type:'session',sessionId:'qa-session'}, {type:'tool_call',name:'browser_dom_snapshot',id:'qa-call'}],
         error:[{type:'session',sessionId:'qa-session'}, {type:'error',error:'Provider test failed'}],
         error_then_final:[{type:'session',sessionId:'qa-session'}, {type:'error',error:'Fatal provider error'}, {type:'final',content:'This success must not display',stopReason:'answer'}],
         cancelled:[{type:'session',sessionId:'qa-session'}, {type:'cancelled'}],
         step_limit:[{type:'session',sessionId:'qa-session'}, {type:'final',content:'Stopped after 5 steps without a final answer.',stopReason:'step_limit'}]
       };
       const messages=byKind[window.__qaKind]||[];
       return Promise.resolve(new Response(new ReadableStream({
         start(controller){
           const encoder=new TextEncoder();
           for(const msg of messages)controller.enqueue(encoder.encode('data: '+JSON.stringify(msg)+'\n\n'));
           controller.close();
         }
       }),{status:200,headers:{'content-type':'text/event-stream'}}));
     }
     return originalFetch(url,init);
   };
   return true;
 }).toString() + ')()';
 await evalPanel(setupExpression);
 const trigger=async kind=>evalPanel("(()=>{window.__qaKind="+JSON.stringify(kind)+";let x=document.getElementById('task-prompt');x.value='QA '+window.__qaKind;document.getElementById('task-send').click();return true})()");
 const capture=()=>evalPanel("({status:document.getElementById('task-status')?.textContent,enabled:!document.getElementById('task-send')?.disabled,answer:[...document.querySelectorAll('#chat-log .msg-agent .answer')].at(-1)?.textContent||'',notes:[...document.querySelectorAll('#chat-log .msg-note')].map(x=>x.textContent).slice(-2)})");
 const waitFor=async expected=>{
   let state;
   for(let i=0;i<90;i++){
     state=await capture();
     if(state.status===expected&&state.enabled)return state;
     await sleep(60);
   }
   throw Error('Panel status expected '+expected+' got '+JSON.stringify(state));
 };
 await trigger('success');
 let panelResult=await waitFor('Completed.');
 if(!panelResult.answer.includes('Observed Chrome page counter: 1'))throw Error('Successful streamed answer not rendered');
 console.log('PASS_VISIBLE_PANEL_SUCCESS_FINAL');
 await trigger('incomplete');
 panelResult=await waitFor('Failed.');
 if(!panelResult.notes.some(x=>x.includes('Koneksi tugas berakhir')))throw Error('Missing-final stream did not explain its failure');
 console.log('PASS_VISIBLE_PANEL_INCOMPLETE_STREAM_FAIL_CLOSED');
 await trigger('error');
 panelResult=await waitFor('Failed.');
 if(!panelResult.notes.some(x=>x.includes('Provider test failed')))throw Error('Backend error event not surfaced');
 console.log('PASS_VISIBLE_PANEL_ERROR');
 await trigger('error_then_final');
 panelResult=await waitFor('Failed.');
 if(panelResult.answer.includes('This success must not display'))throw Error('Terminal error was overwritten by a false final');
 console.log('PASS_VISIBLE_PANEL_ERROR_STICKY');
 await trigger('cancelled');
 panelResult=await waitFor('Stopped.');
 console.log('PASS_VISIBLE_PANEL_CANCELLED');
 await trigger('step_limit');
 panelResult=await waitFor('Stopped at step limit.');
 console.log('PASS_VISIBLE_PANEL_STEP_LIMIT');
 await trigger('slow');
 await sleep(150);
 await evalPanel("document.getElementById('task-stop').click()");
 panelResult=await waitFor('Stopped.');
 if(!panelResult.enabled)throw Error('Stop did not unlock the composer');
 console.log('PASS_VISIBLE_PANEL_STOP_ABORTS_INFLIGHT_REQUEST');
 console.log('PASS_VISIBLE_CHROME_PANEL_STREAM_TERMINAL_CASES');
 await browser.close();
}catch(e){console.error('FAIL_REAL_CHROME_EXTENSION_WORKER_E2E:',e.message);process.exitCode=1}
finally{
 try{await host?.dispose()}catch{}
 if(chrome?.pid){try{execFileSync('taskkill',['/PID',String(chrome.pid),'/T','/F'],{stdio:'ignore'})}catch{try{chrome.kill()}catch{}}}
 if(server)await new Promise(r=>server.close(r));
 await sleep(500);try{await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200})}catch{}
}