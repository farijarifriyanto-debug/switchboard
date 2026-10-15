const {app,BrowserWindow,ipcMain,dialog,shell,safeStorage}=require('electron');
const path=require('node:path');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const {isSafeExternal,isTrustedNavigation,isTrustedSender,plainObject,providerName}=require('./security.cjs');
const {detectHardware}=require('../runtime/hardware.cjs');
const llama=require('../runtime/llama.cjs');
const hf=require('../runtime/hf.cjs');
const {DownloadManager}=require('../runtime/downloads.cjs');
const {RuntimeManager}=require('../runtime/runtime-manager.cjs');
const {Store}=require('../runtime/store.cjs');
const {scanInstalled}=require('../runtime/installed.cjs');
const {TOOL_DEFINITIONS,executeAllowedTool}=require('../runtime/tools.cjs');
const {claimOwnership,readOwnership,releaseOwnership,setChild,statePath}=require('../runtime/ownership.cjs');
const {McpClient}=require('../runtime/mcp.cjs');
const {CredentialManager,ENV_NAMES,STORE_FIELD}=require('../runtime/credentials.cjs');
const {NebiusProvider,DEFAULT_BASE_NEBIUS}=require('../runtime/cloud/nebius.cjs');
const {TogetherProvider,DEFAULT_BASE_TOGETHER}=require('../runtime/cloud/together.cjs');
const {ModelCatalog}=require('../runtime/cloud/catalog.cjs');
const {RoutingTable,DEFAULT_POLICY}=require('../runtime/cloud/routing.cjs');
const {HealthBoard}=require('../runtime/cloud/health.cjs');
const {UsageLedger}=require('../runtime/cloud/usage.cjs');
const {PricingRegistry}=require('../runtime/cloud/pricing.cjs');
const {UnitEngine}=require('../runtime/cloud/units.cjs');
const {BudgetGuard}=require('../runtime/cloud/budget.cjs');
const {CloudRouter}=require('../runtime/cloud/router.cjs');
const {estimateCost}=require('../runtime/cloud/cost.cjs');

let cloud=null; // initialized in whenReady: {credentials,catalog,routing,health,ledger,pricing,units,budget,router}
function cloudConfigured(){return Boolean(cloud);}
function initCloud(){
  const cloudDir=path.join(app.getPath('userData'),'cloud');
  const credentials=new CredentialManager({store,safeStorage});
  const adapters={
    nebius:new NebiusProvider({getKey:()=>credentials.source('nebius').source==='missing'?null:credentials.source('nebius').key}),
    together:new TogetherProvider({getKey:()=>credentials.source('together').source==='missing'?null:credentials.source('together').key})
  };
  const catalog=new ModelCatalog({adapters,cachedir:cloudDir});
  const routing=new RoutingTable({dir:cloudDir});
  const health=new HealthBoard({dir:cloudDir});health.restore().catch(()=>{});
  const ledger=new UsageLedger({dir:cloudDir});
  const pricing=new PricingRegistry({dir:cloudDir});
  const units=new UnitEngine({});
  const budget=new BudgetGuard({dir:cloudDir});
  const router=new CloudRouter({adapters,catalog,routing,health,ledger,pricing,units,budget});
  cloud={credentials,adapters,catalog,routing,health,ledger,pricing,units,budget,router,dir:cloudDir};
  return cloud;
}
function cloudPublic(){
  if(!cloud)return {configured:false,credentials:{},providers:{},safeStorageAvailable:false};
  return {
    configured:true,
    credentials:cloud.credentials.public(),
    health:cloud.health.all(['nebius','together']),
    catalog:cloud.catalog.counts(),
    units:cloud.units.public(),
    budget:cloud.budget.public()
  };
}

