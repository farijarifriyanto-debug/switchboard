import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import http from 'node:http'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createHost } from '../dist/index.js'

const root = await mkdtemp(path.join(tmpdir(), 'sbx-recovery-'))
const processes = new Set()
let calls = 0
let hold = false
const server = http.createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.setHeader('content-type','application/json'); res.end(JSON.stringify({data:[{id:'stub'}]})); return }
  for await (const _ of req) {}
  calls++
  if (hold) return
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end('data: '+JSON.stringify({ choices: [{ delta: { content: 'worker recovered' } }] })+'\n\ndata: [DONE]\n\n')
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const baseURL = `http://127.0.0.1:${server.address().port}/v1`
function config(dir, extra = {}) {
  return { llm: { baseURL, defaultModel: 'stub', retries: 0 }, settings: { dir: '' }, metrics: { persist: '', load: false },
    sessions: { dir, max: 1 }, workspace: { root, remember: false }, approval: { mode: 'off' },
    web: { enabled: true, port: 0 }, subagent: { autoResume: false }, ...extra }
}
const wait = async (fn) => {
  const deadline = Date.now()+10000
  while (Date.now()<deadline) { const value = await fn(); if (value) return value; await new Promise(r=>setTimeout(r,20)) }
  throw new Error('recovery wait timed out')
}
async function launch(cfg) {
  const child = fork(new URL('../test/fixtures/recovery-host.mjs', import.meta.url), [JSON.stringify(cfg)], { stdio: ['ignore','ignore','pipe','ipc'] })
  processes.add(child)
  let error = ''; child.stderr.on('data', d=>error+=d)
  const ready = await Promise.race([once(child,'message').then(([v])=>v), once(child,'exit').then(()=>{throw new Error(error)})])
  const view = async () => { const next = once(child,'message'); child.send('view'); return (await next)[0] }
  const kill = async () => { const end=once(child,'exit'); child.kill('SIGKILL'); await end; processes.delete(child) }
  const stop = async () => { const end=once(child,'exit'); child.send('stop'); await end; processes.delete(child) }
  return { child, ready, view, kill, stop }
}
async function seed(name, status, delivered=false, parentStatus='idle') {
  const dir=path.join(root,name); await mkdir(dir)
  const now=Date.now()
  const job={ jobId:'j-old',sessionId:'s-child',parentSessionId:'s-parent',description:'Recover task',task:{description:'Recover task'},status,
    ...(['done','failed'].includes(status)?{result:'saved result',finishedAt:now}:{}), delivered }
  const parent={id:'s-parent',title:'Parent',projectRoot:root,model:'stub',createdAt:now,updatedAt:now,status:parentStatus,
    messages:delivered?[{role:'user',content:'[job j-old selesai] status: ok\nsaved result'}]:[],background:{version:1,jobs:[job]}}
  const child={id:'s-child',title:'Child',projectRoot:root,model:'stub',kind:'subagent',parentSessionId:'s-parent',jobId:'j-old',createdAt:now,updatedAt:now,status:'idle',messages:[]}
  // Newer unrelated session hides parent and child under sessions.max=1.
  await Promise.all([parent,child,{...child,id:'s-newer',kind:undefined,background:undefined,updatedAt:now+10000}].map(s=>writeFile(path.join(dir,s.id+'.json'),JSON.stringify(s))))
  return dir
}
try {
  const dir=await seed('queued','queued')
  const first=await launch(config(dir))
  await wait(async()=> (await first.view()).jobs.some(j=>j.status==='done'))
  assert.equal(calls,1,'queued job survives hydration limit and executes once')
  await wait(async()=> JSON.parse(await readFile(path.join(dir,'s-parent.json'))).background.jobs[0].delivered)
  await first.kill()
  const second=await launch(config(dir))
  assert.equal(second.ready.jobs.length,1,'completed job registry survives hard restart')
  assert.equal(second.ready.sessions.find(s=>s.id==='s-parent').messages.filter(m=>m.content.startsWith('[job j-old')).length,1,'delivery does not duplicate')
  assert.equal(calls,1,'finished worker is never replayed')
  await second.stop()

  const runningDir=await seed('running','running',false,'working')
  const running=await launch(config(runningDir))
  const failed=await wait(async()=> (await running.view()).jobs.find(j=>j.status==='failed'))
  assert.match(failed.error,/restart|interrupted/)
  assert.equal(calls,1,'started worker is not automatically repeated')
  await running.stop()

  const pendingDir=await seed('pending','done',false,'waiting_approval')
  const pending=await launch(config(pendingDir))
  await wait(async()=> (await pending.view()).sessions.find(s=>s.id==='s-parent')?.messages.some(m=>m.content.includes('saved result')))
  await pending.kill()
  const pendingAgain=await launch(config(pendingDir))
  const recoveredParent=await wait(async()=> (await pendingAgain.view()).sessions.find(s=>s.id==='s-parent' && s.messages.length))
  assert.equal(recoveredParent.messages.length,1,'busy-parent recovery delivery is persisted once')
  await pendingAgain.stop()

  const readonlyDir=await seed('readonly','queued')
  const readonly=await launch(config(readonlyDir,{web:{enabled:false}}))
  assert.equal(calls,1,'one-shot boot never executes saved queue')
  await readonly.stop()
  const disabled=await launch(config(readonlyDir,{sessions:{dir:readonlyDir,load:false}}))
  assert.equal(calls,1,'load:false disables recovery'); await disabled.stop()

  hold=true
  const competingDir=await seed('competing','queued')
  const owner=await launch(config(competingDir))
  await wait(()=>calls===2)
  const competitor=await launch(config(competingDir))
  assert.equal(calls,2,'second live host cannot execute or interrupt owned work')
  await competitor.stop(); await owner.kill(); hold=false
  const reclaimed=await launch(config(competingDir))
  assert.equal(reclaimed.ready.jobs[0].status,'failed','dead process ownership can be reclaimed')
  assert.equal(calls,2,'reclaimed running work is not replayed'); await reclaimed.stop()

  const wakeDir=await seed('wake','done',true)
  const wakeFile=path.join(wakeDir,'s-parent.json')
  const wakeState=JSON.parse(await readFile(wakeFile)); wakeState.background.wakeRunning=true; wakeState.background.wakePending=true
  await writeFile(wakeFile,JSON.stringify(wakeState))
  for (let i=0;i<2;i++) {
    const wake=await launch(config(wakeDir,{subagent:{autoResume:true}}))
    await wake.stop()
    assert.equal(calls,2,'an interrupted parent wake remains blocked across successive restarts')
  }

  const liveDir=path.join(root,'live'); await mkdir(liveDir)
  hold=true
  const live=await launch(config(liveDir,{subagent:{autoResume:false,maxParallel:1}}))
  const spawned=once(live.child,'message'); live.child.send({action:'spawn'}); const [spawn]=await spawned
  assert.equal(JSON.parse(spawn.result).length,2)
  await wait(()=>calls===3)
  const saved=JSON.parse(await readFile(path.join(liveDir,spawn.parentId+'.json')))
  assert.deepEqual(saved.background.jobs.map(j=>j.status),['running','queued'],'actual dispatch checkpoint distinguishes started and queued work')
  await live.kill(); hold=false
  const restoredLive=await launch(config(liveDir,{subagent:{autoResume:false,maxParallel:1}}))
  await wait(async()=> (await restoredLive.view()).jobs.some(j=>j.status==='done'))
  assert.equal(calls,4,'hard crash resumes only the job that had not started')
  await restoredLive.stop()

  const failureHost=await createHost(config(path.join(root,'not-a-directory'),{web:{enabled:false}}))
  await writeFile(path.join(root,'not-a-directory'),'blocked')
  const parent=failureHost.ctx.sessions.create({title:'fail'})
  const result=await failureHost.ctx.tools.call('task',{tasks:[{description:'must not start'}],background:true},{sessionId:parent.id})
  assert.match(result,/Error:.*(persist|checkpoint|ENOTDIR|EEXIST)/i)
  assert.equal(calls,4,'write failure must prevent dispatch')
  await failureHost.dispose()
  console.log('recovery: OK (hard restart, no replay, idempotent delivery, ownership, checkpoint failure)')
} finally {
  for (const p of processes) p.kill('SIGKILL')
  server.closeAllConnections(); await new Promise(r=>server.close(r)); await rm(root,{recursive:true,force:true})
}
