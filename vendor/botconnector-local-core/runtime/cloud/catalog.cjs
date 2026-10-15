// Model discovery with TTL cache and stale retention.
// Live provider listModels() -> normalized cache in userData/cloud/model-cache.json.
// On provider failure: retain stale cache, mark stale=true, availability='stale'.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');

const TTL_MS=10*60*1000;
const {normalizeModel}=require('./provider.cjs');

class ModelCatalog{
  constructor({adapters,cachedir,ttlMs=TTL_MS}={}){
    this.adapters=adapters;this.cachedir=cachedir;this.ttlMs=ttlMs;this.file=path.join(cachedir,'model-cache.json');
  }
  #cache(){try{return JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{return {models:[],fetchedAt:null};}}
  async #writeCache(models,fetchedAt){await fsp.mkdir(this.cachedir,{recursive:true});await fsp.writeFile(this.file,JSON.stringify({models,fetchedAt},null,2));}
  async refresh(providerId=null){
    const ids=providerId?[providerId]:Object.keys(this.adapters);
    const results={};
    let cache=this.#cache();
    for(const id of ids){
      const adapter=this.adapters[id];
      try{
        const models=await adapterList(adapter);
        const fresh=models.map(m=>({...m,stale:false}));
        results[id]={ok:true,count:fresh.length};
        // replace only this provider's entries
        const others=cache.models.filter(m=>m.provider!==id);
        const merged=[...others,...fresh];
        await this.#writeCacheSafe(merged);
        cache=this.#cache();
      }catch(e){
        results[id]={ok:false,error:String(e.code||e.message||e)};
        // retain stale: mark provider entries stale
        const kept=cache.models.map(m=>m.provider===id?{...m,stale:true,availability:'stale'}:m);
        await this.#writeCacheSafe(kept);
        cache=this.#cache();
      }
    }
    const current=this.#cache();
    return {models:current.models,results,refreshedAt:current.fetchedAt};
  }
  async #writeCacheSafe(models){
    const wrapped={models,fetchedAt:new Date().toISOString()};
    await fsp.mkdir(this.cachedir,{recursive:true});
    await fsp.writeFile(this.file,JSON.stringify(wrapped,null,2));
  }
  list({provider=null,freshOnly=false}={}){
    const cache=this.#cache();
    let models=cache.models;
    const age=cache.fetchedAt?Date.now()-Date.parse(cache.fetchedAt):Infinity;
    const isFresh=age<this.ttlMs;
    if(freshOnly&&!isFresh)return {models:[],fresh:false,fetchedAt:cache.fetchedAt};
    if(provider)models=models.filter(m=>m.provider===provider);
    return {models,stale:!isFresh,fetchedAt:cache.fetchedAt,count:models.length};
  }
  find(modelId,{freshOnly=false}={}){
    const all=this.list({freshOnly});
    return all.models.find(m=>m.modelId===modelId)||null;
  }
  providersAvailable(modelId){
    return this.list().models.filter(m=>m.modelId===modelId).map(m=>m.provider);
  }
  counts(){
    const models=this.list().models;
    const byProvider={};
    for(const m of models)byProvider[m.provider]=(byProvider[m.provider]||0)+1;
    const overlap=Object.entries(byProvider).filter(([,c])=>c>1).length;
    const unique=new Set(models.map(m=>m.modelId)).size;
    return {byProvider,total:models.length,overlap:overlapCount(models),unique};
  }
}
function overlapCount(models){
  const seen=new Map();
  for(const m of models)seen.set(m.modelId,(seen.get(m.modelId)||0)+1);
  let n=0;for(const c of seen.values())if(c>1)n++;
  return n;
}
async function adapterList(adapter){return adapter.listModels();}
module.exports={ModelCatalog,overlapCount};
