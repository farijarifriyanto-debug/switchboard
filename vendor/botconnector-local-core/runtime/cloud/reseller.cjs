const ACCEPTANCE_CONTRACT=Object.freeze([
  'MODEL_IDENTITY','EXACT_VERSION','CHAT','STREAMING','TOOLS','STRUCTURED_OUTPUT','USAGE','COST','HEALTH','LATENCY','CIRCUIT_BREAKER','FAILOVER','DATA_POLICY','LEGAL_PERMISSION'
]);
function evaluateResellerAcceptance(evidence={}){
  const missing=ACCEPTANCE_CONTRACT.filter(key=>evidence[key]!==true);
  return {productionEligible:missing.length===0,missing,contractVersion:'phase4-v1'};
}
module.exports={ACCEPTANCE_CONTRACT,evaluateResellerAcceptance};
