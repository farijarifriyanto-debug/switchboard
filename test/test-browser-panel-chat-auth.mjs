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
 const state=await auth.json();
 assert.ok(state.browserCompanion,'authorized extension receives browser-scoped state');
 assert.equal(state.endpoint,undefined,'companion token cannot read the console endpoint/provider settings');
 assert.equal(state.tools,undefined,'companion token cannot enumerate the full tool surface');
 assert.ok(Array.isArray(state.sessions),'companion sees only browser-scoped sessions');
 console.log('PASS extension bearer receives browser-scoped state, not the full console');
 const evil=await fetch(url+'api/state',{headers:{origin:'https://evil.example',authorization:'Bearer '+bearer}});
 assert.equal(evil.status,401,'forged website origin not whitelisted by extension CORS exception');
 console.log('PASS browser web origin is rejected even if bridge bearer supplied');

 const browserSession=host.ctx.sessions.create({title:'Browser approval session',preset:'browser'});
 const consoleSession=host.ctx.sessions.create({title:'Console session'});
 const forbiddenPreset=await fetch(url+'api/chat',{method:'POST',headers:{origin,authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify({prompt:'hello',preset:'default'})});
 assert.equal(forbiddenPreset.status,403,'companion token cannot start a non-browser preset chat');
 const forbiddenSession=await fetch(url+'api/chat',{method:'POST',headers:{origin,authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify({prompt:'hello',sessionId:consoleSession.id})});
 assert.equal(forbiddenSession.status,403,'companion token cannot continue a console session');
 console.log('PASS companion chat is forced to the browser preset and browser sessions');

 const approvalWait=host.ctx.approvals.request('browser_type',{
   selector:'#pesan', targetOrigin:'https://example.org',
 },browserSession.id);
 await new Promise(resolve=>setImmediate(resolve));
 const pending=host.ctx.approvals.pending()[0];
 assert.ok(pending,'test approval is pending before the extension decision');
 const consoleApprovalWait=host.ctx.approvals.request('run_command',{command:'echo should-not-be-visible'},consoleSession.id);
 await new Promise(resolve=>setImmediate(resolve));
 const consolePending=host.ctx.approvals.pending().find((approval)=>approval.sessionId===consoleSession.id);
 assert.ok(consolePending,'a shell approval from a console session is pending');
 const scopedApprovals=await (await fetch(url+'api/approvals',{headers:{origin,authorization:'Bearer '+bearer}})).json();
 assert.equal(scopedApprovals.pending.some((approval)=>approval.id===consolePending.id),false,'companion cannot list non-browser approvals');
 const crossDecide=await fetch(url+'api/approvals/'+encodeURIComponent(consolePending.id),{method:'POST',headers:{origin,authorization:'Bearer '+bearer,'content-type':'application/json'},body:JSON.stringify({decision:'approved'})});
 assert.equal(crossDecide.status,404,'companion cannot settle a non-browser approval');
 host.ctx.approvals.decide(consolePending.id,'rejected');
 await consoleApprovalWait;
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
 // Real MV3 Chrome can omit Origin on a CORS-exempt extension GET.
 // Still require a paired bearer; do not generalize this to state/mutations.
 const noOrigin=await fetch(url+'api/approvals',{headers:{authorization:'Bearer '+bearer}});
 assert.equal(noOrigin.status,200,'paired read-only approvals listing works without Origin');
 assert.equal((await noOrigin.json()).pending[0].id,pending.id);
 const deniedNoOrigin=await fetch(url+'api/approvals',{headers:{authorization:'Bearer wrong'}});
 assert.equal(deniedNoOrigin.status,401,'wrong bearer without Origin cannot list approvals');
 const deniedWebsite=await fetch(url+'api/approvals',{headers:{origin:'https://evil.example',authorization:'Bearer '+bearer}});
 assert.equal(deniedWebsite.status,401,'untrusted website cannot impersonate extension approval reader');
 const deniedWrite=await fetch(url+approvalPath,{method:'POST',headers:{
   authorization:'Bearer '+bearer,'content-type':'application/json'
 },body:JSON.stringify({decision:'approved'})});
 assert.equal(deniedWrite.status,401,'no-Origin write may not use the extension GET exception');
 assert.equal(host.ctx.approvals.pending()[0].id,pending.id,'no-Origin write did not approve');
 console.log('PASS MV3 Origin-less GET accepts paired bearer only; no POST bypass');

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
