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
const catalogRows=[
  {id:'agnes-3.0-flash',botconnector_name:'Agnes 3.0 Flash',botconnector_family:'Agnes',
    botconnector_access:'free',botconnector_context_limit_tokens:128000,
    botconnector_capabilities:{tools:'supported'},botconnector_funding:{available_now:true}},
  {id:'claude-sonnet-5-5',botconnector_name:'Claude Sonnet 5.5',botconnector_family:'Anthropic',
    botconnector_access:'plan',botconnector_capabilities:{tools:'supported'},
    botconnector_funding:{available_now:true}},
  {id:'no-tools',botconnector_capabilities:{tools:'unknown'},botconnector_access:'free'},
  {id:'unavailable',botconnector_capabilities:{tools:'supported'},botconnector_funding:{available_now:false}},
  {id:'unsafe<script>',botconnector_capabilities:{tools:'supported'}},
  {id:'agnes-3.0-flash',botconnector_capabilities:{tools:'supported'}}
]
const models = await agent.listModels(key,{request:async (url,opts)=>{
  assert.equal(url,'https://api.botconnector.id/v1/models')
  assert.equal(opts.method,'GET')
  assert.equal(opts.headers.authorization,'Bearer '+key)
  return {ok:true,json:async()=>({object:'list',data:catalogRows})}
}})
assert.deepEqual(models.map(m=>m.id),['agnes-3.0-flash','claude-sonnet-5-5'])
assert.equal(models[0].name,'Agnes 3.0 Flash')
assert.equal(models[0].context,128000)
assert.equal(models[0].access,'free')
assert.equal(models[1].access,'plan')
await assert.rejects(()=>agent.listModels(key,{request:async()=>({ok:false,status:401})}),/API key/)
assert.equal(models.some(m=>m.id==='no-tools'),false,'Unknown tool capability must never be shown')
console.log('PASS searchable model picker source: authenticated live catalog schema, free/plan labels, verified tools only')
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
// A token such as "Establish" must never trigger page data transmission
// because it happens to contain the substring "tab".
let unintendedReads=0
const plain=await agent.run({config:stored.cloudConfig,question:'Establish a deployment plan',
  request:async()=>({ok:true,json:async()=>({choices:[{message:{content:'Draft plan'}}]})}),
  runTool:async()=>{unintendedReads++;return {ok:true}},approveAction:async()=>false})
assert.equal(unintendedReads,0,'Unrelated prompts do not transmit page snapshots')
assert.equal(plain.text,'Draft plan')
// Stop or key removal during approval must prevent the deferred click.
const lateAbort=new AbortController()
let afterStopClicks=0
await assert.rejects(()=>agent.run({config:stored.cloudConfig,question:'click',
  request:mutation,signal:lateAbort.signal,
  approveAction:async()=>{lateAbort.abort();return true},
  runTool:async()=>{afterStopClicks++;return {ok:true}}}),/tidak diulang otomatis/)
assert.equal(afterStopClicks,0,'Cancelled action cannot click after approval resolves')
console.log('PASS token-aware page intent and abort-after-approval safety')