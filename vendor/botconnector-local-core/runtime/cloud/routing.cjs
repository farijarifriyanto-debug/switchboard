// Cloud routing policy — configurable, deterministic, exact-model invariant.
// Seed rules are evidence-based defaults, not hardcoded business logic:
// users/tools may edit routing.json. Failover only for the SAME exact model id.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');

const DEFAULT_POLICY={
  version:1,
  note:'Failover is allowed ONLY to a provider that serves the SAME exact model id. No substitution.',
  rules:{
    'deepseek-ai/DeepSeek-V4-Flash-0731':{preferred:'nebius',fallback:['together']},
    'MiniMaxAI/MiniMax-M3':{preferred:'nebius',fallback:['together']}
  },
  defaults:{preferred:'together',fallback:[]}
};

class RoutingTable{
  constructor({dir}={}){
    this.file=path.join(dir,'routing.json');
  }
  async load(){
    try{return {...DEFAULT_POLICY,...JSON.parse(await fsp.readFile(this.file,'utf8'))};}
    catch{return structuredClone(DEFAULT_POLICY);}
  }
  async save(policy){
    await fsp.mkdir(path.dirname(this.file),{recursive:true});
    // Validate: no rule may allow cross-model substitution (defense in depth).
    for(const [model,rule] of Object.entries(ruleEntries(ruleEntriesSafe(policy0(policy))))){
      if(rule.preferred&&!['nebius','together'].includes(rule.preferred))throw new Error(`Invalid preferred provider for ${model}`);
      if(!Array.isArray(rule.fallback))throw new Error('fallback must be an array');
    }
    await fsp.writeFile(this.file,JSON.stringify(policy0(policy0(policy)),null,2));
  }
  chain(modelId,availableProviders=[]){
    const p=this.#sync();
    const rule=p.rules[modelId]||p.defaults;
    const chain=[rule.preferred,...(rule.fallback||[])].filter(Boolean);
    const valid=chain.filter(x=>availableProviders.includes(x));
    // Preserve order, de-duplicate.
    return [...new Set(valid)];
  }
  #sync(){try{return {...DEFAULT_POLICY,...JSON.parse(fs.readFileSync(this.file,'utf8'))};}catch{return structuredClone(DEFAULT_POLICY);}}
}
function ruleEntriesSafe(policy){return policy&&policy.rules&&typeof policy.rules==='object'?policy.rules:{};}
function ruleEntries(rules){return rules;}
function policy0(p){return p;}
module.exports={RoutingTable,DEFAULT_POLICY};