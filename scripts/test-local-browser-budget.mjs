/** Local Browser GGUF context envelope: real HTTP adapter, no provider cloud or browser permission change. */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'
import { connectBotConnectorLocal } from '../dist/services/botconnector-local.js'

const oldPort = process.env.SWITCHBOARD_LOCAL_CORE_PORT
const oldKey = process.env.BOTCONNECTOR_LOCAL_API_KEY
delete process.env.BOTCONNECTOR_LOCAL_API_KEY
const requests = []
let cloudCalls = 0
const local = http.createServer(async (req, res) => {
  if (req.url === '/health') return res.writeHead(200, {'content-type':'application/json'}).end('{"ok":true}')
  if (req.url === '/v1/models') return res.writeHead(200, {'content-type':'application/json'}).end('{"data":[{"id":"qa-local-gguf"}]}')
  if (req.url === '/v1/chat/completions') {
    let body = ''
    for await (const c of req) body += c
    const payload=JSON.parse(body)
    requests.push(payload)
    if(payload.model==='qa-local-redirect') {
      res.writeHead(307, {location:'http://127.0.0.1:'+cloud.address().port+'/v1/chat/completions'}).end()
      return
    }
    res.writeHead(200, {'content-type': 'text/event-stream'})
    res.end('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Local only."},"finish_reason":"stop"}]}\\n\\ndata: [DONE]\\n\\n'.replaceAll('\\n','\n'))
    return
  }
  res.writeHead(404).end()
})
const cloudRequests = []
const cloud = http.createServer((req,res) => { cloudRequests.push(req.method+' '+req.url); if(req.method==='POST') cloudCalls++; res.writeHead(500).end('CLOUD_NOT_ALLOWED') })
await new Promise(r => local.listen(0,'127.0.0.1',r))
await new Promise(r => cloud.listen(0,'127.0.0.1',r))
process.env.SWITCHBOARD_LOCAL_CORE_PORT = String(local.address().port)
const tmp = await mkdtemp(path.join(os.tmpdir(),'sbx-local-browser-budget-'))
let host
try {
  host = await createHost({
    llm: { baseURL:'http://127.0.0.1:'+cloud.address().port+'/v1', defaultModel:'would-be-cloud', fallbacks:[{provider:'default',model:'would-be-cloud'}], retries:0 },
    agent: {maxSteps:2, maxTokens:512, maxPromptTokens:96000, maxToolResultChars:24000},
    settings:{dir:path.join(tmp,'settings')}, sessions:{dir:path.join(tmp,'sessions'),load:false},metrics:{persist:'',load:false},
    tools:{shell:{disabled:true}}, browser:{host:'127.0.0.1',port:0,defaultMode:'skip'}
  })
  await connectBotConnectorLocal(host.ctx.providers,'qa-local-gguf')
  const s=host.ctx.sessions.create({title:'local browser context test',preset:'browser',model:'qa-local-gguf',provider:'local-botconnector'})
  // A long preceding exchange must not force a new local inference request out of budget.
  for (let n=0; n<4; n++) host.ctx.sessions.append(s.id,{role:'user',content:'Previous context '+n+' '+'.'.repeat(3200)})
  const events=[]
  for await(const ev of host.ctx.agent.stream('Read the active tab and answer concisely.',s.id,{preset:'browser',maxSteps:2,provider:'local-botconnector'})) events.push(ev.type)
  assert.ok(events.includes('final'), 'mock local response should finish a turn')
  assert.equal(requests.length,1)
  assert.equal(requests[0].max_tokens,192,'small-context local browser must reserve completion space')
  assert.ok(requests[0].tools.some(t=>t.function.name==='browser_click'),'tool capabilities remain available')
  assert.ok(requests[0].tools.some(t=>t.function.name==='browser_dom_snapshot'))
  assert.ok(requests[0].messages.find(m=>m.role==='system'),'system instructions preserved')
  assert.ok(requests[0].messages.some(m=>m.role==='user'&&m.content.includes('Read the active tab')),'latest intent retained')
  assert.ok(requests[0].messages.length<7,'stale long history must be trimmed')
  assert.equal(cloudCalls,0,'no remote fallback allowed')
  console.log('LOCAL_GGUF_BROWSER_BUDGET_CONTRACT_PASS output<=192, trimmed history, tools intact, cloudCalls=0')
  // A redirect originating from the local inference endpoint must NOT forward
  // private prompt contents to a remote or differently configured provider.
  await assert.rejects(host.ctx.llm.generate({provider:'local-botconnector',model:'qa-local-redirect',messages:[{role:'user',content:'NEVER REDIRECT LOCAL PROMPT'}]}))
  assert.equal(cloudCalls,0,'local HTTP redirect leaked to Cloud')
  console.log('LOCAL_REDIRECT_FAIL_CLOSED_PASS cloudCalls=0')
  // Regression: disconnect during an existing local session must NOT silently
  // re-resolve its explicit local provider to the virtual default Cloud profile.
  await host.ctx.providers.remove('local-botconnector')
  const localRequest={provider:'local-botconnector',model:'qa-local-gguf',messages:[{role:'user',content:'PRIVATE LOCAL ONLY'}]}
  await assert.rejects(host.ctx.llm.generate(localRequest),/BotConnector Local.*Cloud fallback is disabled/)
  assert.equal(cloudCalls,0,'disconnect caused Cloud POST')
  // A saved provider reusing the reserved local id cannot redirect local input
  // to another endpoint: fail closed before any HTTP request is issued.
  await host.ctx.providers.create({id:'local-botconnector',displayName:'tampered local',baseURL:'http://127.0.0.1:'+cloud.address().port+'/v1',protocol:'openai-chat',models:[{id:'qa-local-gguf'}]})
  await assert.rejects(host.ctx.llm.generate(localRequest),/BotConnector Local.*Cloud fallback is disabled/)
  assert.equal(cloudCalls,0,'reconfigured local provider caused Cloud POST')
  console.log('LOCAL_PROVIDER_DISCONNECT_AND_HIJACK_FAIL_CLOSED_PASS cloudCalls=0')
} finally {
  try{await host?.dispose()}catch{}
  await new Promise(r=>local.close(r));await new Promise(r=>cloud.close(r))
  await rm(tmp,{recursive:true,force:true})
  if(oldPort===undefined) delete process.env.SWITCHBOARD_LOCAL_CORE_PORT
  else process.env.SWITCHBOARD_LOCAL_CORE_PORT=oldPort
  if(oldKey===undefined) delete process.env.BOTCONNECTOR_LOCAL_API_KEY
  else process.env.BOTCONNECTOR_LOCAL_API_KEY=oldKey
}
