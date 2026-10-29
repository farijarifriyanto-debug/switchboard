import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const source=readFileSync(new URL('../browser-extension/cloud-agent.js',import.meta.url),'utf8')
const box={console,DOMException,fetch:()=>{throw Error('unexpected live network')}}
box.globalThis=box
vm.runInNewContext(source,box)
const agent=box.SwitchboardCloud
const stored={}
const storage={
  setAccessLevel:async v=>{stored.access=v.accessLevel},
  set:async v=>{Object.assign(stored,v)}
}
const key='fake-standalone-test-key'
await agent.saveConfig(storage,{provider:'botconnector',model:'agnes-3.0-flash',apiKey:key,enabled:true})
assert.equal(stored.cloudConfig.apiKey,key)
assert.equal(stored.access,'TRUSTED_CONTEXTS')
await assert.rejects(()=>agent.saveConfig(storage,{provider:'other',model:'agnes-3.0-flash',apiKey:key}),/valid/i)
let calls=0,toolCalls=0,toolResult
const messages=[]
const mock=async (url,opts)=>{
  calls++
  assert.equal(url,'https://api.botconnector.id/v1/chat/completions')
  assert.equal(opts.headers.authorization,'Bearer '+key)
  const req=JSON.parse(opts.body)
  assert.equal(req.model,'agnes-3.0-flash')
  assert.ok(req.tools.some(x=>x.function.name==='browser_dom_snapshot'))
  assert.equal(req.stream,false)
  assert.equal(req.messages[0].role,'system')
  if(calls===1)return {ok:true,json:async()=>({choices:[{message:{content:null,tool_calls:[
    {id:'call_qa1',type:'function',function:{name:'browser_dom_snapshot',arguments:'{}'}}
  ]}}]})}
  assert.equal(req.messages.at(-1).role,'tool')
  assert.match(req.messages.at(-1).content,/PAGE_TITLE_123/)
  return {ok:true,json:async()=>({choices:[{message:{role:'assistant',content:'Ringkasan berdasarkan PAGE_TITLE_123'}}]})}
}
const result=await agent.run({config:stored.cloudConfig,question:'Ringkas halaman ini',
  currentTab:{origin:'https://example.com'},
  runTool:async name=>{assert.equal(name,'browser_dom_snapshot');toolCalls++;return {ok:true,title:'PAGE_TITLE_123'}},
  approveAction:async()=>{throw Error('read-only should not prompt')},request:mock,
  onEvent:e=>messages.push(e)
})
assert.equal(result.toolsUsed,2)
assert.equal(toolCalls,2)
assert.equal(calls,2)
assert.match(result.text,/PAGE_TITLE_123/)
assert.deepEqual(messages.map(x=>x.type),['tool_call','tool_result','tool_call','tool_result','final'])
assert.equal(JSON.stringify(messages).includes(key),false)
console.log('PASS cloud standalone direct HTTPS fixed origin, tool result evidence, no local bridge')
const mutation=async()=>({ok:true,json:async()=>({choices:[{message:{content:null,tool_calls:[
  {id:'danger1',type:'function',function:{name:'browser_click',arguments:'{"selector":"#pay"}'}}
]}}]})})
let mutate=0
await assert.rejects(()=>agent.run({config:stored.cloudConfig,question:'click',
  request:mutation,approveAction:async()=>false,runTool:async()=>{mutate++;return {ok:true}}}),/tidak diulang otomatis/)
assert.equal(mutate,0)
console.log('PASS denied mutation never executed or automatically retried')
let clicked=0
await assert.rejects(()=>agent.run({config:stored.cloudConfig,question:'click',
  request:mutation,approveAction:async()=>true,runTool:async()=>{clicked++;return {ok:false,error:'uncertain click'}}}),/tidak diulang otomatis/)
assert.equal(clicked,1,'No duplicate browser click on uncertain tool outcome')
const failedAuth=async()=>({ok:false,status:401})
await assert.rejects(()=>agent.run({config:stored.cloudConfig,question:'test',request:failedAuth}),/API key ditolak/)
const failedRate=async()=>({ok:false,status:429})
await assert.rejects(()=>agent.run({config:stored.cloudConfig,question:'test',request:failedRate}),/Batas penggunaan/)
const aborted=new AbortController();aborted.abort()
await assert.rejects(()=>agent.run({config:stored.cloudConfig,question:'test',signal:aborted.signal}),/Cancelled/)
console.log('PASS direct cloud 401/429 handling, cancellation, fail-closed mutations')