// Together AI adapter — OpenAI-compatible surface.
const {ProviderError,classifyStatus,classifyNetworkError,normalizeUsage,normalizeModel}=require('./provider.cjs');
const {sseEvents}=require('./nebius.cjs');

const DEFAULT_BASE='https://api.together.xyz/v1';

class TogetherProvider{
  constructor({getKey,baseUrl=DEFAULT_BASE,timeoutMs=120000}={}){
    this.id='together';this.getKey=getKey;this.baseUrl=String(baseUrl).replace(/\/+$/,'');this.timeoutMs=timeoutMs;
  }
  #headers(key){return {'Content-Type':'application/json',Accept:'application/json',Authorization:`Bearer ${key}`,'User-Agent':'BotConnectorAI-Core/0.4 (cloud-router-poc)'};}
  async health(){
    try{
      const key=this.getKey();if(!key)return {ok:false,reason:'NO_KEY'};
      const r=await fetch(`${this.baseUrl}/models`,{headers:this.#headers(key),signal:AbortSignal.timeout(12000)});
      if(r.status===401||r.status===403)return {ok:false,reason:'AUTH',status:r.status};
      if(r.ok)return {ok:true,status:r.status};
      return {ok:false,reason:'HTTP',status:r.status};
    }catch(e){return {ok:false,reason:'NETWORK',error:String(e.message||e)};}
  }
  async listModels(){
    const key=this.getKey();if(!key)throw new ProviderError('Together API key is not configured',{code:'NO_KEY',provider:'together'});
    let res;try{res=await fetch(`${this.baseUrl}/models`,{headers:this.#headers(key),signal:AbortSignal.timeout(20000)});}
    catch(e){const c=classifyNetworkError(e);throw new ProviderError(`Together discovery failed: ${c.code}`,{code:c.code,retryable:c.retryable,failoverable:c.failoverable,provider:'together'});}
    if(!res.ok){const c=classifyStatus(res.status);throw new ProviderError(`Together /models returned ${res.status}`,{status:res.status,code:c.code,retryable:c.retryable,failoverable:c.failoverable,provider:'together'});}
    const j=await res.json().catch(()=>({}));
    return (Array.isArray(j)?j:(j.data||[])).map(m=>normalizeModel({
      modelId:m.id,provider:'together',
      displayName:m.display_name||m.name||m.id,
      capabilities:(m.capabilities&&typeof m.capabilities==='object')?Object.entries(m.capabilities).filter(([,v])=>v===true).map(([k])=>k==='chat_completion'?'chat':k).slice(0,6):['chat'],
      context:Number(m.context_length||0)||null,
      modality:Array.isArray(m.modality)&&m.modality.length>=2?`${m.modality[0]}->${m.modality[m.modality.length-1]}`:'text->text',
      pricing:m.pricing&&typeof m.pricing==='object'?{
        inputPerMillion:Number(m.pricing.input??0)||null,
        outputPerMillion:Number(m.pricing.output??0)||null,
        cachedInputPerMillion:m.pricing.input_cache_read!=null?Number(m.pricing.input_cache_read):null,
        source:'together:/v1/models',verifiedAt:new Date().toISOString()
      }:null,
      availability:'live',source:'together:/v1/models',fetchedAt:new Date().toISOString()
    }));
  }
  async getModel(id){const all=await this.listModels();return all.find(m=>m.modelId===id)||null;}
  async chat(body,{key,signal,timeoutMs}={}){
    const k=key!==undefined?key:this.getKey();if(!k)throw new ProviderError('Together API key is not configured',{code:'NO_KEY',provider:'together'});
    let res;const t0=Date.now();
    try{res=await fetch(`${this.baseUrl}/chat/completions`,{method:'POST',headers:this.#headers(k),body:JSON.stringify(body),signal:signal||AbortSignal.timeout(timeoutMs||this.timeoutMs)});}
    catch(e){if(e.name==='AbortError'&&!signal)throw new ProviderError('Together request timed out',{code:'TIMEOUT',retryable:true,failoverable:true,provider:'together'});const c=classifyNetworkError(e);throw new ProviderError(`Together network error: ${c.code}`,{code:c.code,retryable:c.retryable,failoverable:c.failoverable,provider:'together'});}
    const requestId=res.headers.get('x-request-id')||res.headers.get('cf-ray')||null;
    const text=await res.text();
    if(!res.ok){
      const c=classifyStatus(res.status);
      let msg='';try{msg=(JSON.parse(text).error&&JSON.parse(text).error.message)||'';}catch{}
      throw new ProviderError(msg||`Together returned ${res.status}`,{status:res.status,code:c.code,retryable:c.retryable,failoverable:c.failoverable,providerRequestId:requestId,provider:'together',latencyMs:Date.now()-t0});
    }
    const j=JSON.parse(text);return {...j,_meta:{provider:'together',requestId,latencyMs:Date.now()-t0}};
  }
  async *chatStream(body,{key=undefined,signal}={}){
    const k=key!==undefined?key:this.getKey();if(!k)throw new ProviderError('Together API key is not configured',{code:'NO_KEY',provider:'together'});
    const res=await fetch(`${this.baseUrl}/chat/completions`,{method:'POST',headers:{...this.#headers(k),Accept:'text/event-stream'},body:JSON.stringify({...body,stream:true,stream_options:{include_usage:true,...(body.stream_options||{})}}),signal});
    if(!res.ok){const c=classifyStatus(res.status);const text=await res.text();throw new ProviderError(`Together stream returned ${res.status}`,{status:res.status,code:c.code,retryable:c.retryable,failoverable:c.failoverable,provider:'together'});}
    yield* sseEvents(res,body,{provider:'together'});
  }
  tools(){return TOOL_DEFS;}
  normalizeUsage(raw){return normalizeUsage(raw);}
  normalizeError(e){return e;}
}
const TOOL_DEFS=[{type:'function',function:{name:'calculator',description:'Evaluate a basic arithmetic expression. Use for exact calculations.',parameters:{type:'object',properties:{expression:{type:'string',description:'Arithmetic expression, for example 27 + 15'}},required:['expression'],additionalProperties:false}}}];
module.exports={TogetherProvider,DEFAULT_BASE_TOGETHER:DEFAULT_BASE};
