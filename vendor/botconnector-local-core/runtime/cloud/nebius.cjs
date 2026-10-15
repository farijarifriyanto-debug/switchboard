// Nebius Token Factory adapter — OpenAI-compatible surface.
const {ProviderError,classifyStatus,classifyNetworkError,normalizeUsage,normalizeModel}=require('./provider.cjs');

const DEFAULT_BASE='https://api.tokenfactory.nebius.com/v1';

class NebiusProvider{
  constructor({getKey,baseUrl=DEFAULT_BASE,timeoutMs=120000}={}){
    this.id='nebius';this.getKey=getKey;this.baseUrl=String(baseUrl).replace(/\/+$/,'');this.timeoutMs=timeoutMs;
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
    const key=this.getKey();if(!key)throw new ProviderError('Nebius API key is not configured',{code:'NO_KEY',provider:'nebius'});
    let res;try{res=await fetch(`${this.baseUrl}/models`,{headers:this.#headers(key),signal:AbortSignal.timeout(20000)});}
    catch(e){const c=classifyNetworkError(e);throw new ProviderError(`Nebius discovery failed: ${c.code}`,{code:c.code,retryable:c.retryable,failoverable:c.failoverable,provider:'nebius'});}
    if(!res.ok){const c=classifyStatus(res.status);throw new ProviderError(`Nebius /models returned ${res.status}`,{status:res.status,code:c.code,retryable:c.retryable,failoverable:c.failoverable,provider:'nebius'});}
    const j=await res.json().catch(()=>({}));
    return (j.data||[]).map(m=>normalizeModel({
      modelId:m.id,provider:'nebius',displayName:m.id,
      capabilities:['chat','tools'],context:null,
      modality:'text->text',pricing:null,availability:'live',
      source:'nebius:/v1/models',fetchedAt:new Date().toISOString()
    }));
  }
  async getModel(id){const all=await this.listModels();return all.find(m=>m.modelId===id)||null;}
  async chat(body,{key,signal,timeoutMs}={}){
    const k=key!==undefined?key:this.getKey();if(!k)throw new ProviderError('Nebius API key is not configured',{code:'NO_KEY',provider:'nebius'});
    let res;const t0=Date.now();
    try{res=await fetch(`${this.baseUrl}/chat/completions`,{method:'POST',headers:this.#headers(k),body:JSON.stringify(body),signal:signal||AbortSignal.timeout(timeoutMs||this.timeoutMs)});}
    catch(e){if(e.name==='AbortError'&&!signal)throw new ProviderError('Nebius request timed out',{code:'TIMEOUT',retryable:true,failoverable:true,provider:'nebius'});const c=classifyNetworkError(e);throw new ProviderError(`Nebius network error: ${c.code}`,{code:c.code,retryable:c.retryable,failoverable:c.failoverable,provider:'nebius'});}
    const requestId=res.headers.get('x-request-id')||res.headers.get('x-amzn-requestid')||null;
    const text=await res.text();
    if(!res.ok){
      const c=classifyStatus(res.status);
      let msg='';try{msg=(JSON.parse(text).error&&JSON.parse(text).error.message)||'';}catch{}
      throw new ProviderError(msg||`Nebius returned ${res.status}`,{status:res.status,code:c.code,retryable:c.retryable,failoverable:c.failoverable,providerRequestId:requestId,provider:'nebius',latencyMs:Date.now()-t0});
    }
    const j=JSON.parse(text);return {...j,_meta:{provider:'nebius',requestId,latencyMs:Date.now()-t0}};
  }
  async *chatStream(body,{getKey=null,key=undefined,signal}={}){
    const k=key!==undefined?key:(this.getKey());if(!k)throw new ProviderError('Nebius API key is not configured',{code:'NO_KEY',provider:'nebius'});
    const res=await fetch(`${this.baseUrl}/chat/completions`,{method:'POST',headers:{...this.#headers(k),Accept:'text/event-stream'},body:JSON.stringify({...body,stream:true,stream_options:{include_usage:true,...(body.stream_options||{})}}),signal});
    if(!res.ok){const c=classifyStatus(res.status);const text=await res.text();throw new ProviderError(`Nebius stream returned ${res.status}`,{status:res.status,code:c.code,retryable:c.retryable,failoverable:c.failoverable,provider:'nebius'});}
    yield* sseEvents(res,body,{provider:'nebius'});
  }
  tools(){return TOOL_DEFS;}
  normalizeUsage(raw){return normalizeUsage(raw);}
  normalizeError(e){return e;}
}
// Shared SSE normalization: emits normalized events consumed by the router.
async function* sseEvents(res,body,{provider}){
  const reader=res.body.getReader();const dec=new TextDecoder();let buf='';
  while(true){
    const {done,value}=await reader.read();if(done)break;
    buf+=dec.decode(value,{stream:true});
    const lines=buf.split(/\r?\n/);buf=lines.pop()||'';
    for(const line of lines){
      if(!line.startsWith('data:'))continue;
      const raw=line.slice(5).trim();if(!raw)continue;
      if(raw==='[DONE]'){yield {type:'done'};return;}
      let j;try{j=JSON.parse(raw);}catch{continue;}
      const choice=j.choices&&j.choices[0];
      const delta=(choice&&choice.delta)||{};
      const ev={type:'chunk',provider,raw:j};
      if(typeof delta.content==='string'&&delta.content)ev.text=delta.content;
      if(typeof delta.reasoning_content==='string'&&delta.reasoning_content)ev.reasoning=delta.reasoning_content;
      if(Array.isArray(delta.tool_calls)&&delta.tool_calls.length)ev.toolCalls=delta.tool_calls;
      if(choice&&choice.finish_reason)ev.finishReason=choice.finish_reason;
      if(j.usage)ev.usage=normalizeUsage(j.usage);
      if(j.id)ev.requestId=j.id;
      yield ev;
    }
  }
  yield {type:'done'};
}
const TOOL_DEFS=[{type:'function',function:{name:'calculator',description:'Evaluate a basic arithmetic expression. Use for exact calculations.',parameters:{type:'object',properties:{expression:{type:'string',description:'Arithmetic expression, for example 27 + 15'}},required:['expression'],additionalProperties:false}}}];
module.exports={NebiusProvider,DEFAULT_BASE_NEBIUS:DEFAULT_BASE,sseEvents};
