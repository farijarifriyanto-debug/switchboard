// Versioned pricing registry. Effective-dated; never invents prices; UNKNOWN
// fails safe (cost_status=UNKNOWN) instead of fabricating $0.
const fsp=require('node:fs/promises');
const path=require('node:path');

const REGISTRY_VERSION=1;

function schemaEntry(input={}){
  const provider=input.provider_id||input.provider,model=input.canonical_model_id||input.modelId;
  const inputRate=input.input_per_1m??input.inputPerMillion??null,cachedRate=input.cached_input_per_1m??input.cachedInputPerMillion??null,outputRate=input.output_per_1m??input.outputPerMillion??null;
  return {...input,provider_id:provider,canonical_model_id:model,upstream_model_id:input.upstream_model_id??model,upstream_version:input.upstream_version??null,currency:input.currency??'USD',input_per_1m:inputRate,cached_input_per_1m:cachedRate,output_per_1m:outputRate,long_context_tiers:input.long_context_tiers??input.longContextTiers??null,time_based_pricing:input.time_based_pricing??input.timeBasedPricing??null,peak_window:input.peak_window??input.peakWindow??null,offpeak_window:input.offpeak_window??input.offpeakWindow??null,gateway_fee:input.gateway_fee??input.gatewayFee??null,topup_bonus:input.topup_bonus??input.topupBonus??null,effective_from:input.effective_from??input.effectiveFrom??null,effective_until:input.effective_until??input.effectiveUntil??null,source:input.source??null,verified_at:input.verified_at??input.verifiedAt??null,registry_version:input.registry_version??REGISTRY_VERSION,provider,modelId:model,inputPerMillion:inputRate,cachedInputPerMillion:cachedRate,outputPerMillion:outputRate,effectiveFrom:input.effective_from??input.effectiveFrom??null,verifiedAt:input.verified_at??input.verifiedAt??null};
}

// Verified price baseline (source: account UI / live metadata, verified 2026-09-13).
// Effective-dated; new verified values append new effectiveFrom entries.
const SEED={
  version:REGISTRY_VERSION,
  entries:[
    schemaEntry({provider:'together',modelId:'deepseek-ai/DeepSeek-V4-Flash-0731',inputPerMillion:0.14,cachedInputPerMillion:0.03,outputPerMillion:0.28,effectiveFrom:'2026-09-13',source:'together /v1/models pricing (live metadata, verified)',verifiedAt:'2026-09-13'}),
    schemaEntry({provider:'together',modelId:'MiniMaxAI/MiniMax-M3',inputPerMillion:0.30,cachedInputPerMillion:0.06,outputPerMillion:1.20,effectiveFrom:'2026-09-13',source:'together /v1/models pricing (live metadata, verified)',verifiedAt:'2026-09-13'}),
    schemaEntry({provider:'nebius',modelId:'deepseek-ai/DeepSeek-V4-Flash-0731',inputPerMillion:0.14,cachedInputPerMillion:null,outputPerMillion:0.28,effectiveFrom:'2026-09-13',source:'Nebius account UI (verified)',verifiedAt:'2026-09-13'}),
    schemaEntry({provider:'nebius',modelId:'MiniMaxAI/MiniMax-M3',inputPerMillion:0.30,cachedInputPerMillion:null,outputPerMillion:1.20,effectiveFrom:'2026-09-13',source:'Nebius account UI (verified)',verifiedAt:'2026-09-13'})
  ]
};

class PricingRegistry{
  constructor({dir}={}){this.file=path.join(dir,'pricing.json');}
  async load(){
    try{
      const disk=JSON.parse(await fsp.readFile(this.file,'utf8'));
      if(Number(disk.version)>=REGISTRY_VERSION)return {...disk,entries:(disk.entries||[]).map(schemaEntry)};
    }catch{}
    await this.save(SEED);
    return SEED;
  }
  async save(registry){
    await fsp.mkdir(path.dirname(this.file),{recursive:true});
    await fsp.writeFile(this.file,JSON.stringify(registry,null,2));
  }
  async upsert(entry){
    const reg=await this.load();
    const normalized=schemaEntry(entry),i=reg.entries.findIndex(e=>e.provider_id===normalized.provider_id&&e.canonical_model_id===normalized.canonical_model_id&&e.effective_from===normalized.effective_from);
    if(i>=0)reg.entries[i]={...reg.entries[i],...normalized};else reg.entries.push(normalized);
    await this.save(reg);
    return reg;
  }
  // Find the newest effective-dated rate for (provider, modelId) as of a date.
  async rate(provider,modelId,asOf=new Date()){
    const reg=await this.load();
    const today=asOf.toISOString().slice(0,10);
    const matches=reg.entries.filter(e=>e.provider_id===provider&&e.canonical_model_id===modelId&&e.effective_from<=today&&(!e.effective_until||e.effective_until>=today))
      .sort((a,b)=>a.effective_from<b.effective_from?1:-1);
    return matches[0]||null;
  }
  // Cost in USD for a usage record; null when pricing unknown (fail-safe).
  async estimate({provider,modelId,inputTokens=0,cachedInputTokens=0,outputTokens=0,asOf=new Date()}){
    const rate=await this.rate(provider,modelId,asOf);
    if(!rate||rate.inputPerMillion==null||rate.outputPerMillion==null)return {cost:null,costStatus:'UNKNOWN',pricingVersion:rate?`v${(await this.load()).version}/${rate?rate.effectiveFrom:'none'}`:null,rate};
    const cachedRate=rate.cached_input_per_1m;
    if(cachedInputTokens>0&&cachedRate==null)return {cost:null,costStatus:'UNKNOWN',pricingVersion:`v${(await this.load()).version}:${rate.effective_from}`,rate};
    let cost;
    if(cachedInputTokens>0&&cachedRate!=null){
      cost=(inputTokens-cachedInputTokens)/1e6*rate.input_per_1m+cachedInputTokens/1e6*cachedRate+outputTokens/1e6*rate.output_per_1m;
    }else{
      cost=inputTokens/1e6*rate.input_per_1m+outputTokens/1e6*rate.output_per_1m;
    }
    return {cost:+cost.toFixed(8),costStatus:'KNOWN',pricingVersion:`v${(await this.load()).version}:${rate.effective_from}`,rate};
  }
  public(){return this.#sync();}
  #sync(){try{const disk=JSON.parse(require('node:fs').readFileSync(this.file,'utf8'));return {...disk,entries:(disk.entries||[]).map(schemaEntry)};}catch{return SEED;}}
}
module.exports={PricingRegistry,SEED,REGISTRY_VERSION,schemaEntry};