let win=null, store=null, downloads=null, runtimes=null, ownershipFile=null, mcpClients=new Map(), mcpStatuses=new Map();
function emit(channel,payload){if(win&&!win.isDestroyed())win.webContents.send(channel,payload);}
function getToken(){
  const enc=store?.get('hfTokenEncrypted');
  if(!enc||!safeStorage.isEncryptionAvailable())return '';
  try{return safeStorage.decryptString(Buffer.from(enc,'base64'));}catch{return '';}
}
function getApiToken(){
  const enc=store?.get('apiTokenEncrypted');
  if(!enc||!safeStorage.isEncryptionAvailable())return '';
  try{return safeStorage.decryptString(Buffer.from(enc,'base64'));}catch{return '';}
}
function bearerForRt(){return store?.get('apiAuthEnabled')&&getApiToken()?`Bearer ${getApiToken()}`:'Bearer local';}
function publicSettings(){const d=store.public();delete d.hfToken;delete d.hfTokenEncrypted;delete d.apiTokenEncrypted;return {...d,hfTokenConfigured:Boolean(store.get('hfTokenEncrypted')),apiAuthEnabled:Boolean(store.get('apiAuthEnabled')),apiTokenConfigured:Boolean(store.get('apiTokenEncrypted'))};}
function normalizeMcpConfig(input={}){
  const id=String(input.id||'').trim();
  const name=String(input.name||'').trim();
  const transport=String(input.transport||'stdio').toLowerCase();
  const command=String(input.command||'').trim();
  if(id&&!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw new Error('MCP id is invalid');
  if(!name||name.length>120)throw new Error('MCP server name is required');
  if(transport!=='stdio')throw new Error('Only stdio MCP transport is enabled in this beta');
  if(!command||command.includes('\u0000'))throw new Error('MCP executable/command is required');
  const args=Array.isArray(input.args)?input.args.map(String).slice(0,64):[];
  if(args.some(v=>v.includes('\u0000')||v.length>4096))throw new Error('MCP argument is invalid');
  const envRefs=Array.isArray(input.envRefs)?input.envRefs.map(String).filter(v=>/^[A-Z_][A-Z0-9_]*$/i.test(v)).slice(0,32):[];
  const allowedTools=[...new Set((Array.isArray(input.allowedTools)?input.allowedTools:[]).map(String).filter(Boolean).slice(0,128))];
  const toolPermissions={};for(const [tool,mode] of Object.entries(input.toolPermissions&&typeof input.toolPermissions==='object'?input.toolPermissions:{})){if(tool&&['ask','allow','deny'].includes(String(mode).toLowerCase()))toolPermissions[String(tool)]=String(mode).toLowerCase();}
  return {id:id||require('node:crypto').randomUUID(),name,transport,command,args,envRefs,enabled:input.enabled!==false,timeoutMs:Math.min(30000,Math.max(250,Number(input.timeoutMs||5000))),allowedTools,toolPermissions,permissionMode:['ask','allow','deny'].includes(String(input.permissionMode||'ask').toLowerCase())?String(input.permissionMode||'ask').toLowerCase():'ask',notes:String(input.notes||'').slice(0,500),provenance:String(input.provenance||'').slice(0,240)};
}
function runtimeConfig(input={}){
  if(!plainObject(input))throw new Error('Runtime configuration must be an object');
  for(const key of ['binary','modelPath','projector','apiKey'])if(input[key]!=null&&(!['string'].includes(typeof input[key])||input[key].length>4096||input[key].includes('\u0000')))throw new Error(`Runtime ${key} is invalid`);
  const port=Number(input.port||11435),context=Number(input.context||8192),gpuLayers=Number(input.gpuLayers??999),backend=String(input.backend||'auto').toLowerCase();
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Runtime port is invalid');
  if(!Number.isInteger(context)||context<256||context>262144||!Number.isInteger(gpuLayers)||gpuLayers<-1||gpuLayers>10000)throw new Error('Runtime limits are invalid');
  if(!['auto','cpu','vulkan','cuda12','cuda13','rocm','hip'].includes(backend))throw new Error('Runtime backend is invalid');
  return {...input,port,context,gpuLayers,backend};
}
function mcpStatusFor(config){return mcpStatuses.get(config.id)||{state:config.enabled?'configured':'disabled',tools:[],error:null};}
function mcpPublic(config){const status=mcpStatusFor(config);return {...config,status:status.state,tools:status.tools||[],error:status.error||null};}
function storedMcp(){const rows=store.get('mcpServers');return Array.isArray(rows)?rows:[];}
async function stopMcp(id){const client=mcpClients.get(id);if(client){await client.stop().catch(()=>{});mcpClients.delete(id);}}
async function testMcp(config){if(!config.enabled){mcpStatuses.set(config.id,{state:'disabled',tools:[],error:null});return mcpPublic(config);}await stopMcp(config.id);const client=new McpClient(config);mcpClients.set(config.id,client);mcpStatuses.set(config.id,{state:'connecting',tools:[],error:null});try{const tools=await client.listTools();mcpStatuses.set(config.id,{state:'connected',tools:tools.map(t=>t.name),error:null});return mcpPublic(config);}catch(error){await stopMcp(config.id);mcpStatuses.set(config.id,{state:'error',tools:[],error:String(error.message||error)});return mcpPublic(config);}}
function createWindow(){
  win=new BrowserWindow({width:1460,height:920,minWidth:1100,minHeight:720,backgroundColor:'#080b10',title:'BotConnector AI',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,experimentalFeatures:false}});
  win.webContents.setWindowOpenHandler(({url})=>{if(isSafeExternal(url))shell.openExternal(String(url)).catch(()=>{});return {action:'deny'};});
  win.webContents.on('will-navigate',(event,url)=>{if(!isTrustedNavigation(url))event.preventDefault();});
  win.webContents.on('will-redirect',(event,url)=>{if(!isTrustedNavigation(url))event.preventDefault();});
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  win.webContents.session.setPermissionCheckHandler(()=>false);
  win.loadFile(path.join(__dirname,'index.html'));
}
const rawIpcHandle=ipcMain.handle.bind(ipcMain),rawIpcOn=ipcMain.on.bind(ipcMain);
function assertTrustedSender(event){if(!isTrustedSender(event,win?.webContents))throw new Error('Untrusted IPC sender');}
function handle(channel,listener){return rawIpcHandle(channel,(event,...args)=>{assertTrustedSender(event);return listener(event,...args);});}
function on(channel,listener){return rawIpcOn(channel,(event,...args)=>{assertTrustedSender(event);return listener(event,...args);});}

