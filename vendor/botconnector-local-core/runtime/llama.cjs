const { spawn } = require('node:child_process');
let child=null; let current=null; let logLines=[];
function pushLog(line){ logLines.push(String(line)); if(logLines.length>300) logLines=logLines.slice(-300); }
function startLlama({binary,modelPath,projector=null,port=11435,gpuLayers=999,context=8192,embedding=false,jinja=true,apiKey=null}){
  if(child) throw new Error('Local runtime already running');
  if(!binary||!modelPath) throw new Error('binary and modelPath are required');
  const args=['-m',modelPath,'--host','127.0.0.1','--port',String(port),'--ctx-size',String(context),'--n-gpu-layers',String(gpuLayers)];
  if(projector) args.push('--mmproj',projector);
  if(embedding) args.push('--embeddings');
  if(jinja && !embedding) args.push('--jinja');
  if(apiKey) args.push('--api-key',String(apiKey));
  logLines=[];
  child=spawn(binary,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  current={pid:child.pid,modelPath,projector,binary,port,context,gpuLayers,embedding,auth:Boolean(apiKey),args:apiKey?args.map(a=>a===apiKey?'***':a):args,startedAt:new Date().toISOString()};
  child.stdout.on('data',d=>String(d).split(/\r?\n/).filter(Boolean).forEach(pushLog));
  child.stderr.on('data',d=>String(d).split(/\r?\n/).filter(Boolean).forEach(pushLog));
  child.once('error',e=>pushLog(`ERROR: ${e.message}`));
  child.once('exit',(code,signal)=>{pushLog(`EXIT code=${code} signal=${signal}`); child=null; current=null;});
  return {pid:child.pid,args,modelPath,port};
}
function stopLlama(){if(!child)return false; child.kill(); child=null; current=null; return true;}
function status(){return child?{running:true,...current,logs:logLines.slice(-80)}:{running:false,logs:logLines.slice(-80)};}
function logs(){return logLines.slice(-300);}
module.exports={startLlama,stopLlama,status,logs};
