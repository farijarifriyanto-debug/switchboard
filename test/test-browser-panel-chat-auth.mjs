import assert from 'node:assert/strict';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createHost } from '../dist/index.js';

async function randomPort(){
  const s=net.createServer();
  await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve)});
  const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;
}
const bearer=randomBytes(24).toString('hex');
const consoleToken=randomBytes(24).toString('hex');
const host=await createHost({
 llm:{baseURL:'http://127.0.0.1:9/v1',defaultModel:'stub',retries:0},
 sessions:{dir:'',load:false},metrics:{persist:'',load:false},
 browser:{port:await randomPort(),host:'127.0.0.1',token:bearer},
 web:{enabled:true,port:0,token:consoleToken}
});
try{
 const {url}=await host.ctx.web.ready();
 const origin='chrome-extension://'+'a'.repeat(32);
 const requestHeaders={'origin':origin,'access-control-request-method':'POST',
   'access-control-request-headers':'content-type,authorization'};
 const preflight=await fetch(url+'api/chat',{method:'OPTIONS',headers:requestHeaders});
 assert.equal(preflight.status,204,'Chrome preflight must not require bearer because it is not sent on OPTIONS');
 assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
 assert.match(preflight.headers.get('access-control-allow-headers'),/Authorization/i);
 console.log('PASS CORS preflight for the real extension origin');
 const unauth=await fetch(url+'api/state',{headers:{origin}});
 assert.equal(unauth.status,401,'extension origin without bridge token cannot read Web UI');
 console.log('PASS extension without bridge token rejected');
 const auth=await fetch(url+'api/state',{headers:{origin,authorization:'Bearer '+bearer}});
 assert.equal(auth.status,200,'authorized extension can use the Web UI agent backend');
 assert.equal(auth.headers.get('access-control-allow-origin'),origin);
 const state=await auth.json();assert.ok(state.endpoint);
 console.log('PASS extension bearer authenticates to the same Switchboard Web UI');
 const evil=await fetch(url+'api/state',{headers:{origin:'https://evil.example',authorization:'Bearer '+bearer}});
 assert.equal(evil.status,401,'forged website origin not whitelisted by extension CORS exception');
 console.log('PASS browser web origin is rejected even if bridge bearer supplied');

 const approvalWait=host.ctx.approvals.request('browser_type',{
   selector:'#pesan', targetOrigin:'https://example.org',
 },'extension-approval-test');
 await new Promise(resolve=>setImmediate(resolve));
 const pending=host.ctx.approvals.pending()[0];
 assert.ok(pending,'test approval is pending before the extension decision');
 const approvalPath='api/approvals/'+encodeURIComponent(pending.id);
 const approvalPreflight=await fetch(url+approvalPath,{method:'OPTIONS',headers:{
   origin, 'access-control-request-method':'POST',
   'access-control-request-headers':'content-type,authorization',
 }});
 assert.equal(approvalPreflight.status,204,'paired extension approval preflight must be accepted');
 assert.equal(approvalPreflight.headers.get('access-control-allow-origin'),origin);
 const approvalList=await fetch(url+'api/approvals',{headers:{origin,authorization:'Bearer '+bearer}});
 assert.equal(approvalList.status,200,'paired extension can read pending approvals');
 assert.equal((await approvalList.json()).pending[0].id,pending.id);
 const wrongBearer=await fetch(url+approvalPath,{method:'POST',headers:{
   origin,authorization:'Bearer wrong', 'content-type':'application/json',
 },body:JSON.stringify({decision:'approved'})});
 assert.equal(wrongBearer.status,401,'approval decisions require the paired extension bearer');
 assert.equal(host.ctx.approvals.pending()[0].id,pending.id,'bad bearer leaves the approval pending');
 const approved=await fetch(url+approvalPath,{method:'POST',headers:{
   origin,authorization:'Bearer '+bearer, 'content-type':'application/json',
 },body:JSON.stringify({decision:'approved'})});
 assert.equal(approved.status,200,'paired extension can settle an approval');
 assert.equal((await approved.json()).decision,'approved');
 assert.equal(await approvalWait,'approved');
 console.log('PASS extension approval preflight, bearer-gated listing, and decision settlement');
}finally{await host.dispose()}
console.log('=== Direct side panel authentication tests PASSED ===');