app.whenReady().then(async()=>{
  store=new Store(app.getPath('userData'));store.load();ownershipFile=statePath(app.getPath('userData'));
  downloads=new DownloadManager({getModelsDir:()=>store.get('modelsDir'),getToken,emit});
  runtimes=new RuntimeManager({baseDir:path.join(app.getPath('userData'),'runtimes','llama.cpp'),emit});
  initCloud();
  createWindow();
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});

handle('system:overview',async()=>{
  const hardware=await detectHardware();
  return {hardware,runtime:llama.status(),runtimeOwnership:await readOwnership(ownershipFile),preferredLanguages:app.getPreferredSystemLanguages(),settings:publicSettings(),mcp:storedMcp().map(mcpPublic),managedRuntime:await runtimes.installed(),installed:await scanInstalled(store.get('modelsDir')),downloads:downloads.list()};
});
handle('system:open-external',async(_e,url)=>{if(!isSafeExternal(url))throw new Error('External URL is not allowed');await shell.openExternal(String(url));return true;});

handle('settings:get',async()=>publicSettings());
handle('settings:set',async(_e,input)=>{if(!plainObject(input))throw new Error('Settings payload must be an object');const allowed=['runtimeBackend','language','apiAuthEnabled'];for(const k of allowed)if(k in input)await store.set(k,k==='apiAuthEnabled'?Boolean(input[k]):String(input[k]).slice(0,64));return publicSettings();});
handle('settings:ensure-api-token',async()=>{const crypto=require('node:crypto');if(!safeStorage.isEncryptionAvailable())throw new Error('Windows credential encryption is unavailable');const token='bc-local-'+crypto.randomBytes(24).toString('hex');await store.set('apiTokenEncrypted',safeStorage.encryptString(token).toString('base64'));return {token,warning:'Shown once. Copy it now; the app never displays it again.'};});
handle('settings:clear-api-token',async()=>{await store.set('apiTokenEncrypted','');await store.set('apiAuthEnabled',false);return publicSettings();});
handle('settings:set-hf-token',async(_e,token)=>{token=String(token||'').trim();if(token.length>4096)throw new Error('Hugging Face token is too long');if(!token){await store.set('hfTokenEncrypted','');return {configured:false};}if(!safeStorage.isEncryptionAvailable())throw new Error('Windows credential encryption is unavailable');const enc=safeStorage.encryptString(token).toString('base64');await store.set('hfTokenEncrypted',enc);return {configured:true};});
handle('settings:pick-models-dir',async()=>{const r=await dialog.showOpenDialog({properties:['openDirectory','createDirectory'],title:'Choose model storage directory'});if(r.canceled)return null;await store.set('modelsDir',r.filePaths[0]);return {modelsDir:r.filePaths[0],installed:await scanInstalled(r.filePaths[0])};});

