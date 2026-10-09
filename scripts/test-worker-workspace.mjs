import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'
const root=await mkdtemp(path.join(tmpdir(),'sbx-worker-root-'))
const a=path.join(root,'a'), b=path.join(root,'b')
await mkdir(a); await mkdir(b)
await writeFile(path.join(a,'identity'),'wrong workspace'); await writeFile(path.join(b,'identity'),'saved workspace')
const server=http.createServer(async(req,res)=>{
  if(req.url.endsWith('/models')) {res.setHeader('content-type','application/json'); res.end('{"data":[{"id":"stub"}]}');return}
  const chunks=[]; for await(const c of req) chunks.push(c)
  const body=JSON.parse(Buffer.concat(chunks).toString())
  const result=body.messages.find(m=>m.role==='tool')
  const delta=result?{content:result.content}:{tool_calls:[{index:0,id:'read-1',type:'function',function:{name:'read_file',arguments:'{"path":"identity"}'}}]}
  res.writeHead(200,{'content-type':'text/event-stream'}); res.end('data: '+JSON.stringify({choices:[{delta}]})+'\n\ndata: [DONE]\n\n')
})
server.listen(0,'127.0.0.1'); await once(server,'listening')
const host=await createHost({llm:{baseURL:`http://127.0.0.1:${server.address().port}/v1`,defaultModel:'stub',retries:0},settings:{dir:''},sessions:{dir:''},metrics:{persist:'',load:false},workspace:{root:a,remember:false},tools:{fs:{root:a},shell:{cwd:a}},approval:{mode:'off'}})
try {
  const parent=host.ctx.sessions.create({projectRoot:b})
  const result=JSON.parse(await host.ctx.tools.call('task',{tasks:[{description:'Read identity'}]},{sessionId:parent.id}))
  assert.equal(result[0].result,'saved workspace','worker uses its saved project, not current host workspace')
  assert.equal(await host.ctx.tools.call('run_command',{command:'cat identity'},{workspace:b}),'saved workspace','shell uses explicit session workspace')
  assert.match(await host.ctx.tools.call('read_file',{path:'../a/identity'},{workspace:b}),/Error:/,'session workspace stays confined')
  console.log('worker-workspace: OK')
} finally {await host.dispose(); server.closeAllConnections(); await new Promise(r=>server.close(r)); await rm(root,{recursive:true,force:true})}
