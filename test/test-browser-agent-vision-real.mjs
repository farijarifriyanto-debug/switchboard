import { createHost } from '../dist/index.js';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
const localModel=process.env.SBX_VISION_MODEL||'gemma4:cloud';
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
 host=await createHost({llm:{baseURL:localBaseURL,apiKey:process.env.SBX_LOCAL_API_KEY||'ollama',defaultModel:localModel,retries:0,timeoutMs:120000},agent:{maxSteps:4,maxTokens:500,temperature:0},tools:{shell:{disabled:true}},sessions:{dir:'',load:false},metrics:{persist:'',load:false},approval:{mode:'risky'},browser:{port:bridgePort,host:'127.0.0.1',token,defaultMode:'skip'}});
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
 await evalSw(`chrome.storage.local.set({approvedOrigins:['http://127.0.0.1:${pagePort}'],permissionMode:'skip'})`);
 await sleep(300);
 const state=host.ctx.browserCompanion.getActiveTab();
 console.log('Active tab reported by Chrome extension: '+(state?.url?.startsWith('http://127.0.0.1:')?'LOCAL_HTTP_TAB':'NONE'));
 const target=(await browser.call('Target.getTargets')).targetInfos.find(x=>x.type==='page'&&x.url==='http://127.0.0.1:'+pagePort+'/');
 const targetSession=(await browser.call('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
 await browser.call('Runtime.enable',{},targetSession);
 const expression="(()=>{document.body.style.margin='0';document.body.innerHTML='';const c=document.createElement('canvas');c.width=1040;c.height=600;document.body.append(c);const a=c.getContext('2d');a.fillStyle='#fcfcfc';a.fillRect(0,0,c.width,c.height);a.fillStyle='#12499c';a.font='bold 100px Arial';a.fillText('SATURN 42',75,260);a.font='54px Arial';a.fillText('BLUE RECTANGLE',75,370);a.fillStyle='#2257c8';a.fillRect(740,370,180,115);return {canvasCount:document.querySelectorAll('canvas').length,domText:document.body.innerText}})()";
 const draw=await browser.call('Runtime.evaluate',{expression,returnByValue:true},targetSession);
 console.log('VISION_FIXTURE='+JSON.stringify(draw.result?.value));
 if(draw.result?.value?.domText)throw Error('Canvas text leaked into DOM');
 const tabs=await evalSw('chrome.tabs.query({}).then(t=>t.filter(x=>x.url?.startsWith("http://127.0.0.1:")).map(x=>({id:x.id,url:x.url})))');
 if(!tabs[0]?.id)throw Error('Browser test tab missing');
 await evalSw('chrome.tabs.update('+tabs[0].id+',{active:true})');
 if(process.env.SBX_ALLOW_CLOUD_VISION_TEST!=='1')throw Error('Opt-in required: SBX_ALLOW_CLOUD_VISION_TEST=1');
 const allowed=['browser_screenshot','browser_tabs_list','browser_tab_select'];
 const excludeTools=host.ctx.tools.list().map(x=>x.name).filter(x=>!allowed.includes(x));
 const modelEvents=[],rawOutput=[];
 const prompt='Look at a screenshot of the active test browser page using browser_screenshot (not DOM). Read the large canvas-only text and describe the rectangle color. The screenshot contains the code and color, neither is available as DOM text. Respond with the exact code and color.';
 const sessionId=host.ctx.sessions.create({title:'Real vision agent screenshot QA'}).id;
 for await(const ev of host.ctx.agent.stream(prompt,sessionId,{model:localModel,maxSteps:4,excludeTools})){
   if(['tool_call','tool_result','final','error'].includes(ev.type)){
      modelEvents.push({type:ev.type,name:ev.name,content:ev.type==='final'?ev.content:undefined,error:ev.type==='error'?ev.error:undefined});
      console.log('VISION_AGENT_EVENT '+JSON.stringify(modelEvents.at(-1)));
   }
   rawOutput.push(ev);
 }
 const final=modelEvents.find(x=>x.type==='final');
 if(!modelEvents.some(x=>x.type==='tool_call'&&x.name==='browser_screenshot'))throw Error('Model did not invoke browser_screenshot');
 if(!final||!/SATURN\s*42/i.test(final.content)||!/(blue|biru)/i.test(final.content))throw Error('Final vision answer incorrect: '+JSON.stringify(final));
 const transcript=host.ctx.sessions.require(sessionId).messages;
 if(transcript.some(x=>JSON.stringify(x).includes('data:image/'))||rawOutput.some(x=>JSON.stringify(x).includes('data:image/'))){throw Error('Screenshot base64 leaked to transcript or event stream')}
 console.log('PASS_REAL_CHROME_AGENT_AUTO_SCREENSHOT_VISION_ANSWER '+JSON.stringify({model:localModel,final:final.content}));
 await browser.close();
}catch(e){console.error('FAIL_REAL_CHROME_EXTENSION_WORKER_E2E:',e.message);process.exitCode=1}
finally{
 try{await host?.dispose()}catch{}
 if(chrome?.pid){try{execFileSync('taskkill',['/PID',String(chrome.pid),'/T','/F'],{stdio:'ignore'})}catch{try{chrome.kill()}catch{}}}
 if(server)await new Promise(r=>server.close(r));
 await sleep(500);try{await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200})}catch{}
}