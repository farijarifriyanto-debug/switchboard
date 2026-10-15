import { createHost } from '../dist/index.js';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
const localModel=process.env.SBX_LOCAL_MODEL||'botconnector-fast:latest';
const useLocalCore=process.env.SBX_USE_BOTCONNECTOR_LOCAL_CORE==='1';
const localBaseURL=process.env.SBX_LOCAL_BASE_URL||'http://127.0.0.1:11666/v1';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p};
async function session(url){const ws=new WebSocket(url);await new Promise((r,e)=>{ws.onopen=r;ws.onerror=e});let id=0;const pending=new Map();ws.onmessage=e=>{let m=JSON.parse(e.data);if(pending.has(m.id)){let [r,j]=pending.get(m.id);pending.delete(m.id);m.error?j(Error(m.error.message)):r(m.result)}};return{call:(method,params={},sessionId)=>new Promise((r,j)=>{const i=++id;pending.set(i,[r,j]);ws.send(JSON.stringify({id:i,method,params,...(sessionId?{sessionId}:{})}))}),close:()=>ws.close()}};
const bridgePort=await port(),chromePort=await port(),pagePort=await port();
const profile=await mkdtemp(path.join(tmpdir(),'switchboard-chrome-worker-audit-'));
const token=randomBytes(32).toString('hex');
let host,chrome,server;
try{
 server=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<html><head><title>Switchboard Real Chrome Test</title></head><body><button id="counter" onclick="this.textContent=\'Clicks: \'+(Number(this.dataset.n||0)+1);this.dataset.n=Number(this.dataset.n||0)+1">Clicks: 0</button><h1>Chrome DOM test</h1></body></html>')});
 await new Promise(r=>server.listen(pagePort,'127.0.0.1',r));
 host=await createHost({llm:{baseURL:useLocalCore?'http://127.0.0.1:65534/v1':localBaseURL,apiKey:useLocalCore?undefined:'ollama',defaultModel:useLocalCore?'unreachable-default':localModel,retries:0,timeoutMs:100000,...(useLocalCore?{fallbacks:[{provider:'default',model:'unreachable-default'}]}:{})},agent:{maxSteps:5,maxTokens:512,temperature:0},tools:{shell:{disabled:true}},settings:{dir:path.join(profile,'settings')},sessions:{dir:'',load:false},metrics:{persist:'',load:false},approval:{mode:'risky'},browser:{port:bridgePort,host:'127.0.0.1',token,defaultMode:'skip'}});
 if(useLocalCore){
   const {connectBotConnectorLocal}=await import('../dist/services/botconnector-local.js');
   const local=await connectBotConnectorLocal(host.ctx.providers,localModel);
   if(local.provider!=='local-botconnector')throw Error('Failed to select local-core provider');
   console.log('P2_BOTCONNECTOR_LOCAL_CORE_PROVIDER_SELECTED');
 }
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
 // Only select an EXISTING action mode: do not fake site grants through
 // historical approvedOrigins; Chrome's native host permission remains authority.
 await evalSw("chrome.storage.local.set({permissionMode:'skip'})");
 await sleep(300);
 // Focus the actual QA HTTP tab, not Chrome's transient new-tab/start page.
 // This changes only tab activation, never host permissions.
 const qaTab=(await browser.call('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:'+pagePort+'/'));
 if(!qaTab)throw Error('QA tab not present in real Chrome target list');
 await browser.call('Target.activateTarget',{targetId:qaTab.targetId});
 const known=await evalSw('chrome.tabs.query({})');
 console.log('QA_CHROME_TAB_COUNT='+known.length+' TARGETS='+known.map(t=>({id:t.id,active:t.active,url:t.url?.slice(0,65)})).map(JSON.stringify).join(';'));
 const actual=known.find(t=>t.url?.startsWith('http://127.0.0.1:'+pagePort+'/'));
 if(actual){await evalSw('chrome.tabs.update('+actual.id+',{active:true})');}
 await sleep(650);
 await evalSw('syncBrowserState()');
 const state=host.ctx.browserCompanion.getActiveTab();
 console.log('Active tab reported by Chrome extension: '+(state?.url?.startsWith('http://127.0.0.1:')?'LOCAL_HTTP_TAB':'NONE'));
 const dom=await host.ctx.tools.call('browser_dom_snapshot',{});
 if(!String(dom).includes('Chrome DOM test'))throw Error('Agent could not read real Chrome page: '+String(dom).slice(0,300));
 console.log('PASS Switchboard agent tool reads DOM from actual Chrome tab');
 const click=await host.ctx.tools.call('browser_click',{selector:'#counter'});
 if(!String(click).match(/click|counter|ok|success/i))throw Error('Click failed: '+String(click).slice(0,260));
 const after=await host.ctx.tools.call('browser_dom_snapshot',{});
 if(!String(after).includes('Clicks: 1'))throw Error('DOM did not change after click: '+String(after).slice(0,320));
 console.log('PASS agent browser_click modified actual Chrome DOM and readback confirmed');
  console.log('PASS_REAL_CHROME_EXTENSION_WORKER_E2E');
 if(process.env.SBX_BROWSER_ONLY==='1') console.log('PASS_VISIBLE_BROWSER_ONLY_NO_MODEL_INFERENCE');
 else {
 console.log('=== Starting local model AI -> browser, no cloud ===');
 const aiSession=host.ctx.sessions.create({title:'QA local AI browser test',preset:'browser',model:localModel,...(useLocalCore?{provider:'local-botconnector'}:{})});
 const modelEvents=[], modelTools=[], modelErrors=[];
 const ac=new AbortController();
 const kill=setTimeout(()=>ac.abort(),100000);
 let textAnswer='';
 try{
   for await (const ev of host.ctx.agent.stream(
     'On the active local Chrome test tab, click #counter exactly once, then call browser_dom_snapshot. State the button counter number in your final answer. Do not navigate, write files or use shell.',
     aiSession.id,{preset:'browser',maxSteps:5,signal:ac.signal,...(useLocalCore?{provider:'local-botconnector'}:{})}
   )){
     if(modelEvents.length<35) modelEvents.push({type:ev.type,name:ev.name||ev.tool||ev.toolName});
     if(ev.type==='tool'||ev.type==='tool_call')modelTools.push(String(ev.name||ev.tool||ev.toolName||''));
     if(ev.type==='error')modelErrors.push(String(ev.error||ev.message||'').slice(0,200));
     if(ev.type==='text'||ev.type==='delta'||ev.type==='chunk')textAnswer+=String(ev.content||ev.text||'');
   }
 }finally{clearTimeout(kill)}
 const verify=await host.ctx.tools.call('browser_dom_snapshot',{});
 const changed=String(verify).includes('Clicks: 2');
 console.log('LOCAL_AI_MODEL_TOOLS='+JSON.stringify(modelTools));
 console.log('LOCAL_AI_MODEL_EVENTS='+JSON.stringify(modelEvents.slice(0,12)));
 console.log('LOCAL_AI_MODEL_ERRORS='+JSON.stringify(modelErrors));
 console.log('LOCAL_AI_FINAL_SNIPPET='+textAnswer.slice(0,220));
 console.log('LOCAL_AI_VERIFIED_COUNTER_2='+changed);
 if(modelErrors.length||!changed||!modelTools.some(x=>x.includes('browser_click')))throw Error('Local AI did not autonomously click and verify the real Chrome DOM');
 console.log('PASS_LOCAL_AI_TO_VISIBLE_CHROME_E2E');
 }
 await browser.close();
}catch(e){console.error('FAIL_REAL_CHROME_EXTENSION_WORKER_E2E:',e.message);process.exitCode=1}
finally{
 try{await host?.dispose()}catch{}
 if(chrome?.pid){try{execFileSync('taskkill',['/PID',String(chrome.pid),'/T','/F'],{stdio:'ignore'})}catch{try{chrome.kill()}catch{}}}
 if(server)await new Promise(r=>server.close(r));
 await sleep(500);try{await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200})}catch{}
}