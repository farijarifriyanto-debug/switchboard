/**
 * Real sbx web bootstrap smoke: Web UI and Browser Companion bridge
 * must both start with a persistent local pairing secret.
 * Uses dynamic ports and an isolated temp HOME; no external provider calls.
 */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root=path.resolve('.');
const home=await mkdtemp(path.join(os.tmpdir(),'sbx-web-browser-'));
const openPort=async()=>{
 const socket=net.createServer();
 await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve)});
 const port=socket.address().port;
 await new Promise(resolve=>socket.close(resolve));
 return port;
};
const webPort=await openPort();
const bridgePort=await openPort();
const configPath=path.join(home,'config.jsonc');
await writeFile(configPath,JSON.stringify({browser:{port:bridgePort},web:{host:'127.0.0.1'}}));
const child=spawn(process.execPath,['dist/cli.js','web','--no-open','--port',String(webPort),'-c',configPath],{
 cwd:root,env:{...process.env,HOME:home,USERPROFILE:home,BOTCONNECTOR_API_KEY:'unused-during-boot-test'},
 stdio:['ignore','pipe','pipe'],windowsHide:true,
});
let output='';
child.stdout.on('data',v=>{output+=v.toString()});
child.stderr.on('data',v=>{output+=v.toString()});
const started=Date.now();
let ok=false,reason='';
try{
 let pairCode;
 while(Date.now()-started<20000){
  pairCode=/Browser Companion pairing code[^:\n]*:\s*(?:\x1b\[[0-9;]*m)*([A-HJ-NP-Z2-9]{8})/.exec(output)?.[1];
  if(pairCode)break;
  if(child.exitCode!==null)throw Error('sbx web exited unexpectedly');
  await new Promise(r=>setTimeout(r,200));
 }
 assert.ok(pairCode,'sbx web did not print a short pairing code');
 const tokenFile=path.join(home,'.switchboard','browser-companion-token');
 const token=(await readFile(tokenFile,'utf8')).trim();
 assert.match(token,/^[a-f0-9]{48}$/,'web boots persistent local pairing token');
 let webReady=false,bridgeReady=false;
 for(let retry=0;retry<60;retry++){
  const a=await fetch('http://127.0.0.1:'+webPort+'/',{signal:AbortSignal.timeout(900)}).catch(()=>null);
  const b=await fetch('http://127.0.0.1:'+bridgePort+'/api/browser-companion/state',{
   headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(900)
  }).catch(()=>null);
  webReady=Boolean(a?.ok);bridgeReady=Boolean(b?.ok);
  if(webReady&&bridgeReady)break;
  await new Promise(r=>setTimeout(r,150));
 }
 assert.ok(webReady,'Web UI did not start');
 assert.ok(bridgeReady,'Browser Companion localhost bridge did not start');
 const pair=await fetch('http://127.0.0.1:'+bridgePort+'/api/browser-companion/pair',{
  method:'POST',headers:{'content-type':'application/json',origin:'chrome-extension://'+'a'.repeat(32)},
  body:JSON.stringify({code:pairCode})
 });
 assert.equal(pair.status,200,'short code pairing from sbx web works');
 const data=await pair.json();
 assert.equal(data.token,token,'paired extension receives persistent token');
 const replay=await fetch('http://127.0.0.1:'+bridgePort+'/api/browser-companion/pair',{
  method:'POST',headers:{'content-type':'application/json',origin:'chrome-extension://'+'a'.repeat(32)},
  body:JSON.stringify({code:pairCode})
 });
 assert.equal(replay.status,401,'single-use code replay rejected');
 ok=true;
 console.log('PASS sbx web starts local Web UI and Browser Companion');
 console.log('PASS persistent token + one-use pairing code printed to CLI (code REDACTED)');
 console.log('PASS real HTTP Web UI / bridge / pairing handshake; ports dynamic');
}catch(err){reason=err.message;console.error('FAIL sbx web Browser Companion boot: '+reason)}
finally{
 child.kill('SIGTERM');
 await Promise.race([
  new Promise(resolve=>child.once('exit',resolve)),
  new Promise(resolve=>setTimeout(()=>{child.kill('SIGKILL');resolve()},6000))
 ]);
 await rm(home,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 if(!ok)process.exitCode=1;
}
