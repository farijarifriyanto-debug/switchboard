import assert from 'node:assert/strict'
import path from 'node:path'
import { createHost } from '../dist/index.js'
import { renderMcpResult } from '../dist/mcp/render.js'
import { startFakeMcpHttp } from '../test/fixtures/fake-mcp-http.mjs'
import { makeExtendedServer } from '../test/fixtures/mcp-extended.mjs'
import { listPages } from '../dist/mcp/capabilities.js'

assert.match(renderMcpResult({content:[],structuredContent:{value:42}}),/"value":42/,'structured-only result reaches the model')
await assert.rejects(listPages(async()=>({resources:[],nextCursor:'same'}),'resources'),/repeated a cursor/)
assert.ok(renderMcpResult({structuredContent:{large:'x'.repeat(40000)}}).length<32100,'rendered structured data is bounded')
const logs=[];renderMcpResult({structuredContent:{secret:'do-not-log'}},s=>logs.push(s));assert.ok(!logs.join('').includes('do-not-log'))
const base={llm:{baseURL:'http://127.0.0.1:9/v1',defaultModel:'stub',retries:0},settings:{dir:''},sessions:{dir:''},metrics:{persist:'',load:false},approval:{mode:'off'}}
const fixture=path.resolve('test/fixtures/mcp-extended.mjs')
async function check(host,name){
  const p=`mcp__${name}__`,call=(n,a={})=>host.ctx.tools.call(p+n,a)
  assert.deepEqual((await host.ctx.tools.callResult(p+'structured',{})).structuredContent,{value:42})
  const mixed=await host.ctx.tools.callResult(p+'mixed',{});assert.equal(mixed.content,'human answer');assert.deepEqual(mixed.structuredContent,{value:42})
  assert.equal((await host.ctx.tools.callResult(p+'failing',{})).isError,true)
  assert.match(await call('failing'),/^Error:.*structured failure/)
  assert.ok(host.ctx.tools.get(p+'slow'),'tools pagination is followed')
  const list=await host.ctx.tools.callResult(p+'list_resources',{})
  assert.equal(list.structuredContent.resources.length,2,'resource pagination followed')
  assert.match(await call('read_resource',{uri:'memo://first'}),/resource text/)
  assert.match(await call('read_resource',{uri:'memo://binary'}),/omitted/)
  assert.ok(!String(await call('read_resource',{uri:'memo://binary'})).includes('AAA='),'binary is not put in model context')
  assert.match(await call('read_resource',{uri:'not a uri'}),/^Error:/)
  assert.match(await call('list_resource_templates'),/uriTemplate/)
  assert.match(await call('get_prompt',{name:'review',arguments:{topic:'billing'}}),/Review billing/)
  assert.match(await call('get_prompt',{name:'review',arguments:{topic:'line 1\nline 2'}}),/line 1\nline 2/,'multiline prompt inputs are preserved')
  assert.match(await call('get_prompt',{name:'review',arguments:{topic:42}}),/^Error:/)
  assert.match(await call('list_prompts'),/review/)
  await call('change')
  assert.match(await call('list_resources'),/updated/,'resource changes are fetched fresh')
  const ac=new AbortController(); const slow=host.ctx.tools.call(p+'slow',{},{signal:ac.signal});ac.abort();assert.match(await slow,/Error:/)
  assert.match(await host.ctx.tools.call(p+'list_resources',{},{deny:[p+'list_resources']}),/not available/)
  const s=host.ctx.sessions.create(); const preset=host.ctx.presets.resolve('reviewer',host.ctx.tools.list().map(t=>t.name));
  assert.ok(preset.excludeTools.includes(p+'read_resource'),'reviewer does not gain remote resources')
  host.ctx.approvals.setMode('all')
  const promise=host.ctx.tools.call(p+'list_prompts',{},{sessionId:s.id})
  await new Promise(r=>setImmediate(r))
  const pending=host.ctx.approvals.pending();assert.equal(pending.length,1,'bridged reads honor approval:all')
  host.ctx.approvals.decide(pending[0].id,'rejected');assert.match(await promise,/operator rejected/)
}
const stdio=await createHost({...base,mcp:{servers:{ext:{transport:'stdio',command:process.execPath,args:[fixture]}}}})
try {await check(stdio,'ext')}finally{await stdio.dispose()}
const httpState={changed:false}
const http=startFakeMcpHttp(()=>makeExtendedServer({state:httpState}));await http.listen()
const remote=await createHost({...base,mcp:{servers:{remote:{transport:'streamable-http',url:http.url()}}}})
try{await check(remote,'remote')}finally{await remote.dispose();await http.close()}
const tools=await createHost({...base,mcp:{servers:{only:{transport:'stdio',command:process.execPath,args:[fixture,'--tools-only']}}}})
try{assert.ok(!tools.ctx.tools.get('mcp__only__list_resources'),'unsupported capability is not advertised')}finally{await tools.dispose()}
const collision=await createHost({...base,mcp:{servers:{bad:{transport:'stdio',command:process.execPath,args:[fixture,'--collision'],reconnect:{enabled:false}}}}})
try{assert.equal(collision.ctx.mcp.status()[0].state,'down','bridge collision rejected without breaking host');assert.match(collision.ctx.mcp.status()[0].lastError,/duplicate|collision/)}finally{await collision.dispose()}
console.log('mcp-extended: OK (structured results, resources/templates/prompts, pagination, both transports, capability and policy checks)')