handle('mcp:list',async()=>storedMcp().map(mcpPublic));
handle('mcp:save',async(_e,input)=>{
  const config=normalizeMcpConfig(input||{}),rows=storedMcp(),index=rows.findIndex(row=>row.id===config.id),previous=mcpStatusFor(config);
  if(index>=0){await stopMcp(config.id);rows[index]=config;}else rows.push(config);
  await store.set('mcpServers',rows);if(previous.state==='connected')mcpStatuses.set(config.id,previous);else mcpStatuses.delete(config.id);return mcpPublic(config);
});
handle('mcp:remove',async(_e,id)=>{id=String(id||'');const rows=storedMcp().filter(row=>row.id!==id);if(rows.length===storedMcp().length)return false;await stopMcp(id);mcpStatuses.delete(id);await store.set('mcpServers',rows);return true;});
handle('mcp:test',async(_e,id)=>{const config=storedMcp().find(row=>row.id===String(id||''));if(!config)throw new Error('MCP server is not configured');return testMcp(config);});
handle('mcp:invoke',async(_e,{id,tool,args}={})=>{
  const config=storedMcp().find(row=>row.id===String(id||''));if(!config)throw new Error('MCP server is not configured');if(!config.enabled)throw new Error('MCP server is disabled');
  const toolName=String(tool||''),permission=String(config.toolPermissions?.[toolName]||config.permissionMode||'ask').toLowerCase();
  if(permission!=='allow')throw new Error(permission==='deny'?`MCP tool denied: ${toolName}`:`MCP tool approval required: ${toolName}`);
  if(!config.allowedTools.includes(toolName))throw new Error(`MCP tool is not allowlisted: ${toolName}`);
  let client=mcpClients.get(config.id);if(!client){client=new McpClient(config);mcpClients.set(config.id,client);}const result=await client.callTool(toolName,args||{});return {...result,provenance:config.provenance||config.name};
});

handle('models:search-online',async(_e,input)=>{if(!plainObject(input))throw new Error('Model search payload must be an object');const hardware=await detectHardware();return hf.searchModels({...input,hardware,token:getToken()});});
handle('models:details',async(_e,id)=>{if(typeof id!=='string'||!id||id.length>300)throw new Error('Model id is invalid');const hardware=await detectHardware();return hf.modelDetails({id,hardware,token:getToken()});});
handle('models:installed',async()=>scanInstalled(store.get('modelsDir')));
handle('models:reveal',async(_e,p)=>{if(typeof p!=='string'||!p)return false;shell.showItemInFolder(p);return true;});
handle('models:delete',async(_e,dir)=>{const root=path.resolve(store.get('modelsDir'));const target=path.resolve(String(dir||''));if(!target.startsWith(root+path.sep))throw new Error('Refusing to delete outside model directory');if(llama.status().running&&path.resolve(llama.status().modelPath||'').startsWith(target+path.sep))throw new Error('Stop the runtime before deleting this model');await fsp.rm(target,{recursive:true,force:true});return scanInstalled(root);});
handle('models:download',async(_e,payload)=>{if(!plainObject(payload))throw new Error('Download payload must be an object');return downloads.start(payload);});
handle('downloads:list',async()=>downloads.list());
handle('downloads:pause',async(_e,id)=>({ok:downloads.pause(String(id||''))}));
handle('downloads:resume',async(_e,id)=>({ok:downloads.resume(String(id||''))}));
handle('downloads:cancel',async(_e,id)=>({ok:downloads.cancel(String(id||''))}));

