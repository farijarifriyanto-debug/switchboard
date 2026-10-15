// Cloud provider contract + shared errors/normalization.
// Every provider adapter implements: id, health(), listModels(), getModel(id),
// chat(), chatStream(), tools(), normalizeUsage(), normalizeError().
// Adapters NEVER log or expose key material; keys are injected per call.

class ProviderError extends Error{
  constructor(message,{status=0,code='PROVIDER_ERROR',retryable=false,failoverable=false,providerRequestId=null,provider=''}={}){
    super(message);this.name='ProviderError';this.status=status;this.code=code;
    this.retryable=Boolean(retryable);this.failoverable=Boolean(failoverable);
    this.providerRequestId=providerRequestId;this.provider=provider;
  }
}

// Classify a provider HTTP status into retry/failover semantics.
// Retryable: 429 (bounded), 5xx, network/timeout errors.
// NOT failoverable: invalid request (400 schema), auth (401/403), budget/safety.
function classifyStatus(status){
  if(status===401||status===403)return {retryable:false,failoverable:false,code:'AUTH_ERROR'};
  if(status===404)return {retryable:false,failoverable:false,code:'MODEL_NOT_FOUND'};
  if(status===400||status===422)return {retryable:false,failoverable:false,code:'INVALID_REQUEST'};
  if(status===402)return {retryable:false,failoverable:false,code:'BUDGET_REJECTED'};
  if(status===408)return {retryable:true,failoverable:true,code:'TIMEOUT'};
  if(status===429)return {retryable:true,failoverable:true,code:'RATE_LIMITED'};
  if(status>=500&&status<=599)return {retryable:true,failoverable:true,code:'PROVIDER_ERROR'};
  return {retryable:false,failoverable:false,code:'HTTP_ERROR'};
}
function classifyNetworkError(err){
  const msg=String((err&&(err.cause&&err.cause.code))||err&&err.code||err&&err.message||err);
  if(/ABORT|TIMEOUT|timeout/i.test(msg))return {retryable:true,failoverable:true,code:'TIMEOUT'};
  if(/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|UND_ERR|fetch failed|network/i.test(msg))return {retryable:true,failoverable:true,code:'NETWORK_ERROR'};
  return {retryable:false,failoverable:true,code:'NETWORK_ERROR'};
}

// Normalized usage record shape across providers.
function normalizeUsage(raw,defaults={}){
  const u=raw&&typeof raw==='object'?raw:{};
  const details=(u.prompt_tokens_details&&typeof u.prompt_tokens_details==='object')?u.prompt_tokens_details:{};
  const compDetails=(u.completion_tokens_details&&typeof u.completion_tokens_details==='object')?u.completion_tokens_details:{};
  const input=Number(u.prompt_tokens??u.input_tokens??0)||0;
  const cached=Number(details.cached_tokens??u.cached_input_tokens??u.cache_read_input_tokens??0)||0;
  const output=Number(u.completion_tokens??u.output_tokens??0)||0;
  const reasoning=Number(compDetails.reasoning_tokens??u.reasoning_tokens??defaults.reasoning_tokens??0)||0;
  return {
    input_tokens:input,
    cached_input_tokens:Math.min(cached,input),
    output_tokens:output,
    reasoning_tokens:reasoning,
    total_tokens:Number(u.total_tokens||((input+output)))||input+output
  };
}

// Normalized model representation shared by discovery and routing.
function normalizeModel(raw){
  return {
    modelId:String(raw.modelId||''),
    provider:String(raw.provider||''),
    displayName:String(raw.displayName||raw.modelId||''),
    capabilities:Array.isArray(raw.capabilities)?raw.capabilities:[],
    context:Number(raw.context||0)||null,
    modality:String(raw.modality||'text->text'),
    pricing:raw.pricing&&typeof raw.pricing==='object'?raw.pricing:null,
    availability:raw.availability||'live',
    source:String(raw.source||'provider'),
    fetchedAt:String(raw.fetchedAt||new Date().toISOString())
  };
}

module.exports={ProviderError,classifyStatus,classifyNetworkError,normalizeUsage,normalizeModel,PROVIDER_ERROR_CODES:null};