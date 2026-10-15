const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');

function pidAlive(pid){if(!Number.isInteger(Number(pid))||Number(pid)<=0)return false;try{process.kill(Number(pid),0);return true;}catch{return false;}}
// Process state is ephemeral and shared by GUI/CLI on this machine. Keeping it
// in temp avoids mutating legacy state files owned by older installations and
// works on managed profiles that deny new files below Electron userData.
function statePath(){return process.env.BOTCONNECTOR_RUNTIME_STATE||path.join(os.tmpdir(),'botconnector-ai-local-cloud-runtime-process.json');}
async function readOwnership(file){try{return JSON.parse(await fsp.readFile(file,'utf8'));}catch{return null;}}
async function writeAtomic(file,value){const data=JSON.stringify(value,null,2);const tmp=`${file}.tmp-${process.pid}-${Date.now()}`;try{await fsp.writeFile(tmp,data,{mode:0o600});await fsp.rename(tmp,file);}catch(error){try{await fsp.rm(tmp,{force:true});}catch{}if(error.code!=='EPERM'&&error.code!=='EACCES')throw error;await fsp.writeFile(file,data);}}

async function claimOwnership({file,ownerType,ownerPid=process.pid,port,modelPath,backend,auth=false}){
  await fsp.mkdir(path.dirname(file),{recursive:true});
  let handle;
  const lock=path.join(os.tmpdir(),'botconnector-ai-local-cloud-runtime.lock');
  try{handle=await fsp.open(lock,'wx');}
  catch(error){
    if(error.code==='EEXIST'){
      try{const owner=JSON.parse(await fsp.readFile(lock,'utf8'));if(!pidAlive(owner.pid)){await fsp.rm(lock,{force:true});handle=await fsp.open(lock,'wx');}}
      catch(retry){if(!handle)throw new Error('Runtime ownership is busy; another interface is starting or stopping the server');}
    }
    if(!handle)throw new Error('Runtime ownership is busy; another interface is starting or stopping the server');
  }
  try{
    const previous=await readOwnership(file);
    const active=previous&&(previous.childPid!=null?pidAlive(previous.childPid):pidAlive(previous.ownerPid));
    if(active&&previous.ownerPid!==ownerPid){throw new Error(`Runtime is owned by ${previous.ownerType||'another process'} (pid ${previous.ownerPid})`);}
    const next={ownerType,ownerPid:Number(ownerPid),childPid:null,pid:null,port:Number(port),modelPath,backend,auth:Boolean(auth),startedAt:new Date().toISOString()};
    await handle.truncate(0);await handle.writeFile(JSON.stringify({pid:Number(ownerPid)}));
    await writeAtomic(file,next);return next;
  }finally{try{await handle?.close();}catch{}try{await fsp.rm(lock,{force:true});}catch{}}
}

async function setChild(file,childPid,extra={}){const current=await readOwnership(file);if(!current)return null;const next={...current,childPid:Number(childPid),...extra};await writeAtomic(file,next);return next;}
async function releaseOwnership(file,ownerPid=process.pid){const current=await readOwnership(file);if(!current)return false;if(Number(current.ownerPid)!==Number(ownerPid))return false;await fsp.rm(file,{force:true});return true;}
function isOwner(file,ownerPid=process.pid){return readOwnership(file).then(s=>Boolean(s&&Number(s.ownerPid)===Number(ownerPid)));}

module.exports={claimOwnership,readOwnership,releaseOwnership,setChild,statePath,pidAlive};
