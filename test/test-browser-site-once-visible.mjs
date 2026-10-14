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
 chrome=spawn(chromeBin,['--no-first-run','--no-default-browser-check','--window-size=1400,870','--window-position=15,10','--disable-gpu','--disable-translate','--no-proxy-server','--host-resolver-rules=MAP qa.internal 127.0.0.1','--remote-allow-origins=*',`--remote-debugging-port=${chromePort}`,`--user-data-dir=${profile}`,`--load-extension=${path.join(process.cwd(),'browser-extension')}`,`--disable-extensions-except=${path.join(process.cwd(),'browser-extension')}`,`http://qa.internal:${pagePort}/`],{stdio:'ignore'});
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
 await evalSw(`chrome.storage.local.set({approvedOrigins:['http://qa.internal:${pagePort}'],permissionMode:'skip'})`);
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
 const origin='http://qa.internal:'+pagePort;
 const beforeGrant=await evalSw('siteAccessGranted('+JSON.stringify(origin)+')');
 if(beforeGrant)throw Error('Unexpected optional Chrome host grant before test');
 console.log('PASS_REAL_CHROME_HOST_PERMISSION_ABSENT');
 const qaTabs=await evalSw('chrome.tabs.query({}).then(tabs=>tabs.map(t=>({id:t.id,url:t.url,active:t.active})))'); console.log('QA_BROWSER_TABS='+JSON.stringify(qaTabs)); const qaTab=qaTabs.find(t=>t.url?.startsWith(origin+'/')); if(!qaTab)throw Error('QA target tab not found'); const pendingTool=host.ctx.tools.call('browser_dom_snapshot',{tabId:qaTab.id});
 let pending;
 for(let i=0;i<50;i++){
   pending=await evalSw('({site:Array.from(pendingSiteRequests.keys())[0],waiting:Array.from(pendingSiteRequests.values())[0]?.waiting.length})');
   if(pending?.site===origin&&pending.waiting===1)break;
   await sleep(100);
 }
 if(pending?.site!==origin)throw Error('Chrome did not require site permission: '+JSON.stringify(pending));
 console.log('PASS_REAL_CHROME_SITE_PERMISSION_REQUIRED');
 let display;
 for(let i=0;i<60;i++){
   display=await evalPanel("({visible:!document.getElementById('site-request')?.hidden,desc:document.getElementById('site-request-desc')?.textContent,deny:!!document.getElementById('site-request-deny')})");
   if(display?.visible&&display.desc?.includes(origin))break;
   await sleep(100);
 }
 if(!display?.visible||!display.desc?.includes(origin)||!display.deny)throw Error('Pending site request not visible in panel: '+JSON.stringify(display));
 const pos=await evalPanel("(()=>{const r=document.getElementById('site-request-once').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
 await browser.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:pos.x,y:pos.y,button:'none'},panelSession);
 await browser.call('Input.dispatchMouseEvent',{type:'mousePressed',x:pos.x,y:pos.y,button:'left',clickCount:1},panelSession);
 await browser.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:pos.x,y:pos.y,button:'left',clickCount:1},panelSession);
 let onceFeedback;
 for(let i=0;i<350;i++){
   onceFeedback=await evalPanel("document.getElementById('site-request-feedback')?.textContent");
   if(onceFeedback?.includes('Allowed for this action')||onceFeedback?.includes('Access error'))break;
   await sleep(100);
 }
 console.log('CHROME_ONCE_FEEDBACK='+JSON.stringify(onceFeedback));
 const grantDebug=await evalSw('(async()=>({granted:await siteAccessGranted('+JSON.stringify(origin)+'),pending:Array.from(pendingSiteRequests.keys()),oneTime:oneTimeOrigins.has('+JSON.stringify(origin)+')}))()');console.log('CHROME_GRANT_DEBUG='+JSON.stringify(grantDebug));
 if(!onceFeedback?.includes('Allowed for this action'))throw Error('Native Chrome allow-once did not complete');
 const read=await Promise.race([pendingTool,new Promise((_,reject)=>setTimeout(()=>reject(Error('Allowed tool did not settle')),45000))]);
 if(!String(read).includes('Chrome DOM test'))throw Error('Native Chrome grant did not resume the waiting tool: '+String(read).slice(0,300));
 console.log('PASS_VISIBLE_CHROME_NATIVE_ALLOW_ONCE_RESUMES_TOOL');
 let granted=true;
 for(let i=0;i<55;i++){
   granted=await evalSw('siteAccessGranted('+JSON.stringify(origin)+')');
   if(!granted)break;
   await sleep(100);
 }
 if(granted)throw Error('Chrome one-action grant was not revoked after tool');
 console.log('PASS_VISIBLE_CHROME_NATIVE_ONE_TIME_GRANT_REVOKED');
 const nextTool=host.ctx.tools.call('browser_dom_snapshot',{tabId:qaTab.id});
 let nextPending;
 for(let i=0;i<80;i++){
   nextPending=await evalSw('({site:Array.from(pendingSiteRequests.keys())[0],waiting:Array.from(pendingSiteRequests.values())[0]?.waiting.length})');
   if(nextPending?.site===origin)break;
   await sleep(100);
 }
 if(nextPending?.site!==origin)throw Error('Second action bypassed native permission: '+JSON.stringify(nextPending));
 // The background worker can publish the new native-origin request before
 // the panel's polling cycle has refreshed its pendingOrigin state.
 let panelReady=false;
 for(let i=0;i<75;i++){
   panelReady=await evalPanel("pendingOrigin==="+JSON.stringify(origin)+" && !document.getElementById('site-request').hidden");
   if(panelReady)break;
   await sleep(100);
 }
 if(!panelReady)throw Error('Panel did not render the second permission request');
 const denyPos=await evalPanel("(()=>{const r=document.getElementById('site-request-deny').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
 await browser.call('Input.dispatchMouseEvent',{type:'mouseMoved',x:denyPos.x,y:denyPos.y,button:'none'},panelSession);
 await browser.call('Input.dispatchMouseEvent',{type:'mousePressed',x:denyPos.x,y:denyPos.y,button:'left',clickCount:1},panelSession);
 await browser.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:denyPos.x,y:denyPos.y,button:'left',clickCount:1},panelSession);
 const denied=await Promise.race([nextTool,new Promise((_,reject)=>setTimeout(()=>reject(Error('Re-request denied tool did not settle')),15000))]);
 if(!String(denied).includes('User denied site access'))throw Error('Second tool did not fail after Deny: '+String(denied).slice(0,300));
 console.log('PASS_NATIVE_ALLOW_ONCE_THEN_REQUIRE_PERMISSION_AND_DENY');
 await browser.close();
}catch(e){console.error('FAIL_REAL_CHROME_EXTENSION_WORKER_E2E:',e.message);process.exitCode=1}
finally{
 try{await host?.dispose()}catch{}
 if(chrome?.pid){try{execFileSync('taskkill',['/PID',String(chrome.pid),'/T','/F'],{stdio:'ignore'})}catch{try{chrome.kill()}catch{}}}
 if(server)await new Promise(r=>server.close(r));
 await sleep(500);try{await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200})}catch{}
}