handle('runtime:pick-binary',async()=>{const r=await dialog.showOpenDialog({properties:['openFile'],filters:[{name:'llama-server',extensions:['exe']} ]});return r.canceled?null:r.filePaths[0];});
handle('runtime:pick-model',async()=>{const r=await dialog.showOpenDialog({properties:['openFile'],filters:[{name:'GGUF',extensions:['gguf']} ]});return r.canceled?null:r.filePaths[0];});
handle('runtime:latest',async()=>runtimes.latest());
handle('runtime:resolve',async(_e,cfg)=>runtimes.resolveBackend(plainObject(cfg)?String(cfg.backend||'vulkan'):'vulkan'));
handle('runtime:verify',async()=>runtimes.verifyInstalled());
handle('runtime:managed-status',async()=>runtimes.installed());
handle('runtime:install',async(_e,cfg)=>{if(!plainObject(cfg))throw new Error('Runtime configuration must be an object');return runtimes.install({backend:String(cfg.backend||'vulkan')});});
async function startOwnedRuntime(cfg){
  if(llama.status().running)throw new Error('Local runtime already running in the desktop process');
  const port=Number(cfg.port||11435);
  try{const h=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(800)});if(h.ok)throw new Error(`Port ${port} already serves a runtime`);}catch(e){if(e.message.includes('already serves'))throw e;}
  await claimOwnership({file:ownershipFile,ownerType:'desktop',port,modelPath:cfg.modelPath,backend:cfg.backend||store.get('runtimeBackend')||'auto',auth:Boolean(cfg.apiKey)});
  try{const started=llama.startLlama(cfg);await setChild(ownershipFile,started.pid);return started;}catch(error){await releaseOwnership(ownershipFile);throw error;}
}
handle('runtime:start',async(_e,cfg)=>startOwnedRuntime(runtimeConfig(cfg)));
handle('runtime:start-installed',async(_e,cfg)=>{
  cfg=runtimeConfig(cfg||{});const managed=await runtimes.installed();const binary=cfg.binary||managed.binary;if(!binary)throw new Error('No llama.cpp runtime installed. Install a managed runtime first.');
  const backend=cfg.backend||store.get('runtimeBackend')||'auto';const gpuLayers=backend==='cpu'?0:999;
  const apiKey=store.get('apiAuthEnabled')?getApiToken()||null:null;
  if(store.get('apiAuthEnabled')&&!apiKey)throw new Error('API authentication is enabled but no token exists. Generate one in Settings first.');
  return startOwnedRuntime({binary,modelPath:cfg.modelPath,projector:cfg.projector||null,port:Number(cfg.port||11435),gpuLayers,context:Number(cfg.context||8192),embedding:Boolean(cfg.embedding),jinja:true,apiKey,backend});
});
handle('runtime:stop',async()=>{const stopped=llama.stopLlama();if(stopped)await releaseOwnership(ownershipFile);return {stopped};});
handle('runtime:status',async()=>llama.status());
handle('runtime:logs',async()=>llama.logs());

