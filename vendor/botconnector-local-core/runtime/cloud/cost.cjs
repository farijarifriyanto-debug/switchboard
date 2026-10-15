// Cost estimation helper combining pricing registry + unit engine.
// Never invents prices: unknown pricing -> cost null, costStatus UNKNOWN.
const {effectiveProviderCost}=require('./economics.cjs');
async function estimateCost(pricing,units,provider,modelId,usage){
  const r=await effectiveProviderCost({pricing,provider,modelId,usage});
  if(r.status!=='KNOWN')return {usd:null,cost:null,costStatus:'UNKNOWN',pricingVersion:r.rate?`v${r.rate.registry_version}:${r.rate.effective_from}`:null,rate:r.rate,costBasis:r};
  const usd=r.totalEffectiveCost;
  return {usd,cost:usd,costStatus:'KNOWN',pricingVersion:`v${r.rate.registry_version}:${r.rate.effective_from}`,cloudUnits:units?units.units(usd):null,rate:r.rate,costBasis:r,providerCost:r.rawUpstreamCost,rawUpstreamCost:r.rawUpstreamCost,topupAdjustedCost:r.topupAdjustedCost,gatewayFee:r.gatewayFee,fxCost:r.fxCost,retryCost:r.retryCost,failoverCost:r.failoverCost,totalEffectiveCost:r.totalEffectiveCost};
}
module.exports={estimateCost};
