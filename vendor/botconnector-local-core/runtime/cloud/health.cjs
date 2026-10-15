// Provider health tracking + simple circuit breaker.
// Derives health from real request outcomes (never by burning inference calls).
const path=require('node:path');
const fsp=require('node:fs/promises');

const STATES=['HEALTHY','DEGRADED','RATE_LIMITED','AUTH_ERROR','UNAVAILABLE'];

class HealthBoard{
  constructor({dir,cooldownMs=30000}={}){
    this.file=path.join(dir,'health.json');
    this.cooldownMs=cooldownMs;
    this.state={};
    // In-memory EMA metrics per provider.
    this.metrics={};
  }
  #slot(provider){
    if(!this.metrics[provider])this.metrics[provider]={successEma:1,latencyEma:null,four29Rate:0,five00Rate:0,authError:false,consecutiveFailures:0,openedAt:null,lastProbe:0};
    return this.metrics[provider];
  }
  record(provider,{ok,latencyMs,status=null}={}){
    const s=this.#slot(provider);
    const now=Date.now();
    if(ok){
      s.successEma=s.successEma*0.8+0.2;
      s.consecutiveFailures=0;
      if(latencyMs)s.latencyEma=s.latencyEma==null?latencyMs:s.latencyEma*0.7+latencyMs*0.3;
      if(status===429)s.four29Rate=s.four29Rate*0.7+0.3;else s.four29Rate*=0.7;
      if(status>=500&&status<600)s.five00Rate=s.five00Rate*0.7+0.3;else s.five00Rate*=0.7;
      if(status===401||status===403)s.authError=true;
    }else{
      s.successEma=s.successEma*0.8;
      if(!s.consecutiveFailures)s.consecutiveFailures=0;
      s.consecutiveFailures++;
      if(status===429)s.four29Rate=s.four29Rate*0.7+0.3;
      if(status>=500&&status<600)s.five00Rate=s.five00Rate*0.7+0.3;
      if(status===401||status===403)s.authError=true;
      if(s.consecutiveFailures>=3)s.openUntil=Date.now()+this.cooldownMs;
    }
    // If enough time passed since openUntil, allow probing again (half-open).
    return this.snapshot(provider);
  }
  openUntil(provider){return this.#slot(provider).openUntil||0;}
  isCircuitOpen(provider){return Date.now()<this.openUntil(provider);}
  snapshot(provider){
    const s=this.#slot(provider);
    let state='HEALTHY';
    if(s.authError)state='AUTH_ERROR';
    else if(this.isCircuitOpen(provider))state='UNAVAILABLE';
    else if(s.four29Rate>0.4)state='RATE_LIMITED';
    else if(s.successEma<0.7||s.five00Rate>0.4)state='DEGRADED';
    s.state=state;
    return {provider,state,successEma:+s.successEma.toFixed(3),latencyEmaMs:s.latencyEma?Math.round(s.latencyEma):null,four29Rate:+s.four29Rate.toFixed(3),five00Rate:+s.five00Rate.toFixed(3),circuitOpen:this.isCircuitOpen(provider),openUntil:s.openUntil||null};
  }
  all(providers){const o={};for(const p of providers)o[p]=this.snapshot(p);return o;}
  async persist(){try{await fsp.mkdir(path.dirname(this.file),{recursive:true});await fsp.writeFile(this.file,JSON.stringify(this.metrics,null,2));}catch{}}
  async restore(){try{const m=JSON.parse(await fsp.readFile(this.file,'utf8'));if(m&&typeof m==='object')this.metrics=m;}catch{}}
}
module.exports={HealthBoard,STATES};