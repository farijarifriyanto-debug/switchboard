const MONEY=8;
function money(value){return value==null?null:+Number(value).toFixed(MONEY);}
function finite(value,fallback=0){if(value==null||value==='')return fallback;const n=Number(value);return Number.isFinite(n)?n:fallback;}
function rateValue(rate,long,short){return rate?.[long]??rate?.[short]??null;}

function rawCost(rate,usage={}){
  const inputRate=rateValue(rate,'input_per_1m','inputPerMillion'),cachedRate=rateValue(rate,'cached_input_per_1m','cachedInputPerMillion'),outputRate=rateValue(rate,'output_per_1m','outputPerMillion');
  const input=finite(usage.input_tokens??usage.inputTokens),cached=Math.max(0,finite(usage.cached_input_tokens??usage.cachedInputTokens)),output=finite(usage.output_tokens??usage.outputTokens);
  if(inputRate==null||outputRate==null||(cached>0&&cachedRate==null))return {status:'UNKNOWN',rawUpstreamCost:null,inputTokens:input,cachedInputTokens:cached,outputTokens:output};
  const value=(Math.max(0,input-cached)*inputRate+cached*cachedRate+output*outputRate)/1e6;
  return {status:'KNOWN',rawUpstreamCost:money(value),inputTokens:input,cachedInputTokens:cached,outputTokens:output};
}

async function effectiveProviderCost({pricing,provider,modelId,usage,modifiers={}}){
  const rate=await pricing.rate(provider,modelId,modifiers.asOf||new Date()),base=rawCost(rate,usage);
  if(base.status!=='KNOWN')return {status:'UNKNOWN',provider,modelId,rate,rawUpstreamCost:null,topupAdjustedCost:null,gatewayFee:null,fxCost:null,retryCost:null,failoverCost:null,totalEffectiveCost:null};
  const topupBonus=finite(modifiers.topupBonusRate??(rate.topup_bonus!=null?rate.topup_bonus:0)),topupAdjusted=base.rawUpstreamCost*(1-Math.max(0,Math.min(1,topupBonus)));
  const gatewayFee=finite(modifiers.gatewayFeeUsd??(rate.gateway_fee!=null?rate.gateway_fee:0));
  const fxCost=finite(modifiers.fxCostUsd),retryCost=finite(modifiers.retryCostUsd),failoverCost=finite(modifiers.failoverCostUsd);
  return {status:'KNOWN',provider,modelId,rate,rawUpstreamCost:base.rawUpstreamCost,topupAdjustedCost:money(topupAdjusted),gatewayFee:money(gatewayFee),fxCost:money(fxCost),retryCost:money(retryCost),failoverCost:money(failoverCost),totalEffectiveCost:money(topupAdjusted+gatewayFee+fxCost+retryCost+failoverCost),currency:rate.currency||'USD',nativeCurrency:true,usage:base};
}

function estimateCommercialMargin({totalEffectiveCost,providerCost=totalEffectiveCost,retryCost=0,failoverCost=0,infrastructureReserveRate=0,riskReserveRate=0,paymentReserveRate=0,targetGrossMargin=.75,minimumCharge=0,roundingPolicy='none'}={}){
  const cost=finite(totalEffectiveCost,null);if(cost==null) return {status:'UNKNOWN',estimatedSellPrice:null};
  if(targetGrossMargin<0||targetGrossMargin>=1)throw new Error('targetGrossMargin must be >= 0 and < 1');
  const infrastructureReserve=cost*finite(infrastructureReserveRate),riskReserve=cost*finite(riskReserveRate),paymentReserve=cost*finite(paymentReserveRate),commercialCost=cost+infrastructureReserve+riskReserve+paymentReserve;
  let sell=commercialCost/(1-targetGrossMargin);if(minimumCharge>0)sell=Math.max(sell,minimumCharge);if(roundingPolicy==='cent')sell=Math.ceil(sell*100)/100;
  sell=money(sell);const grossProfit=money(sell-commercialCost);
  return {status:'KNOWN',providerCost:money(providerCost),retryCost:money(retryCost),failoverCost:money(failoverCost),infrastructureReserve:money(infrastructureReserve),riskReserve:money(riskReserve),paymentReserve:money(paymentReserve),totalEffectiveCost:money(commercialCost),estimatedSellPrice:sell,estimatedGrossProfit:grossProfit,estimatedGrossMargin:sell?money(grossProfit/sell):null,targetGrossMargin,roundingPolicy};
}

