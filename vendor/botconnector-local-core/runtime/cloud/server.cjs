// BotConnector Core cloud API sidecar — localhost-only HTTP surface for
// /api/cloud/* consumed by the CLI, TS SDK and Python SDK. Secrets stay inside
// this process (safeStorage/env resolution); responses expose state only.
const http=require('node:http');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {CredentialManager}=require('./../credentials.cjs');
const {NebiusProvider}=require('./nebius.cjs');
const {TogetherProvider}=require('./together.cjs');
const {ModelCatalog}=require('./catalog.cjs');
const {RoutingTable}=require('./routing.cjs');
const {HealthBoard}=require('./health.cjs');
const {UsageLedger}=require('./usage.cjs');
const {PricingRegistry}=require('./pricing.cjs');
const {UnitEngine}=require('./units.cjs');
const {BudgetGuard}=require('./budget.cjs');
const {CloudRouter}=require('./router.cjs');

class CloudServer{
  constructor({store,port=11440,safeStorage=null,ledgerSummary=async()=>({})}={}){
    this.port=port;this.store=store;
    const cloudDir=path.join(store.userData||process.env.APPDATA&&path.join(process.env.APPDATA,'botconnector-ai-local-cloud'),'cloud');
    const credentials=new CredentialManager({store,env:process.env});
    const adapters={
      nebius:new NebiusProvider({getKey:()=>{const s=credentials.source('nebius');return s.source==='missing'?null:s.key;}}),
      together:new TogetherProvider({getKey:()=>{const s=credentials.source('together');return s.source==='missing'?null:s.key;}})
    };
    const catalog=new ModelCatalog({adapters,cachedir:cloudDir});
    const health=new HealthBoard({dir:cloudDir});
    const routing=new RoutingTable({dir:cloudDir});
    const ledger=new UsageLedger({dir:cloudDir});
    const pricing=new PricingRegistry({dir:cloudDir});
    const units=new UnitEngine({});
    const budget=new BudgetGuard({dir:cloudDir});
    const router=new CloudRouter({adapters,catalog,routing,health,ledger,pricing,units,budget});
    this.ctx={credentials,adapters,catalog,routing,health,ledger,pricing,units,budget,router,cloudDir};
  }
  async listen(){
    this.server=http.createServer(async(req,res)=>{
      const send=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
      try{
        const url=new URL(req.url,'http://127.0.0.1:'+this.port);
        const c=this.ctx;
        if(req.method==='GET'&&url.pathname==='/api/cloud/status'){
          return send(200,{configured:true,credentials:c.credentials.public(),health:c.health.all(['nebius','together']),catalog:c.catalog.counts(),routing:await c.routing.load(),units:c.units.public(),budget:c.budget.public(),commercialLaunchApproved:false});
        }
        if(req.method==='GET'&&url.pathname==='/api/cloud/providers'){
          const out={};
          for(const p of ['nebius','together']){const h=await c.adapters[p].health();const key=c.credentials.public()[p];out[p]={...h,keyConfigured:key.configured,keySource:key.source};}
          return send(200,out);
        }
        if(req.method==='GET'&&url.pathname==='/api/cloud/models'){
          const refresh=url.searchParams.get('refresh')==='1';
          const provider=url.searchParams.get('provider')||null;
          if(refresh){const r=await c.catalog.refresh(provider);return send(200,{models:r.models,refresh:r.results,count:r.models.length});}
          const l=c.catalog.list({provider});
          return send(200,{models:l.models,stale:l.stale,fetchedAt:l.fetchedAt,count:l.count});
        }
        if(req.method==='GET'&&url.pathname==='/api/cloud/usage'){
          const limit=Number(url.searchParams.get('limit')||20);
          return send(200,{summary:await c.ledger.summary(),recent:await c.ledger.list({limit})});
        }
        if(req.method==='GET'&&url.pathname==='/api/cloud/routing'){
          return send(200,await c.routing.load());
        }
        if(req.method==='POST'&&url.pathname==='/api/cloud/chat'){
          let body='';req.on('data',d=>{body+=d;if(body.length>1e6)req.destroy();});
          req.on('end',async()=>{try{const j=JSON.parse(body||'{}');
            const result=await c.router.chat({modelId:j.model,messages:j.messages||[],temperature:Number(j.temperature??0.7),tools:j.tools||null,sessionSpentUsd:0,todaySpentUsd:0,request:{max_tokens:j.max_tokens||1024}});
            const m=(result.choices&&result.choices[0]&&result.choices[0].message)||{};
            return send(200,{...result,_meta:{...(result._meta||{}),providerUsed:result._meta.providerUsed,failover:result._meta.failover,cost:result._meta.cost,cloudUnits:result._meta.cloudUnits}});
          }catch(e){const status=e.code==='BUDGET_REJECTED'?400:(e.status||502);return send(status,{error:{message:String(e.message||e),code:e.code||'CLOUD_ERROR',type:'cloud_error'}});}});
          return;
        }
        return send(404,{error:{message:'Not found',type:'cloud_error'}});
      }catch(e){return send(500,{error:{message:String(e.message||e),type:'internal'}});}
    });
    return new Promise((resolve,reject)=>{this.server.listen(this.port,'127.0.0.1',()=>resolve(this.server));this.server.on('error',reject);});
  }
  close(){try{this.server&&this.server.close();}catch{}}
}
module.exports={CloudServer};
