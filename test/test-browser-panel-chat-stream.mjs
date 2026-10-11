import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createHost } from '../dist/index.js';

const panelSource=readFileSync('browser-extension/panel.js','utf8');
const panelHtml=readFileSync('browser-extension/panel.html','utf8');
assert.match(panelSource,/api\/approvals['"]?/, 'side panel must poll backend action approvals');
assert.match(panelSource,/item\.sessionId === activeTaskSession/, 'only the active chat session approval is shown');
assert.match(panelSource,/api\/approvals\/['"] \+ encodeURIComponent\(id\)/, 'side panel must settle the matching approval');
assert.match(panelHtml,/option value="auto" selected/, 'Auto is the default in the modern browser side panel');
for (const mode of ['manual', 'auto', 'skip']) assert.match(panelHtml,new RegExp(`option value="${mode}"`),`${mode} action mode is available`);
assert.match(panelHtml,/skip automatic checks/i,'Skip explains that it disables automatic checks');
assert.match(panelSource,/ask_every_time.*manual|manual.*ask_every_time/i,'legacy Manual mode is migrated');
assert.match(panelSource,/auto_safe.*auto|auto.*auto_safe/i,'legacy Auto mode is migrated');

const randomPort=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p};
const provider=http.createServer((req,res)=>{
 req.resume();
 req.on('end',()=>{
  if(req.url?.includes('/models')){
   res.writeHead(200,{'content-type':'application/json'});
   return res.end(JSON.stringify({object:'list',data:[{id:'mock-browser-model',object:'model'}]}));
  }
  if(req.url?.includes('/chat/completions')){
   const response=[
    'data: '+JSON.stringify({choices:[{index:0,delta:{content:'Browser agent response OK'}}]}),
    'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:11,completion_tokens:4}}),
    'data: [DONE]','',''
   ].join('\n\n');
   res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8'});
   return res.end(response);
  }
  res.writeHead(404);res.end();
 });
});
await new Promise(r=>provider.listen(0,'127.0.0.1',r));
const token=randomBytes(24).toString('hex');
const host=await createHost({
 llm:{baseURL:'http://127.0.0.1:'+provider.address().port+'/v1',apiKey:'test',defaultModel:'mock-browser-model',retries:0},
 sessions:{dir:'',load:false},
 metrics:{persist:'',load:false},
 approval:{mode:'off'},
 browser:{port:await randomPort(),token},
 web:{enabled:true,port:0,token:randomBytes(24).toString('hex')}
});
try{
 const {url}=await host.ctx.web.ready();
 const origin='chrome-extension://'+'b'.repeat(32);
 const response=await fetch(url+'api/chat',{method:'POST',headers:{
   origin,authorization:'Bearer '+token,'content-type':'application/json'
 },body:JSON.stringify({prompt:'Say hello in one sentence',preset:'browser',model:'mock-browser-model'})});
 assert.equal(response.status,200);
 assert.equal(response.headers.get('access-control-allow-origin'),origin);
 const body=await response.text();
 const events=body.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
 assert.ok(events.some(x=>x.type==='session'),'side panel gets a session');
 const final=events.find(x=>x.type==='final');
 assert.ok(final,'side panel gets a final event');
 assert.match(String(final.content),/Browser agent response OK/);
 console.log('PASS extension-origin authenticated POST /api/chat streams a real agent final response');
}finally{
 await host.dispose();
 await new Promise(r=>provider.close(r));
}
console.log('=== Side panel direct chat stream PASSED ===');
