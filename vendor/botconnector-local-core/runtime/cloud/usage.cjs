// Cloud usage ledger — one JSONL line per request. Metadata only; prompt and
// completion bodies are never written by default. Survives restarts (append file).
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');

class UsageLedger{
  constructor({dir}={}){this.file=path.join(dir,'usage.jsonl');}
  async append(record){
    const row={
      request_id:record.requestId,
      timestamp:record.timestamp||new Date().toISOString(),
      provider_requested:record.providerRequested||null,
      provider_used:record.providerUsed||null,
      model_id:record.modelId,
      protocol:record.protocol||'chat-completions',
      failover:Boolean(record.failover),
      retry_count:Number(record.retryCount||0),
      retry_reason:record.retryReason||null,
      input_tokens:record.inputTokens||0,
      cached_input_tokens:record.cachedInputTokens||0,
      output_tokens:record.outputTokens||0,
      reasoning_tokens:record.reasoningTokens||0,
      total_tokens:record.totalTokens||0,
      latency_ms:record.latencyMs||null,
      ttft_ms:record.ttftMs||null,
      estimated_provider_cost:record.estimatedCost,
      raw_upstream_cost:record.rawUpstreamCost,
      topup_adjusted_cost:record.topupAdjustedCost,
      gateway_fee:record.gatewayFee,
      fx_cost:record.fxCost,
      retry_cost:record.retryCost,
      failover_cost:record.failoverCost,
      total_effective_cost:record.totalEffectiveCost,
      converted_currency:record.convertedCurrency||null,
      fx_rate:record.fxRate??null,
      fx_source:record.fxSource||null,
      fx_timestamp:record.fxTimestamp||null,
      cost_basis:record.costBasis||null,
      cost_status:record.costStatus||'KNOWN',
      status:record.status||'ok',
      provider_request_id:record.providerRequestId||null,
      pricing_version:record.pricingVersion||null,
      cloud_units:record.cloudUnits
    };
    for(const k of Object.keys(row))if(row[k]===undefined)row[k]=null;
    await fsp.mkdir(path.dirname(this.file),{recursive:true});
    await fsp.appendFile(this.file,JSON.stringify(row)+'\n','utf8');
    return row;
  }
  async list({limit=50}={}){
    let text='';
    try{text=await fsp.readFile(this.file,'utf8');}catch{return [];}
    const lines=text.trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);
  }
  async summary(){
    const all=await this.list({limit:100000});
    const byProvider={};let cost=0,unknown=0,requests=0,inTok=0,outTok=0;
    for(const r of all){
      requests++;inTok+=r.input_tokens||0;outTok+=r.output_tokens||0;
      byProvider[r.provider_used]=(byProvider[r.provider_used]||0)+1;
      if(r.estimated_provider_cost==null)unknown++;else cost+=r.estimated_provider_cost;
    }
    return {requests,totals:{inputTokens:inTok,outputTokens:outTok},byProvider,estimatedCost:+cost.toFixed(6),unknownCostRecords:unknown};
  }
}
module.exports={UsageLedger};
