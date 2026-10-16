/** E2E of the pinned ORIGINAL Local Core shipped inside the Switchboard npm tarball.
 * No downloads, Cloud calls, or changes to the owner's APPDATA/profile.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const root = process.env.SBX_NPM_PACKAGE_ROOT || fileURLToPath(new URL('../', import.meta.url))
const cli = path.join(root, 'dist', 'cli.js')
const core = path.join(root, 'vendor', 'botconnector-local-core')
const expected = '1aa37824ea5d6bcd35f499c892a68cecfa695660'
for (const f of [cli, path.join(core,'bin','botconnector.mjs'), path.join(core,'dist','web','index.html'), path.join(core,'LICENSE')]) {
  assert.ok(existsSync(f), 'Original Core component missing in npm package: ' + f)
}
assert.equal((await readFile(path.join(core,'SOURCE-REVISION.txt'),'utf8')).trim(), expected)
const profile = await mkdtemp(path.join(tmpdir(),'sbx-npm-localcore-'))
const appdata = path.join(profile,'AppData','Roaming')
const localappdata = path.join(profile,'AppData','Local')
await Promise.all([mkdir(appdata,{recursive:true}), mkdir(localappdata,{recursive:true})])
// Core's Windows UI single-instance lock lives in LOCALAPPDATA, not APPDATA.
// Isolate both roots so QA never touches a real user's running model manager.
const env = {...process.env, APPDATA: appdata, LOCALAPPDATA: localappdata, USERPROFILE: profile, HOME: profile, XDG_DATA_HOME: path.join(profile,'data'), XDG_CONFIG_HOME: path.join(profile,'config')}
const sleep = ms => new Promise(r=>setTimeout(r,ms))
async function call(args) {
  return await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,...args],{env,stdio:['ignore','pipe','pipe'],windowsHide:true})
    let output='',error=''
    child.stdout.on('data',b=>output+=String(b))
    child.stderr.on('data',b=>error+=String(b))
    const timer=setTimeout(()=>{child.kill();reject(Error('Timed out '+args.join(' ')))},15000)
    child.once('error',e=>{clearTimeout(timer);reject(e)})
    child.once('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error('Failed '+args.join(' ')+': '+error.slice(0,500)))})
  })
}
async function freePort(){
  const s=net.createServer()
  await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve)})
  const port=s.address().port
  await new Promise(resolve=>s.close(resolve))
  return port
}
async function managerStartStop(port){
  const child=spawn(process.execPath,[cli,'local','serve','--hostname','127.0.0.1','--port',String(port)],{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
  let log=''
  child.stdout.on('data',b=>log+=String(b).slice(0,1000))
  child.stderr.on('data',b=>log+=String(b).slice(0,1000))
  try {
    let response
    for(let i=0;i<75;i++) {
      if(child.exitCode!==null)throw Error('Manager exited early: '+log.slice(0,500))
      try {response=await fetch('http://127.0.0.1:'+port+'/',{signal:AbortSignal.timeout(600)});if(response.ok)break}catch{}
      await sleep(160)
    }
    assert.equal(response?.status,200,'Bundled manager was not reachable')
    assert.ok((await response.text()).length>1000,'Original manager UI empty')
    console.log('NPM_LOCAL_CORE_MANAGER_HTTP_PASS')
  } finally {
    if(child.exitCode===null){
      if(process.platform==='win32'){
        try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',timeout:5000})}catch{child.kill()}
      } else child.kill('SIGTERM')
    }
    if(child.exitCode===null)await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(3500)])
  }
  for(let i=0;i<25;i++){
    try {await fetch('http://127.0.0.1:'+port+'/',{signal:AbortSignal.timeout(400)})}catch{
      console.log('NPM_LOCAL_CORE_MANAGER_STOP_PASS')
      return
    }
    await sleep(120)
  }
  throw Error('Original manager still running after QA')
}
try{
  const help=await call(['local','--help'])
  assert.match(help,/botconnector - BotConnector AI CLI/)
  const status=JSON.parse(await call(['local','status']))
  assert.equal(status.endpoint.port,11435)
  assert.equal(status.installed.installed,false,'A fresh user must not have a downloaded runtime')
  console.log('NPM_LOCAL_CORE_ORIGINAL_CLI_STATUS_PASS')
  await managerStartStop(await freePort())
  console.log('NPM_LOCAL_CORE_FRESH_PROFILE_PASS: pinned manager, no silent model download')
} finally {
  await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200}).catch(()=>{})
}
