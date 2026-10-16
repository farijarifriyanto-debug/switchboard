/** P2 opt-in: real headed Chrome screenshot -> Switchboard -> local llama.cpp GGUF+mmproj. */
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {randomBytes} from 'node:crypto'
import {spawn,execFileSync} from 'node:child_process'
import net from 'node:net'
import http from 'node:http'
import WebSocket from 'ws'
import {createHost} from '../dist/index.js'
import {connectBotConnectorLocal} from '../dist/services/botconnector-local.js'
// Reuse an existing original BotConnector-managed model when requested;
// never launch a second llama-server on an already loaded, RAM-limited laptop.
const reuseRunningCore=process.env.SBX_USE_RUNNING_LOCAL_CORE==='1'
for(const key of (reuseRunningCore?['SBX_TEST_CHROME_PATH']:['SBX_LOCAL_LLAMA_SERVER','SBX_LOCAL_GGUF','SBX_LOCAL_MMPROJ','SBX_TEST_CHROME_PATH'])) if(!process.env[key]) throw Error('Missing '+key)
const alloc=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const llamaPort=reuseRunningCore?Number(process.env.SWITCHBOARD_LOCAL_CORE_PORT||11435):await alloc(),chromePort=await alloc(),pagePort=await alloc()
const secret=reuseRunningCore?'':randomBytes(32).toString('hex')
const dir=await mkdtemp(path.join(tmpdir(),'sbx-p2-vision-'))
let server,proc,chrome,ws,host,log=''
const pending=new Map();let n=0
async function cdp(method,params={}){
 return await new Promise((resolve,reject)=>{
 const id=++n;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method))},12000)
 pending.set(id,{resolve,reject,timer})
 ws.send(JSON.stringify({id,method,params}))
 })
}
try{
 server=http.createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html><body style="background:white"><h1 style="font: bold 80px Arial">BICO 731</h1><div style="width:650px;height:320px;background:rgb(0,90,245)"></div></body></html>')})
 await new Promise(r=>server.listen(pagePort,'127.0.0.1',r))
 proc=spawn(process.env.SBX_LOCAL_LLAMA_SERVER,['-m',process.env.SBX_LOCAL_GGUF,'--mmproj',process.env.SBX_LOCAL_MMPROJ,'--alias','qa-local-vision','--host','127.0.0.1','--port',String(llamaPort),'-c','2048','-t','4','-np','1','--api-key',secret,'--cors-origins','http://127.0.0.1:18777','--no-cors-credentials'],{stdio:['ignore','ignore','pipe'],windowsHide:true})
 proc.stderr.on('data',x=>{log=(log+String(x)).slice(-6000)})
 let ready=false
 for(let i=0;i<65;i++){
  if(proc.exitCode!==null) throw Error('llama exited '+proc.exitCode+': '+log.slice(-800))
  try{if((await fetch('http://127.0.0.1:'+llamaPort+'/health',{signal:AbortSignal.timeout(800)})).ok){ready=true;break}}catch{}
  await sleep(200)
 }
 assert.ok(ready,'llama not healthy: '+log.slice(-800))
 console.log('REAL_LOCAL_VISION_RUNTIME_READY')
 chrome=spawn(process.env.SBX_TEST_CHROME_PATH,['--no-first-run','--no-default-browser-check','--remote-debugging-port='+chromePort,'--user-data-dir='+path.join(dir,'chrome'),'--new-window','http://127.0.0.1:'+pagePort+'/'],{stdio:'ignore'})
 let tab
 for(let i=0;i<50;i++){
  try{const tabs=await fetch('http://127.0.0.1:'+chromePort+'/json/list').then(r=>r.json());tab=tabs.find(x=>x.type==='page'&&x.url.startsWith('http://127.0.0.1:'+pagePort));if(tab)break}catch{}
  await sleep(220)
 }
 assert.ok(tab,'headed Chrome did not open QA fixture')
 ws=new WebSocket(tab.webSocketDebuggerUrl)
 await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)})
 ws.on('message',raw=>{const m=JSON.parse(String(raw)),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}})
 await cdp('Page.enable')
 await cdp('Runtime.enable')
 const pageReady=await cdp('Runtime.evaluate',{expression:'document.readyState',returnByValue:true})
 console.log('CHROME_FIXTURE_READY_STATE='+pageReady.result?.value)
 await cdp('Page.bringToFront')
 await sleep(750)
 const image=await cdp('Page.captureScreenshot',{format:'jpeg',quality:82,captureBeyondViewport:false,fromSurface:false})
 assert.ok(image.data.length>4000,'real screenshot too small')
 console.log('REAL_CHROME_SCREENSHOT_CAPTURED '+Math.round(image.data.length*0.75)+' bytes')
 process.env.SWITCHBOARD_LOCAL_CORE_PORT=String(llamaPort)
 process.env.BOTCONNECTOR_LOCAL_API_KEY=secret
 host=await createHost({llm:{baseURL:'http://127.0.0.1:65534/v1',defaultModel:'cloud-should-never-run',retries:0,timeoutMs:45000,fallbacks:[{provider:'default',model:'cloud-should-never-run'}]},sessions:{dir:path.join(dir,'sessions'),load:false},settings:{dir:path.join(dir,'settings')},metrics:{persist:'',load:false},tools:{shell:{disabled:true}}})
 await connectBotConnectorLocal(host.ctx.providers,'qa-local-vision')
 const answer=await host.ctx.llm.generate({provider:'local-botconnector',model:'qa-local-vision',messages:[{role:'user',content:'Read the large title text printed near the top of the screenshot. Return that text exactly.',attachments:[{name:'chrome.jpg',mimeType:'image/jpeg',dataUrl:'data:image/jpeg;base64,'+image.data}]}],temperature:0,maxTokens:64})
 console.log('LOCAL_GGUF_VISION_ANSWER='+answer.content.trim().replace(/[\r\n]/g,' ').slice(0,110))
 assert.match(answer.content,/BICO\s*731/i,'offline vision failed to OCR the heading; record a vision model limitation')
 console.log('OFFLINE_CHROME_TO_SWITCHBOARD_LOCAL_GGUF_VISION_PASS')
}finally{
 try{await host?.dispose()}catch{}
 try{ws?.close()}catch{}
 if(chrome?.pid){try{execFileSync('taskkill',['/PID',String(chrome.pid),'/T','/F'],{stdio:'ignore'})}catch{chrome.kill()}}
 proc?.kill()
 if(server)await new Promise(r=>server.close(r))
 await sleep(600)
 await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:250}).catch(()=>{})
 delete process.env.BOTCONNECTOR_LOCAL_API_KEY
 delete process.env.SWITCHBOARD_LOCAL_CORE_PORT
}
