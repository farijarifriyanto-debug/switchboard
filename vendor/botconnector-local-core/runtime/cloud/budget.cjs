// Budget guard — conservative POC defaults; rejects before provider call.
const fsp=require('node:fs/promises');
const path=require('node:path');

const DEFAULTS={
  version:1,
  note:'POC guardrails. Reject before provider call; never allow runaway agent loops.',
  maxInputTokens:8000,
  maxOutputTokens:4096,
  maxRequestCostUsd:0.50,
  sessionBudgetUsd:2.00,
  dailyBudgetUsd:5.00
};

class BudgetGuard{
  constructor({dir}={}){this.file=path.join(dir,'budget.json');this.limits=this.#sync();}
  #sync(){try{const disk=JSON.parse(require('node:fs').readFileSync(this.file,'utf8'));return {...DEFAULTS,...disk};}catch{return {...DEFAULTS};}}
  async load(){this.limits=this.#sync();await this.#write(this.limits);return this.limits;}
  async set(partial){
    const l=this.limits;
    for(const k of ['maxInputTokens','maxOutputTokens','maxRequestCostUsd','sessionBudgetUsd','dailyBudgetUsd']){
      if(k in (partial||{})){const v=Number(partial[k]);if(!Number.isFinite(v)||v<0)throw new Error(`Invalid budget value for ${k}`);l[k]=v;}
    }
    await this.#write(l);
  }
  async #write(l){await fsp.mkdir(path.dirname(this.file),{recursive:true});await fsp.writeFile(this.file,JSON.stringify(l,null,2));this.limits=l;}
  // Spend counters come from the usage ledger; guard compares pending + spent.
  check({inputTokensEstimate=0,maxOutputTokens=null,pendingCostEstimate=null,sessionSpentUsd=0,todaySpentUsd=0}={}){
    const l=this.limits;
    const rejects=[];
    if(inputTokensEstimate>l.maxInputTokens)rejects.push(`input tokens ${inputTokensEstimate} exceeds limit ${l.maxInputTokens}`);
    if(maxOutputTokens&&maxOutputTokens>l.maxOutputTokens)rejects.push(`max_output_tokens ${maxOutputTokens} exceeds limit ${l.maxOutputTokens}`);
    if(pendingCostEstimate!=null&&pendingCostEstimate>l.maxRequestCostUsd)rejects.push(`estimated request cost $${pendingCostEstimate.toFixed(4)} exceeds per-request limit $${l.maxRequestCostUsd}`);
    if(sessionSpentUsd+(pendingCostEstimate||0)>l.sessionBudgetUsd)rejects.push(`session budget exceeded: spent $${sessionSpentUsd.toFixed(4)} > limit $${l.sessionBudgetUsd}`);
    if(todaySpentUsd+(pendingCostEstimate||0)>l.dailyBudgetUsd)rejects.push(`daily POC budget exceeded: $${todaySpentUsd.toFixed(4)} > limit $${l.dailyBudgetUsd}`);
    return {allowed:rejects.length===0,rejects,limits:l};
  }
  public(){return {...this.limits};}
}
module.exports={BudgetGuard,DEFAULTS};