const DEFAULT_WORKLOADS={
  '10K/2K':{inputTokens:10_000,outputTokens:2_000},
  '50K/5K':{inputTokens:50_000,outputTokens:5_000},
  '100K/10K':{inputTokens:100_000,outputTokens:10_000},
  '500K/50K':{inputTokens:500_000,outputTokens:50_000},
  '1M-mixed':{totalTokens:1_000_000},
  '100M-monthly-mixed':{totalTokens:100_000_000}
};
function workloadUsage(workload,inputShare=.8){return workload.totalTokens?{input_tokens:Math.round(workload.totalTokens*inputShare),output_tokens:Math.round(workload.totalTokens*(1-inputShare))}:{input_tokens:workload.inputTokens,output_tokens:workload.outputTokens};}
async function simulateProfit({pricing,providers=['nebius','together'],models=['deepseek-ai/DeepSeek-V4-Flash-0731','MiniMaxAI/MiniMax-M3'],workloads=DEFAULT_WORKLOADS,inputShare=.8,margins=[.7,.75,.8]}={}){
  const rows=[];for(const provider of providers)for(const modelId of models)for(const [workloadName,workload] of Object.entries(workloads)){const usage=workloadUsage(workload,inputShare),cost=await effectiveProviderCost({pricing,provider,modelId,usage});if(cost.status!=='KNOWN'){rows.push({provider,modelId,workload:workloadName,status:'UNKNOWN',rawCost:null,effectiveCost:null});continue;}const policies=margins.map(target=>estimateCommercialMargin({totalEffectiveCost:cost.totalEffectiveCost,targetGrossMargin:target}));rows.push({provider,modelId,workload:workloadName,status:'KNOWN',rawCost:cost.rawUpstreamCost,effectiveCost:cost.totalEffectiveCost,sellPriceAt70Margin:policies[0].estimatedSellPrice,sellPriceAt75Margin:policies[1].estimatedSellPrice,sellPriceAt80Margin:policies[2].estimatedSellPrice,grossProfit:policies[1].estimatedGrossProfit,grossMargin:policies[1].estimatedGrossMargin});}
  return rows;
}

async function freeBetaCostEnvelope({pricing,provider,modelId,perRequestUsage={input_tokens:10_000,output_tokens:2_000},requestsPerDay=10,dailyQuotaTokens=120_000,weeklyQuotaTokens=600_000,monthlyQuotaTokens=2_000_000,subsidyBudgetUsd=100}={}){
  const request=await effectiveProviderCost({pricing,provider,modelId,usage:perRequestUsage});if(request.status!=='KNOWN')return {status:'UNKNOWN',priceToUser:'Rp0',maxCostPerFreeUserDay:null,maxCostPerFreeUserMonth:null,maxFreeUsersForBudget:null,oneConcurrentRequest:true};
  const dailyUsage=Math.min(dailyQuotaTokens,requestsPerDay*(finite(perRequestUsage.input_tokens)+finite(perRequestUsage.output_tokens))),monthlyUsage=Math.min(monthlyQuotaTokens,dailyUsage*30),ratio=(finite(perRequestUsage.input_tokens)+finite(perRequestUsage.output_tokens))||1;
  const scale=async total=>effectiveProviderCost({pricing,provider,modelId,usage:{input_tokens:Math.round(total*finite(perRequestUsage.input_tokens)/ratio),output_tokens:Math.round(total*finite(perRequestUsage.output_tokens)/ratio)}});
  const daily=await scale(dailyUsage),monthly=await scale(monthlyUsage),monthlyCost=monthly.totalEffectiveCost;
  return {status:'KNOWN',priceToUser:'Rp0',oneConcurrentRequest:true,dailyQuotaTokens,weeklyQuotaTokens,monthlyQuotaTokens,maxCostPerFreeUserDay:daily.totalEffectiveCost,maxCostPerFreeUserMonth:monthlyCost,maxFreeUsersForBudget:monthlyCost?Math.floor(subsidyBudgetUsd/monthlyCost):null,subsidyBudgetUsd,provider,modelId};
}

module.exports={DEFAULT_WORKLOADS,effectiveProviderCost,estimateCommercialMargin,freeBetaCostEnvelope,rawCost,simulateProfit};
