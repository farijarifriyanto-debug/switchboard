const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {resolveUrl:resolveUrlDefault}=require('./hf.cjs');
async function sha256File(p){return await new Promise((resolve,reject)=>{const h=crypto.createHash('sha256'),rs=fs.createReadStream(p);rs.on('data',d=>h.update(d));rs.on('error',reject);rs.on('end',()=>resolve(h.digest('hex')));});}
class DownloadManager{
 constructor({getModelsDir,getToken,emit,resolveUrl}){this.jobs=new Map();this.getModelsDir=getModelsDir;this.getToken=getToken;this.emit=emit||(()=>{});this.resolveUrl=resolveUrl||resolveUrlDefault;}
 list(){return[...this.jobs.values()].map(j=>this.publicJob(j));}
 publicJob(j){const{controller,filesData,...safe}=j;return safe;}
 async ensureDir(p){await fsp.mkdir(p,{recursive:true});}
 async downloadOne({repoId,file,destDir,job}){
  const token=this.getToken?.()||'',finalPath=path.join(destDir,path.basename(file.path)),partPath=finalPath+'.part';
  try{const st=await fsp.stat(finalPath);if(!file.size||st.size===Number(file.size))return{path:finalPath,size:st.size,skipped:true};}catch{}
  let offset=0;try{offset=(await fsp.stat(partPath)).size;}catch{}
  const headers={'User-Agent':'BotConnectorAI/0.4'};if(token)headers.Authorization=`Bearer ${token}`;if(offset>0)headers.Range=`bytes=${offset}-`;
  let res=await fetch(this.resolveUrl(repoId,file.path),{headers,signal:job.controller.signal,redirect:'follow'});
  if(offset>0&&res.status!==206){offset=0;await fsp.rm(partPath,{force:true});const fresh={...headers};delete fresh.Range;res=await fetch(this.resolveUrl(repoId,file.path),{headers:fresh,signal:job.controller.signal,redirect:'follow'});}
  if(!res.ok)throw new Error(`Download ${res.status} for ${file.path}`);
  const totalHeader=Number(res.headers.get('content-length')||0)+(res.status===206?offset:0),total=Number(file.size||0)||totalHeader;
  const ws=fs.createWriteStream(partPath,{flags:offset?'a':'w'}),reader=res.body.getReader();let downloaded=offset,last=Date.now(),lastBytes=downloaded;
  while(true){const{done,value}=await reader.read();if(done)break;if(!ws.write(Buffer.from(value)))await new Promise(r=>ws.once('drain',r));downloaded+=value.byteLength;job.downloadedBytes=job.baseDownloaded+downloaded;const now=Date.now();if(now-last>=350){job.bytesPerSecond=Math.round((downloaded-lastBytes)/((now-last)/1000));last=now;lastBytes=downloaded;this.emit('download:progress',this.publicJob(job));}}
  await new Promise((resolve,reject)=>ws.end(err=>err?reject(err):resolve()));
  const expected=String(file.oid||'').toLowerCase();if(/^[0-9a-f]{64}$/.test(expected)){job.status='verifying';this.emit('download:progress',this.publicJob(job));const actual=await sha256File(partPath);if(actual!==expected){await fsp.rm(partPath,{force:true});throw new Error(`SHA256 mismatch for ${file.path}`);}}
  await fsp.rename(partPath,finalPath);return{path:finalPath,size:downloaded};
 }
 async _run(job){
  try{const installed=[];job.downloadedBytes=0;for(const file of job.filesData){job.baseDownloaded=job.downloadedBytes;installed.push(await this.downloadOne({repoId:job.repoId,file,destDir:job.destDir,job}));job.downloadedBytes=job.baseDownloaded+Number(file.size||installed.at(-1).size||0);}
   const manifest={schema:1,repoId:job.repoId,quant:job.quant,downloadedAt:new Date().toISOString(),files:installed.map(x=>({path:path.basename(x.path),size:x.size})),capabilities:job.metadata.capabilities||{},pipeline_tag:job.metadata.pipeline_tag||null,source:`https://huggingface.co/${job.repoId}`};await fsp.writeFile(path.join(job.destDir,'manifest.json'),JSON.stringify(manifest,null,2));job.status='completed';job.completedAt=new Date().toISOString();job.bytesPerSecond=0;this.emit('download:progress',this.publicJob(job));
  }catch(e){if(e.name==='AbortError'&&job.paused)job.status='paused';else if(e.name==='AbortError')job.status='cancelled';else{job.status='failed';job.error=String(e.message||e);}job.bytesPerSecond=0;this.emit('download:progress',this.publicJob(job));}
 }
 async start({repoId,group,projector=null,metadata={}}){if(!repoId||!group?.parts?.length)throw new Error('Model group is required');const id=crypto.randomUUID(),safeRepo=repoId.replace(/[^a-zA-Z0-9._-]+/g,'__'),destDir=path.join(this.getModelsDir(),safeRepo,group.quant||'GGUF');await this.ensureDir(destDir);const files=[...group.parts];if(projector)files.push(projector);const job={id,repoId,quant:group.quant||'GGUF',status:'downloading',totalBytes:files.reduce((n,f)=>n+Number(f.size||0),0),downloadedBytes:0,bytesPerSecond:0,destDir,files:files.map(f=>f.path),filesData:files,metadata,startedAt:new Date().toISOString(),controller:new AbortController(),paused:false,baseDownloaded:0,error:null};this.jobs.set(id,job);this.emit('download:progress',this.publicJob(job));this._run(job);return this.publicJob(job);}
 pause(id){const j=this.jobs.get(id);if(!j||!['downloading','verifying'].includes(j.status))return false;j.paused=true;j.controller.abort();return true;}
 resume(id){const j=this.jobs.get(id);if(!j||!['paused','failed','cancelled'].includes(j.status))return false;j.paused=false;j.error=null;j.status='downloading';j.controller=new AbortController();this.emit('download:progress',this.publicJob(j));this._run(j);return true;}
 cancel(id){const j=this.jobs.get(id);if(!j)return false;j.paused=false;j.status='cancelled';j.controller.abort();this.emit('download:progress',this.publicJob(j));return true;}
}
module.exports={DownloadManager};
