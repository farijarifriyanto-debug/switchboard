/** One-ZIP fresh-profile smoke: never downloads a model or modifies owner's real APPDATA. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
const root=process.env.SBX_PORTABLE_ROOT
if(process.platform!=='win32'||!root)throw Error('Run on Windows with SBX_PORTABLE_ROOT pointing to extracted portable bundle')
const node=path.join(root,'runtime','node.exe')
const core=path.join(root,'local-core','bin','botconnector.mjs')
for(const f of [node,core,path.join(root,'local-core','dist','web','index.html'),path.join(root,'Start-Switchboard.cmd'),path.join(root,'Manage-Local-AI.cmd'),path.join(root,'Check-Local-AI.cmd')])assert.ok(existsSync(f),'Missing bundled component: '+f)
const rev=(await readFile(path.join(root,'local-core','SOURCE-REVISION.txt'),'utf8')).trim()
assert.match(rev,/1aa37824ea5d6bcd35f499c892a68cecfa695660/)
const profile=await mkdtemp(path.join(os.tmpdir(),'sbx-p2-new-user-'))
const appdata=path.join(profile,'AppData','Roaming')
await mkdir(appdata,{recursive:true})
const env={...process.env,APPDATA:appdata,USERPROFILE:profile,HOME:profile,PATH:path.join(root,'runtime')+';'+process.env.PATH}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const available=async()=>{const s=net.createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r)});const p=s.address().port;await new Promise(r=>s.close(r));return p}
const runOnce=(args,timeout=12000)=>new Promise((resolve,reject)=>{
 const proc=spawn(node,[core,...args],{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
 let out='',err=''
 proc.stdout.on('data',x=>out+=String(x).slice(0,18000))
 proc.stderr.on('data',x=>err+=String(x).slice(0,6000))
 const timer=setTimeout(()=>{try{proc.kill()}catch{};reject(Error('CLI timeout '+args.join(' ')))},timeout)
 proc.on('error',e=>{clearTimeout(timer);reject(e)})
 proc.on('exit',code=>{clearTimeout(timer);code===0?resolve(out):reject(Error('exit '+code+' '+args.join(' ')+': '+err.slice(0,400)))})
})
let runs=0
const port=await available()
async function bootManager(){
 const child=spawn(node,[core,'serve','--hostname','127.0.0.1','--port',String(port)],{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
 let logs=''
 child.stdout.on('data',x=>logs+=String(x).slice(0,1500))
 child.stderr.on('data',x=>logs+=String(x).slice(0,1500))
 try {
   let response
   for(let i=0;i<100;i++){
     if(child.exitCode!==null)throw Error('Bundled manager exited '+child.exitCode+': '+logs.slice(0,550))
     try {
       response=await fetch('http://127.0.0.1:'+port+'/',{signal:AbortSignal.timeout(950)})
       if(response.ok)break
     }catch{}
     await sleep(150)
   }
   assert.equal(response?.status,200,'Bundled manager did not serve localhost HTTP')
   const html=await response.text()
   assert.ok(html.length>1000,'Manager UI empty')
   assert.match(html,/<html|<!doctype/i)
   console.log('FRESH_PROFILE_MANAGER_HTTP_PASS boot='+ ++runs+' length='+html.length+' port='+port)
 }finally{
   if(child.exitCode===null){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',timeout:5000})}catch{try{child.kill()}catch{}}}
   if(child.exitCode===null) await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(3000)])
 }
 for(let i=0;i<30;i++){try{await fetch('http://127.0.0.1:'+port+'/',{signal:AbortSignal.timeout(400)})}catch{return}}
 throw Error('QA manager still listening after stop')
}
try {
 const status=await runOnce(['runtime','status','--json'])
 assert.ok(status.includes('{'),'Original Core runtime status missing JSON')
 console.log('FRESH_PROFILE_RUNTIME_STATUS_PASS (no downloads)')
 await bootManager()
 await bootManager()
 console.log('FRESH_PROFILE_MANAGER_RECONNECT_PASS same isolated profile')
 const created=await readdir(profile,{recursive:true})
 assert.ok(!created.some(p=>/\.gguf$|llama-server\.exe$/i.test(p)),'A GGUF model or llama.cpp runtime was installed without user request')
 console.log('PORTABLE_FRESH_PROFILE_SMOKE_PASS no model auto-download; isolated APPDATA; original store optional')
}finally{
 await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200}).catch(()=>{})
}
