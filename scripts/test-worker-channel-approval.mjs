import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'
import { createChatCore } from '../dist/channels/core.js'
const dir=await mkdtemp(path.join(tmpdir(),'sbx-worker-approval-'))
const host=await createHost({llm:{baseURL:'http://127.0.0.1:9/v1',defaultModel:'stub',retries:0},settings:{dir:''},sessions:{dir:''},metrics:{persist:'',load:false},approval:{mode:'risky',timeoutMs:1000}})
const questions=[]
const core=createChatCore(host.ctx,{name:'fixture',say:async()=>'',edit:async()=>{},remove:async()=>{},typing:async()=>{},askApproval:async(chat,id,text)=>{questions.push({chat,id,text});return'question'}},{mapFile:path.join(dir,'map.json'),title:'Fixture'})
try{
  await core.handleText('allowed-chat','/new')
  const parent=host.ctx.sessions.list()[0]
  const child=host.ctx.sessions.create({kind:'subagent',parentSessionId:parent.id})
  const promise=host.ctx.approvals.request('write_file',{path:'file',content:'text'},child.id)
  await new Promise(r=>setImmediate(r))
  assert.equal(questions.length,1,'worker approval is routed through its parent channel')
  assert.equal(questions[0].chat,'allowed-chat')
  assert.equal(core.decide(questions[0].id,'other-chat','y'),'unknown','another chat cannot approve the worker')
  assert.equal(core.decide(questions[0].id,'allowed-chat','n'),'done')
  assert.equal(await promise,'rejected')
  console.log('worker-channel-approval: OK')
}finally{core.dispose();await host.dispose();await new Promise(r=>setTimeout(r,20));await rm(dir,{recursive:true,force:true})}
