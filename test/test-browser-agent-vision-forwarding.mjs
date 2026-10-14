import assert from 'node:assert/strict';
import { createHost } from '../dist/index.js';

const IMAGE='data:image/jpeg;base64,'+Buffer.alloc(2200,77).toString('base64');

async function scenario(prompt, dataUrl=IMAGE, url='http://127.0.0.1:4848/') {
  const host=await createHost({sessions:{dir:'',load:false},metrics:{persist:'',load:false},approval:{mode:'off'},agent:{maxSteps:3},tools:{shell:{disabled:true}}});
  const calls=[],events=[];
  host.ctx.tools.register({
    name:'browser_screenshot',
    description:'Capture screenshot in QA fixture',
    parameters:{type:'object',properties:{}},
    preflight:async()=>({verdict:'continue',reason:'QA only'}),
    execute:async()=>JSON.stringify({ok:true,url,dataUrl}),
  });
  host.ctx.llm.stream=async function* (options){
    calls.push(structuredClone(options.messages));
    const first=calls.length===1;
    yield {type:'done',result:{
      model:'vision-fixture',content:first?'':'Vision fixture finished',
      reasoning:'',toolCalls:first?[{id:'test-image-1',type:'function',function:{name:'browser_screenshot',arguments:'{}'}}]:[],
      usage:{},ttftMs:0,totalMs:0,tokensPerSec:0,
    }};
  };
  try{
    const session=host.ctx.sessions.create({title:'visual unit QA'});
    for await(const e of host.ctx.agent.stream(prompt,session.id))events.push(e);
    const stored=host.ctx.sessions.require(session.id).messages;
    return {calls,events,stored};
  }finally{await host.dispose();}
}

const allowed=await scenario('Please take a screenshot and read the code from the image.');
assert.equal(allowed.calls.length,2);
assert.equal(allowed.calls[1].at(-1).role,'user');
assert.equal(allowed.calls[1].at(-1).attachments[0].dataUrl,IMAGE);
assert.equal(allowed.stored.some(x=>JSON.stringify(x).includes(IMAGE.slice(0,120))),false);
assert.equal(allowed.events.some(x=>JSON.stringify(x).includes(IMAGE.slice(0,120))),false);
assert.match(allowed.events.find(x=>x.type==='tool_result').result,/ephemeral, untrusted image/);
console.log('PASS vision screenshot forwarded as transient model input, omitted from transcript, SSE and trace');

const forbidden=await scenario('Read the harmless local text on this page.');
assert.equal(forbidden.calls[1].some(x=>x.attachments?.length),false);
assert.match(forbidden.events.find(x=>x.type==='tool_result').result,/explicit visual request/);
console.log('PASS no screenshots forwarded without explicit user visual intent');

for(const [name,img,origin] of [
  ['wrong-scheme',IMAGE,'file:///etc/passwd'],
  ['too-large','data:image/jpeg;base64,'+Buffer.alloc(5_300_000,12).toString('base64'),'http://127.0.0.1:4848/'],
  ['invalid-data','data:image/jpeg;base64,<not-base64>','http://127.0.0.1:4848/'],
]){
 const bad=await scenario('Look at screenshot.',img,origin);
 assert.equal(bad.calls[1].some(x=>x.attachments?.length),false,name);
 assert.match(bad.events.find(x=>x.type==='tool_result').result,/could not be validated/,name);
 console.log('PASS '+name+' image fails closed');
}
console.log('VISION TOOL PIPELINE CONTRACT PASS');