handle('chat:complete',async(_e,messages)=>{
  const rt=llama.status();if(!rt.running)throw new Error('Local runtime is not running');const res=await fetch(`http://127.0.0.1:${rt.port||11435}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':bearerForRt()},body:JSON.stringify({model:'local-model',messages,temperature:.7,stream:false})});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data?.error?.message||`Runtime returned ${res.status}`);const msg=data?.choices?.[0]?.message||{};return {content:msg.content||'',reasoning:msg.reasoning_content||null,usage:data?.usage||null};
});
handle('chat:pick-image',async()=>{const r=await dialog.showOpenDialog({properties:['openFile'],filters:[{name:'Images',extensions:['png','jpg','jpeg','webp','gif']} ]});if(r.canceled)return null;const p=r.filePaths[0],b=await fsp.readFile(p);const ext=path.extname(p).slice(1).toLowerCase().replace('jpg','jpeg');return {name:path.basename(p),dataUrl:`data:image/${ext};base64,${b.toString('base64')}`};});

// ---------- Cloud IPC (secrets never cross to renderer as plaintext) ----------
handle('cloud:status',async()=>{
  const creds=cloud.credentials.public();
  const counts=cloud.catalog.counts();
  return {
    configured:true,
    credentials:creds,
    health:cloud.health.all(['nebius','together']),
    catalog:counts,
    routing:(await cloud.routing.load()).rules,
    units:cloud.units.public(),
    budget:cloud.budget.public(),
    commercialLaunchApproved:false
  };
});
handle('cloud:set-key',async(_e,{provider,key}={})=>{
  const p=providerName(provider);
  const value=String(key||'');
  if(!value||value.length>4096)throw new Error('Cloud credential is invalid');
  const res=await cloud.credentials.setKey(p,value);
  // best-effort live health right after key entry
  const h=await cloud.adapters[p].health();
  cloud.health.record(p,{ok:h.ok,status:h.status||0});
  return {provider:p,configured:res.configured,source:res.source,health:h.ok?'reachable':(h.reason||'unknown')};
});
handle('cloud:remove-key',async(_e,provider)=>cloud.credentials.removeKey(providerName(provider)));
handle('cloud:models',async(_e,{refresh=false,provider=null}={})=>{
  if(provider!=null)provider=providerName(provider);
  if(refresh){const r=await cloud.catalog.refresh(provider||null);return {models:r.models,refresh:r.results};}
  return cloud.catalog.list({provider:provider||null});
});
handle('cloud:usage',async()=>({summary:await cloud.ledger.summary(),recent:await cloud.ledger.list({limit:20})}));
handle('cloud:budget-set',async(_e,partial)=>{if(!plainObject(partial))throw new Error('Budget payload must be an object');await cloud.budget.set(partial);return cloud.budget.public();});
handle('cloud:chat',async(_e,{model,messages,options={}}={})=>{
  if(!model)return {ok:false,error:'model required'};
  if(!Array.isArray(messages)||messages.length>128||!plainObject(options))return {ok:false,error:'invalid cloud chat payload',code:'INVALID_ARGUMENT'};
  if(String(model).startsWith('local/'))return {ok:false,error:'local models use the local runtime path'};
  const spent=await cloud.ledger.summary();
  try{
    const out=await cloud.router.chat({modelId:model,messages,temperature:Number(options.temperature??.7),tools:options.tools===false?null:undefined,sessionSpentUsd:0,todaySpentUsd:0,request:{max_tokens:options.max_tokens||1024}});
    const m=(out.choices&&out.choices[0]&&out.choices[0].message)||{};
    return {ok:true,content:m.content||'',reasoning:m.reasoning_content||null,usage:out._meta.usage,meta:{providerUsed:out._meta.providerUsed,failover:out._meta.failover,retryCount:out._meta.retryCount,cost:out._meta.cost,cloudUnits:out._meta.cloudUnits,modelId:out._meta.modelId}};
  }catch(e){
    return {ok:false,error:String(e.message||e),code:e.code||'CLOUD_ERROR'};
  }
});

on('chat:stream',async(event,{requestId,messages,options={}})=>{
  const rt=llama.status();if(!rt.running){event.sender.send('chat:error',{requestId,error:'Local runtime is not running'});return;}
  try{
    let working=Array.isArray(messages)?messages.slice():[];
    for(let round=0;round<2;round++){
      const body={model:'local-model',messages:working,temperature:Number(options.temperature??.7),stream:true};
      if(round===0&&options.tools!==false){body.tools=TOOL_DEFINITIONS;body.tool_choice='auto';}
      const res=await fetch(`http://127.0.0.1:${rt.port||11435}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':bearerForRt()},body:JSON.stringify(body)});
      if(!res.ok)throw new Error(`Runtime returned ${res.status}`);
      const reader=res.body.getReader();const dec=new TextDecoder();let buf='',toolCalls=[];
      while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const lines=buf.split(/\r?\n/);buf=lines.pop()||'';for(const line of lines){if(!line.startsWith('data:'))continue;const raw=line.slice(5).trim();if(!raw||raw==='[DONE]')continue;try{const j=JSON.parse(raw);const delta=j?.choices?.[0]?.delta||{};if(delta.content)event.sender.send('chat:delta',{requestId,delta:delta.content});if(delta.reasoning_content)event.sender.send('chat:reasoning',{requestId,delta:String(delta.reasoning_content)});if(Array.isArray(delta.tool_calls))for(const tc of delta.tool_calls){const idx=Number(tc.index||0);const cur=toolCalls[idx]||(toolCalls[idx]={id:'',type:'function',function:{name:'',arguments:''}});if(tc.id)cur.id=tc.id;if(tc.type)cur.type=tc.type;if(tc.function?.name)cur.function.name+=tc.function.name;if(typeof tc.function?.arguments==='string')cur.function.arguments+=tc.function.arguments;event.sender.send('chat:toolcall',{requestId,toolCall:tc});}}catch{}}}
      if(round===0&&toolCalls.length){
        const results=toolCalls.map(call=>({call,result:executeAllowedTool(call)}));
        for(const {call,result} of results)event.sender.send('chat:toolresult',{requestId,toolCallId:call.id||null,...result});
        working=[...working,{role:'assistant',content:null,tool_calls:toolCalls},...results.map(({call,result})=>({role:'tool',tool_call_id:call.id,content:JSON.stringify(result.ok?result.result:{error:result.error})}))];
        continue;
      }
      break;
    }
    event.sender.send('chat:done',{requestId});
  }catch(e){event.sender.send('chat:error',{requestId,error:String(e.message||e)});}
});

app.on('before-quit',()=>{for(const client of mcpClients.values())client.stop().catch(()=>{});mcpClients.clear();if(llama.status().running){llama.stopLlama();releaseOwnership(ownershipFile).catch(()=>{});}});
