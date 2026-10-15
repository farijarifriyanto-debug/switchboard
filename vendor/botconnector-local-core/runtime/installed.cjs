const fsp=require('node:fs/promises');
const path=require('node:path');
async function scanInstalled(root){
  const out=[]; const stack=[root];
  while(stack.length){const dir=stack.pop();let items=[];try{items=await fsp.readdir(dir,{withFileTypes:true});}catch{continue;}for(const e of items){const p=path.join(dir,e.name);if(e.isDirectory())stack.push(p);else if(/\.gguf$/i.test(e.name)&&!/(mmproj|projector)/i.test(e.name)){let st;try{st=await fsp.stat(p);}catch{continue;}let manifest=null;try{manifest=JSON.parse(await fsp.readFile(path.join(dir,'manifest.json'),'utf8'));}catch{}out.push({path:p,name:e.name,size:st.size,dir,repoId:manifest?.repoId||null,quant:manifest?.quant||null,capabilities:manifest?.capabilities||{},pipeline_tag:manifest?.pipeline_tag||null,projector:(manifest?.files||[]).map(x=>path.join(dir,x.path)).find(x=>/(mmproj|projector)/i.test(x))||null,installedAt:manifest?.downloadedAt||st.mtime.toISOString()});}}
  }
  return out.sort((a,b)=>String(b.installedAt).localeCompare(String(a.installedAt)));
}
module.exports={scanInstalled};
