// Internal cloud-unit engine (simulation only — no billing this phase).
// Units derive from ACTUAL blended cost vs a reference model's blended cost.
// Reference default: deepseek-ai/DeepSeek-V4-Flash-0731 (Together rates).
const {SEED}=require('./pricing.cjs');

const REFERENCE_MODEL='deepseek-ai/DeepSeek-V4-Flash-0731';
const UNITS_PER_USD=10000; // configurable: 1 cloud unit = $0.0001 reference blended cost

class UnitEngine{
  constructor({referenceModel=REFERENCE_MODEL,unitsPerUsd=UNITS_PER_USD}={}){
    this.referenceModel=referenceModel;this.unitsPerUsd=unitsPerUsd;
  }
  // Blended cost per token from a rate row (assumes 1:1 cached share unknown -> uncached rate).
  blendedCostPerToken({inputPerMillion,outputPerMillion,ratio=0.75}={}){
    if(inputPerMillion==null||outputPerMillion==null)return null;
    return ratio*(inputPerMillion/1e6)+(1-ratio)*(outputPerMillion/1e6);
  }
  multiplier(modelCostPerToken){
    const ref=this.#refCost();
    if(!ref||!modelCostPerToken)return null;
    return +(modelCostPerToken/ref).toFixed(3);
  }
  #refCost(){
    const entry=(SEED.entries||[]).find(e=>e.provider==='together'&&e.modelId===this.referenceModel);
    if(!entry)return null;
    return this.blendedCostPerToken({inputPerMillion:entry.inputPerMillion,outputPerMillion:entry.outputPerMillion});
  }
  // Units consumed by an actual request cost (USD). Unknown cost -> null units.
  units(usdCost){return usdCost==null?null:+(usdCost*this.unitsPerUsd).toFixed(4);}
  public(){
    return {referenceModel:this.referenceModel,unitsPerUsd:this.unitsPerUsd,referenceBlendedCostPerToken:this.#refCost(),simulationOnly:true,billing:'not-implemented'};
  }
}
module.exports={UnitEngine,REFERENCE_MODEL,UNITS_PER_USD};