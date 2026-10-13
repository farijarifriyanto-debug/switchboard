/** Real local Docker → official OpenSandbox MCP → ephemeral Python → cleanup.
 * This is optional on machines without a running Linux Docker daemon. */
import assert from 'node:assert/strict'
import { createHost } from '../dist/index.js'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
const execFile=promisify(execFileCb)
const dir=await mkdtemp(path.join(tmpdir(),'sbx-local-real-'))
let host
let managed
try {
 host=await createHost({
   llm:{baseURL:'http://127.0.0.1:9/v1',defaultModel:'fixture',retries:0},
   sessions:{dir:'',load:false},metrics:{persist:'',load:false},approval:{mode:'off'},
   settings:{dir},web:{enabled:true,port:0,host:'127.0.0.1'},
 })
 const {url}=await host.ctx.web.ready()
 const csrf=await fetch(url+'api/plugin-catalog/install',{method:'POST',headers:{Origin:'https://botconnector.id','Content-Type':'application/json'},body:JSON.stringify({id:'opensandbox',mode:'local'})})
 assert.equal(csrf.status,403)
 console.log('LOCAL_PLUGIN_CSRF_DENIED_PASS')
 const bad=await fetch(url+'api/plugin-catalog/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'opensandbox',mode:'local',endpoint:'127.0.0.1:18088'})})
 assert.equal(bad.status,400)
 console.log('LOCAL_PLUGIN_FORGED_ENDPOINT_DENIED_PASS')
 const res=await fetch(url+'api/plugin-catalog/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'opensandbox',mode:'local'})})
 const reply=await res.json()
 assert.equal(res.status,200,JSON.stringify(reply))
 assert.equal(reply.plugin.state,'up')
 assert.equal(reply.plugin.mode,'local')
 assert.ok(reply.plugin.toolCount>=20)
 assert.equal(JSON.stringify(reply).includes('apiKey'),false)
 console.log('LOCAL_DOCKER_PLUGIN_CONNECTED_PASS',reply.plugin.toolCount)
 const registry=JSON.parse(await readFile(path.join(dir,'installed-mcp.json'),'utf8'))
 managed=registry.installed.find(x=>x.id==='opensandbox')?.local
 assert.ok(managed?.containerName)
 const endpoint=registry.installed[0].endpoint
 assert.match(endpoint,/^127\.0\.0\.1:\d+$/)
 const configPath=path.join(dir,'opensandbox-local',managed.installId,'server.toml')
 const configStat=await stat(configPath)
 if(process.platform!=='win32')assert.equal(configStat.mode & 0o777,0o600)
 const cfg=await readFile(configPath,'utf8')
 assert.match(cfg,/api_key = "[a-f0-9]{64}"/)
 assert.equal(JSON.stringify(registry).includes(cfg.match(/api_key = "([a-f0-9]{64})"/)[1]),false)
 const inspect=await execFile('docker',['inspect','--format','{{json .NetworkSettings.Ports}}',managed.containerName],{timeout:14000})
 const ports=JSON.parse(inspect.stdout)
 assert.equal(ports['18088/tcp'][0].HostIp,'127.0.0.1')
 console.log('LOCAL_DOCKER_LOOPBACK_AND_SECRET_STORE_PASS')
 let sandboxId
 try {
  const created=await host.ctx.tools.callResult('mcp__opensandbox__sandbox_create',{image:process.env.SBX_TEST_OPENSANDBOX_IMAGE||'opensandbox/code-interpreter:latest',resource:{cpu:'500m',memory:'512Mi'},timeout_seconds:100,ready_timeout_seconds:45})
  assert.notEqual(created.isError,true,created.content)
  const data=created.structuredContent || JSON.parse(created.content)
  sandboxId=data.sandbox_id||data.id
  assert.match(sandboxId,/^[a-f0-9-]{20,}$/i)
  const run=await host.ctx.tools.callResult('mcp__opensandbox__command_run',{sandbox_id:sandboxId,command:'python3 -c "print(6*7)"'})
  assert.notEqual(run.isError,true,run.content)
  assert.match(JSON.stringify(run.structuredContent || run.content),/42/)
  console.log('LOCAL_DOCKER_REAL_MCP_EXEC_42_PASS')
 }finally{
  if(sandboxId){ const killed=await host.ctx.tools.callResult('mcp__opensandbox__sandbox_kill',{sandbox_id:sandboxId});assert.notEqual(killed.isError,true,killed.content);console.log('LOCAL_DOCKER_SANDBOX_DESTROY_PASS') }
 }
 await host.ctx.pluginCatalog.uninstall('opensandbox')
 managed=undefined
 const status=host.ctx.mcp.status()
 assert.equal(status.some(x=>x.name==='opensandbox'),false)
 const gone=await execFile('docker',['container','inspect',registry.installed[0].local.containerName],{timeout:8000}).then(()=>false,()=>true)
 assert.equal(gone,true)
 const creds=await readFile(path.join(dir,'credentials.json'),'utf8')
 assert.ok(!creds.includes('plugin.opensandbox'))
 console.log('LOCAL_DOCKER_UNINSTALL_REMOVES_CONTAINER_AND_KEY_PASS')
 console.log('LOCAL_DOCKER_FULL_E2E_PASS')
}finally{
 if(host){try{if(managed)await host.ctx.pluginCatalog.uninstall('opensandbox')}catch(e){console.error('CHECK TEST CONTAINER CLEANUP:',e.message)} await host.dispose()}
 await rm(dir,{recursive:true,force:true})
}
