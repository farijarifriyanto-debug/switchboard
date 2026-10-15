// Cloud Router: exact-model routing, bounded retries with backoff+jitter,
// same-model failover, circuit-breaker integration, budget enforcement,
// usage accounting. Deterministic policy only (no AI routing in this phase).
const crypto=require('node:crypto');
const {ProviderError,classifyNetworkError,normalizeUsage}=require('./provider.cjs');
const {estimateCost}=require('./cost.cjs');

class CloudRouter{
  constructor({adapters,catalog,routing,health,ledger,pricing,units,budget,cfg={}}={}){
    this.adapters=adapters;this.catalog=catalog;this.routing=routing;this.health=health;
    this.ledger=ledger;this.pricing=pricing;this.units=units;this.budget=budget;
    this.retryMax=Number(cfg.retryMax||2);
    this.backoffBaseMs=Number(cfg.backoffBaseMs||400);
    this.jitterMs=Number(cfg.jitterMs||250);
    this.events=[];
  }
  #emit(e){this.events.push({...e,at:new Date().toISOString()});if(this.events.length>200)this.events=this.events.slice(-200);}
  providerChain(modelId,available){return this.routing.chain(modelId,available);}
  // Failover triggers: timeout, 429-after-retries, retryable 5xx, transient network,
  // circuit open, provider unavailable. NEVER: invalid request, auth, schema,
  // unsupported capability, budget rejection, safety refusal, model responses.
  #shouldFailover(err){
    if(!(err instanceof ProviderError))return true;
    return Boolean(err.failoverable);
  }
  async #attempt(providerId,body,{timeoutMs}={}){
    const adapter=this.adapters[providerId];
    const t0=Date.now();
    try{
      const res=await adapter.chat(body,{timeoutMs});
      const latencyMs=Date.now()-t0;
      return {ok:true,res:{...res,_meta:{...(res._meta||{}),latencyMs}},providerId,latencyMs};
    }catch(e){
      if(e instanceof ProviderError){this.#emit({provider:providerId,event:'error',code:e.code,status:e.status,retryable:e.retryable,failoverable:e.failoverable});throw e;}
      const c=classifyNetworkError(e);
      const pe=new ProviderError(`${providerId} network error: ${c.code}`,{code:c.code,retryable:c.retryable,failoverable:c.failoverable,provider:providerId});
      this.#emit({provider:providerId,event:'error',code:pe.code});throw pe;
    }
  }
  chat({modelId,messages,tools=null,temperature=0.7,stream=false,sessionSpentUsd=0,todaySpentUsd=0,protocol='chat-completions',request=null,timeoutMs=null}={}){
    if(!modelId)return Promise.reject(new ProviderError('model id required',{code:'INVALID_REQUEST'}));
    if(stream)return this.#chatStream({modelId,messages,tools,temperature,protocol,request});
    return this.#chatOnce({modelId,messages,tools,temperature,sessionSpentUsd,todaySpentUsd,protocol,request,timeoutMs});
  }
  async #chatOnce({modelId,messages,tools,temperature,sessionSpentUsd,todaySpentUsd,protocol,request,timeoutMs}){
    const providers=this.catalog.providersAvailable(modelId);
    if(!providers.length)throw new ProviderError(`Model is not available on any configured provider: ${modelId}`,{code:'EXACT_MODEL_UNAVAILABLE',failoverable:false});
    const chain=this.providerChain(modelId,providers);
    if(!chain.length)throw new ProviderError(`No healthy provider for exact model ${modelId}`,{code:'EXACT_MODEL_UNAVAILABLE'});

    // Budget gate before any provider call.
    const gate=this.budget.check({inputTokensEstimate:estimateTokens(messages),maxOutputTokens:request&&request.max_tokens,pendingCostEstimate:null,sessionSpentUsd,todaySpentUsd});
    if(!gate.allowed){this.#emit({event:'budget-rejected',modelId,reasons:gate.rejects});throw new ProviderError(`Budget guard rejected request: ${gate.rejects.join('; ')}`,{code:'BUDGET_REJECTED',failoverable:false});}

    const startedAt=Date.now();
    let lastError=null;
    for(let ci=0;ci<chain.length;ci++){
      const providerId=chain[ci];
      if(this.health.isCircuitOpen(providerId)&&chain.length>1){this.#emit({provider:providerId,event:'circuit-open-skipped'});continue;}
      let retries=0,retryReason=null;
      while(true){
        try{
          const out=await this.#attempt(providerId,{model:modelId,messages,temperature,tools:tools||undefined,...(request||{})},{timeoutMs});
          const usage=this.adapters[providerId].normalizeUsage((out.res&&out.res.usage)||out.usage);
          const cost=await estimateCost(this.pricing,this.units,providerId,modelId,usage);
          this.health.record(providerId,{ok:true,latencyMs:out.latencyMs});
          const row=await this.ledger.append({
            requestId:crypto.randomUUID(),providerRequested:chain[0],providerUsed:providerId,
            modelId,protocol,failover:ci>0,retryCount:retries,retryReason,
            inputTokens:usage.input_tokens,cachedInputTokens:usage.cached_input_tokens,outputTokens:usage.output_tokens,
            reasoningTokens:usage.reasoning_tokens,totalTokens:usage.total_tokens,
            latencyMs:out.latencyMs,ttftMs:null,estimatedCost:cost.cost,costStatus:cost.costStatus,
            rawUpstreamCost:cost.rawUpstreamCost,topupAdjustedCost:cost.topupAdjustedCost,gatewayFee:cost.gatewayFee,fxCost:cost.fxCost,retryCost:cost.retryCost,failoverCost:cost.failoverCost,totalEffectiveCost:cost.totalEffectiveCost,costBasis:cost.costBasis,
            providerRequestId:(out._meta&&out._meta.requestId)||null,pricingVersion:cost.pricingVersion,
            cloudUnits:cost.cloudUnits!=null?cost.cloudUnits:null,status:'ok'
          });
          this.health.persist().catch(()=>{});
          return {
            ...out.res,
            _meta:{...(out.res._meta||{}),providerRequested:chain[0],providerUsed:providerId,failover:ci>0,retryCount:retries,failoverChain:chain.slice(0,ci+1),usage,cost,cloudUnits:row.cloud_units,modelId,requestId:row.request_id,startedAt:new Date(startedAt).toISOString()}
          };
        }catch(e){
          lastError=e;
          if(e instanceof ProviderError&&e.retryable&&retries<this.retryMax){
            retries++;retryReason=e.code;
            this.#emit({provider:providerId,event:'retry',attempt:retries,code:e.code});
            await sleep(this.#backoffMs(retries,e));
            continue;
          }
          this.health.record(providerId,{ok:false,status:e.status||0});
          break;
        }
      }
      if(this.#shouldFailover(lastError)){this.#emit({provider:providerId,event:'failover-to',next:chain[ci+1]||null,reason:lastError.code});continue;}
      throw lastError;
    }
    this.health.persist().catch(()=>{});
    if(lastError)throw lastError;
    throw new ProviderError(`All providers failed for exact model ${modelId}`,{code:'ALL_PROVIDERS_FAILED',failoverable:false});
  }
  #backoffMs(retry,e){
    if(e&&e.status===429&&e.retryAfterMs)return Math.min(e.retryAfterMs,30000);
    return Math.min(15000,this.backoffBaseMs*Math.pow(2,retry-1))+Math.floor(Math.random()*this.jitterMs);
  }
  // Normalized streaming: yields {type:'chunk',provider,text,reasoning,toolCalls}
  // then {type:'done',meta:{usage,cost,providerUsed,...}}; final usage never dropped.
  async *#chatStream({modelId,messages,tools,temperature,protocol,request}){
    const providers=this.catalog.providersAvailable(modelId);
    if(!providers.length)throw new ProviderError(`Model is not available on any configured provider: ${modelId}`,{code:'EXACT_MODEL_UNAVAILABLE'});
    const chain=this.providerChain(modelId,providers);
    for(let ci=0;ci<chain.length;ci++){
      const providerId=chain[ci];
      if(this.health.isCircuitOpen(providerId)&&chain.length>1){this.#emit({provider:providerId,event:'circuit-open-skipped'});continue;}
      const t0=Date.now();let ttft=null;let usage=null,finishReason=null,requestId=null,chunks=0,toolAcc=[];
      try{
        const iter=this.adapters[providerId].chatStream({model:modelId,messages,temperature,tools:tools||undefined,...(request||{})},{});
        for await(const ev of iter){
          if(ev.type==='done')break;
          if(!ttft)ttft=Date.now()-t0;
          chunks++;
          if(ev.usage)usage=ev.usage;
          if(ev.finishReason)finishReason=ev.finishReason;
          if(ev.requestId)requestId=ev.requestId;
          if(Array.isArray(ev.toolCalls))toolAcc.push(...ev.toolCalls);
          const clean={type:'chunk',provider:providerId};
          if(ev.text)clean.text=ev.text;
          if(ev.reasoning)clean.reasoning=ev.reasoning;
          if(Array.isArray(ev.toolCalls))clean.toolCalls=ev.toolCalls;
          if(ev.finishReason)clean.finishReason=ev.finishReason;
          yield clean;
        }
        const latency=Date.now()-t0;
        const usageN=usage||{prompt_tokens:0,completion_tokens:0,total_tokens:0};
        const u=this.adapters[providerId].normalizeUsage(usageN);
        const cost=await estimateCost(this.pricing,this.units,providerId,modelId,u);
        await this.ledger.append({
          requestId:requestId||crypto.randomUUID(),providerRequested:chain[0],providerUsed:providerId,modelId,protocol,
          failover:ci>0,retryCount:0,retryReason:null,
          inputTokens:u.input_tokens,cachedInputTokens:u.cached_input_tokens,outputTokens:u.output_tokens,
          reasoningTokens:u.reasoning_tokens,totalTokens:u.total_tokens,
          latencyMs:latency,ttftMs:ttft,estimatedCost:cost.cost,costStatus:cost.costStatus,
          rawUpstreamCost:cost.rawUpstreamCost,topupAdjustedCost:cost.topupAdjustedCost,gatewayFee:cost.gatewayFee,fxCost:cost.fxCost,retryCost:cost.retryCost,failoverCost:cost.failoverCost,totalEffectiveCost:cost.totalEffectiveCost,costBasis:cost.costBasis,
          providerRequestId:requestId,pricingVersion:cost.pricingVersion,
          cloudUnits:cost.cloudUnits!=null?cost.cloudUnits:null,status:'ok'
        });
        this.health.record(providerId,{ok:true,latencyMs:latency});
        this.health.persist().catch(()=>{});
        yield {type:'done',provider:providerId,finishReason,requestId,usage:u,cost,cloudUnits:cost.cloudUnits,failover:ci>0,failoverChain:chain.slice(0,ci+1)};
        return;
      }catch(e){
        const err=e instanceof ProviderError?e:new ProviderError(String(e.message||e),{code:'PROVIDER_ERROR',failoverable:true,provider:providerId});
        this.health.record(providerId,{ok:false,status:err.status||0});
        this.#emit({provider:providerId,event:'stream-error',code:err.code,failoverable:err.failoverable});
        if(!err.failoverable||ci===chain.length-1)throw err;
        this.#emit({provider:providerId,event:'failover-to',next:chain[ci+1]||null});
        continue;
      }
    }
    throw new ProviderError(`All providers failed for exact model ${modelId}`,{code:'ALL_PROVIDERS_FAILED',failoverable:false});
  }
}
function estimateTokens(messages){let n=0;for(const m of Array.isArray(messages)?messages:[])n+=String(m&&m.content||'').length/4;return Math.round(n);}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
module.exports={CloudRouter,estimateTokens};
