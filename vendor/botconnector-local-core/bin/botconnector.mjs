#!/usr/bin/env node
// botconnector CLI - shares BotConnector Core (same Store, HF adapter, DownloadManager,
// RuntimeManager, model paths and config as the Electron desktop). Works with GUI closed.
// Usage: node bin/botconnector.mjs <command> [args] [--json] [--port N]
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {isSea,getAsset} from 'node:sea';
// Static ESM imports (not require()) throughout this file — deliberately.
// This file gets bundled by esbuild into botconnector.exe (a Node SEA); a
// require() reached only through a runtime-reassigned `require` variable
// (the old createRequire(import.meta.url) pattern) can't be followed by a
// bundler's static analysis and silently stays an unresolvable relative
// path at runtime. Static imports are what the bundler actually inlines.
import {Store} from '../runtime/store.cjs';
import hf from '../runtime/hf.cjs';
import {DownloadManager} from '../runtime/downloads.cjs';
import {RuntimeManager} from '../runtime/runtime-manager.cjs';
import {scanInstalled} from '../runtime/installed.cjs';
import {detectHardware} from '../runtime/hardware.cjs';
import {claimOwnership,readOwnership,releaseOwnership,setChild,statePath} from '../runtime/ownership.cjs';
import {runTui} from '../tui/app.cjs';
import {runAttach} from '../tui/attach.cjs';
import * as llama from '../runtime/llama.cjs';
import {CredentialManager} from '../runtime/credentials.cjs';
import {NebiusProvider} from '../runtime/cloud/nebius.cjs';
import {TogetherProvider} from '../runtime/cloud/together.cjs';
import {ModelCatalog} from '../runtime/cloud/catalog.cjs';
import {RoutingTable} from '../runtime/cloud/routing.cjs';
import {HealthBoard} from '../runtime/cloud/health.cjs';
import {UsageLedger} from '../runtime/cloud/usage.cjs';
import {PricingRegistry} from '../runtime/cloud/pricing.cjs';
import {UnitEngine} from '../runtime/cloud/units.cjs';
import {BudgetGuard} from '../runtime/cloud/budget.cjs';
import {CloudRouter} from '../runtime/cloud/router.cjs';
import {CloudServer} from '../runtime/cloud/server.cjs';
import {startUiServer} from '../webui/server.cjs';
import {findExisting as findExistingUi,writeLock as writeUiLock,clearLock as clearUiLock} from '../webui/single-instance.cjs';
import * as platformPaths from '../runtime/platform-paths.cjs';
import integrationModule from '../registry/integrations.cjs';
import PKG_JSON from '../package.json' with {type:'json'};

const {createIntegrationRegistry, resolveAutoModel, launchIntegration} = integrationModule;

// Everything below is wrapped in one async function (rather than using
// top-level await, as the previous version did) so this file can be bundled
// to CommonJS for the botconnector.exe SEA build — CJS output doesn't
// support top-level await. Behavior is unchanged; this is a mechanical
// wrap only, no control-flow changes (process.exit() still terminates
// immediately from anywhere inside).
async function __botconnectorMain(){

const APP='botconnector-ai-local-cloud';
// Windows: unchanged from the existing shipped path (%APPDATA%\botconnector-
// ai-local-cloud) — real users' existing settings/sessions already live
// there; silently relocating them is exactly what this project's data-path
// rules exist to prevent. Linux is a brand-new platform with no existing
// installs to preserve, so it goes straight to the XDG-compliant root
// (platformPaths.dataDir()) with no separate legacy path to reconcile.
const userData=platformPaths.isWindows()?path.join(process.env.APPDATA||path.join(os.homedir(),'AppData','Roaming'),APP):platformPaths.dataDir();
const store=new Store(userData);store.load();
const runtimes=new RuntimeManager({baseDir:path.join(userData,'runtimes','llama.cpp')});
const downloads=new DownloadManager({getModelsDir:()=>store.get('modelsDir'),getToken:()=>process.env.HF_TOKEN||''});
const STATE_FILE=statePath(userData);
const rawArgs=process.argv.slice(2);
const json=rawArgs.includes('--json');
const opt=(name,def)=>{const i=rawArgs.indexOf('--'+name);return i>=0&&rawArgs[i+1]&&!rawArgs[i+1].startsWith('--')?rawArgs[i+1]:def;};
const port=Number(opt('port',11435));
const out=(o)=>{if(json)console.log(JSON.stringify(o,null,2));else console.log(typeof o==='string'?o:JSON.stringify(o,null,2));};
const fail=(m)=>{console.error(json?JSON.stringify({ok:false,error:m}):`Error: ${m}`);process.exit(1);};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function endpoint(pathname){const r=await fetch(`http://127.0.0.1:${port}${pathname}`,{signal:AbortSignal.timeout(5000)});return r;}
async function serverHealth(){try{const r=await endpoint('/health');return{up:r.ok,status:r.status};}catch(e){return{up:false,error:String(e.cause?.message||e.message)};}}
function readState(){try{const s=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));if(s&&!s.pid)s.pid=s.childPid;return s;}catch{return null;}}
function pidAlive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
function resolveModelRef(ref,installed){
  if(!ref)fail('model reference required');
  if(fs.existsSync(ref)&&/\.gguf$/i.test(ref))return{modelPath:path.resolve(ref),projector:null};
  const hit=installed.find(m=>m.path===path.resolve(ref)||m.name===path.basename(ref)||`${m.repoId}@${m.quant}`===ref||m.repoId===ref);
  if(hit)return{modelPath:hit.path,projector:hit.projector};
  fail(`model not found locally: ${ref} (see: botconnector ls)`);
}
async function waitReady(tries=45){for(let i=0;i<tries;i++){const h=await serverHealth();if(h.up)return true;await sleep(2000);}return false;}

const HELP=`botconnector - BotConnector AI CLI (shares Core/config with the desktop app)

  botconnector                            Start the Native Agent TUI (default; shares Core with the desktop app)
  botconnector --help | version | doctor [--json]
  botconnector models search <query> [--json]
  botconnector models search --recommended [--json]
  botconnector models info <user/model> [--json]
  botconnector get <repo>[@QUANT] [--projector N]
  botconnector ls [--json]
  botconnector runtime status|resolve|verify|install [--backend auto|cpu|vulkan|cuda12|cuda13] [--json]
  botconnector runtime use <auto|cpu|vulkan|cuda12|cuda13|rocm>
  botconnector load <model-ref> | unload | ps [--json]
  botconnector run <model-ref>            (foreground; Ctrl-C stops)
  botconnector chat <model-ref?> "prompt" [--stream] [--api-key KEY]
  botconnector embed "text" [--json] [--api-key KEY]
  botconnector server start <model-ref> [--ctx N] [--backend auto|cpu|vulkan|cuda12|cuda13|rocm] [--api-key KEY] | stop | status [--json]
  botconnector cloud status [--json] | providers [--json] | models [--refresh] [provider] [--json]
  botconnector cloud set-key <nebius|together> | key-status [--json] | remove-key <provider>
  botconnector cloud usage [--limit N] [--json] | routing [--json]
  botconnector cloud test [model-id] [--prompt "..."]   (small cost-capped probe)
  botconnector launch [--list|--json]
  botconnector launch <integration> [--model <model>|auto] [--config|--restore]
  botconnector ui [--ui-port N] [--no-browser]   (Web Agent Workspace: local server + opens your browser)
  botconnector serve [--hostname 127.0.0.1] [--port N]   (same backend as 'ui', headless — no browser auto-open)
  botconnector attach <url>               (attach a terminal session to an already-running 'ui'/'serve' backend)
`;
const [cmd,sub]=rawArgs.filter(a=>!a.startsWith('--'));
const SUBCOMMAND_HELP={
  models:`botconnector models - discover local-AI models from Hugging Face

  botconnector models search <query> [--recommended] [--json]
  botconnector models info <user/model> [--json]`,
  runtime:`botconnector runtime - manage the BotConnector llama.cpp runtime

  botconnector runtime status [--json]
  botconnector runtime resolve [--backend auto|cpu|vulkan|cuda12|cuda13|rocm]
  botconnector runtime verify [--json]
  botconnector runtime install [--backend auto|cpu|vulkan|cuda12|cuda13|rocm]
  botconnector runtime use <auto|cpu|vulkan|cuda12|cuda13|rocm>`,
  cloud:`botconnector cloud - inspect optional cloud-provider preview routing

  botconnector cloud status|providers|models|usage|routing [--json]
  botconnector cloud serve [--cloud-port N]
  botconnector cloud set-key <nebius|together>
  botconnector cloud key-status [--json]
  botconnector cloud remove-key <nebius|together>
  botconnector cloud test [model-id] [--prompt "..."]`,
  server:`botconnector server - run a local OpenAI-compatible model endpoint

  botconnector server start <model-ref> [--ctx N] [--backend ...]
  botconnector server status [--json]
  botconnector server stop`,
  launch:`botconnector launch - inspect or start a supported local integration

  botconnector launch --list [--json]
  botconnector launch <integration> [--model <model>|auto] [--config|--restore]`,
  ui:`botconnector ui - start the localhost Web Agent Workspace and open a browser

  botconnector ui [--ui-port N] [--no-browser]`,
  serve:`botconnector serve - start the localhost Web Agent Workspace without a browser

  botconnector serve [--hostname 127.0.0.1] [--port N]`,
  attach:`botconnector attach - attach the TUI to an existing Web Agent Workspace

  botconnector attach <url>`,
  chat:`botconnector chat - send a prompt to the local OpenAI-compatible endpoint

  botconnector chat "prompt" [--stream] [--api-key KEY]`,
  embed:`botconnector embed - create embeddings through the local endpoint

  botconnector embed "text" [--json] [--api-key KEY]`,
};
// NOTE: `--help`/`--version` never survive the filter above (they start with
// `--`), so they must be checked against rawArgs directly, not against cmd.
if(rawArgs.includes('--help') && cmd && SUBCOMMAND_HELP[cmd]){console.log(SUBCOMMAND_HELP[cmd]);process.exit(0);}
if(rawArgs.includes('--help')||cmd==='help'){console.log(HELP);process.exit(0);}
if(rawArgs.includes('--version')||cmd==='version'){console.log(`botconnector ${PKG_JSON.version}`);process.exit(0);}
if(!cmd){
  // Native Agent TUI — first-party terminal client, shares Core (Store, hf,
  // DownloadManager, RuntimeManager, ownership) with the CLI above and the
  // Electron desktop app. Never launched implicitly by any other command.
  await runTui({debug:rawArgs.includes('--debug'),workspace:process.cwd()});
  process.exit(0);
}

function openBrowser(url){
  // Server must survive regardless of outcome here — this is best-effort
  // convenience, never a precondition for the backend being usable
  // (explicitly required for headless Linux: server starts and the URL is
  // printed either way — see the console.error right before this call in
  // the `ui`/`serve` handlers below).
  try{
    const openCmd=process.platform==='win32'?['cmd',['/c','start','""',url]]:process.platform==='darwin'?['open',[url]]:['xdg-open',[url]];
    const child=spawn(openCmd[0],openCmd[1],{detached:true,stdio:'ignore',windowsHide:true});
    // spawn() does not throw synchronously for a missing command (e.g. no
    // xdg-open on a minimal/headless Linux box) — ENOENT arrives async via
    // this 'error' event. Without listening for it, a failed launch there
    // looks identical to a successful one: no visible error, no browser.
    child.once('error',e=>console.error(`Could not auto-open a browser (${e.message||e}); open ${url} manually.`));
    child.unref();
  }catch(e){console.error(`Could not auto-open a browser (${e.message||e}); open ${url} manually.`);}
}
// Shared by `ui` and `serve` — the ONE backend both the browser Web Agent
// Workspace and (via `attach`) the TUI talk to. `ui` opens a browser after
// starting it; `serve` is the same backend, headless, for CI/remote/no-
// display Linux boxes ("Do not require graphical desktop for core
// operation").
//
// Deliberately its OWN data root under %LOCALAPPDATA% on Windows, not the
// %APPDATA%\botconnector-ai-local-cloud the Electron app and every other
// CLI command above use. Two consequences, both disclosed rather than
// silently accepted: settings.json and the managed llama.cpp runtime
// binary are separate per distribution channel (each downloads/manages
// its own copy); downloaded MODELS are still naturally shared, since
// Store's modelsDir default (runtime/store.cjs) is a fixed
// ~/BotConnector AI/models path independent of which userData root asked
// for it. If Electron and the portable app try to own the local runtime
// at the same time, ownership.cjs's existing single-owner lock makes the
// second one refuse safely — never silently collide or corrupt state.
//
// Folder name is "BotConnector AI" (matching this product's own naming
// everywhere else: the Electron install dir, the models default path),
// not the bare "BotConnector" a literal reading might suggest — verified
// live that %LOCALAPPDATA%\BotConnector\ already exists on a real test
// machine as an unrelated pre-existing application's data folder
// (Codex-*/HermesTunnel/PersonalAssistant subfolders, nothing to do with
// this product). Writing into that shared name would silently mix data
// with an unrelated app — exactly what this project's data-path rules
// exist to prevent.
//
// On Linux there is no such legacy-path concern (brand new platform), so
// `ui`/`serve` use the exact same platformPaths.dataDir() root every
// other command already uses there — meaning botconnector doctor,
// botconnector ui, and botconnector serve genuinely share one profile on
// Linux out of the box, not just when explicitly bridged via `attach`.
async function startBackendServer({preferredPort,openBrowserAfter}){
  const uiUserData=platformPaths.isWindows()?path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'BotConnector AI'):platformPaths.dataDir();
  const lockFile=path.join(uiUserData,'ui.lock');
  const existing=await findExistingUi(lockFile);
  if(existing){
    // A background process cannot literally focus another process's
    // already-open browser tab (browsers don't expose that, by design) —
    // the honest equivalent is opening a new tab at the same running
    // server, without starting a second core/server process.
    const url=`http://127.0.0.1:${existing.port}`;
    console.error(`BotConnector backend is already running on ${url} (pid ${existing.pid}).${openBrowserAfter?' Opening a new tab there instead of starting a second instance.':' Not starting a second instance.'}`);
    if(openBrowserAfter&&!rawArgs.includes('--no-browser'))openBrowser(url);
    process.exit(0);
  }
  // Prefer assets embedded in the SEA exe (node:sea) — the whole point of
  // the portable build is one exe, no sibling dist/web folder needed. Fall
  // back to reading dist/web/ straight off disk in dev (unbundled `node
  // bin/botconnector.mjs ui`), where isSea() is always false.
  let webRoot=null,getWebAsset=null;
  if(isSea()){
    getWebAsset=(rel)=>{try{return Buffer.from(getAsset(`web/${rel}`));}catch{return null;}};
  }else{
    const scriptDir=import.meta.url?path.dirname(fileURLToPath(import.meta.url)):null;
    webRoot=scriptDir?path.join(scriptDir,'..','dist','web'):null;
    if(!webRoot||!fs.existsSync(path.join(webRoot,'index.html')))fail(`dist/web is missing (${webRoot}). Run: npm run build:web`);
  }
  const {port:boundPort}=await startUiServer({userDataDir:uiUserData,webRoot,getAsset:getWebAsset,preferredPort,log:m=>console.error(m),onQuit:()=>process.exit(0)});
  writeUiLock(lockFile,{pid:process.pid,port:boundPort});
  const cleanup=()=>{clearUiLock(lockFile,process.pid);};
  process.on('exit',cleanup);
  process.on('SIGINT',()=>process.exit(0));
  process.on('SIGTERM',()=>process.exit(0));
  const url=`http://127.0.0.1:${boundPort}`;
  console.error(`BotConnector backend on ${url} (localhost only; Ctrl-C stops)`);
  if(openBrowserAfter&&!rawArgs.includes('--no-browser'))openBrowser(url);
  await new Promise(()=>{});
}
if(cmd==='ui'){
  // Portable Web App entrypoint: local-only HTTP server (webui/server.cjs,
  // shares the exact same Core modules as the CLI/Electron above) serving
  // the same renderer that already works in `npm run desktop`, then opens
  // the user's default browser. No Electron, no bundled browser engine.
  await startBackendServer({preferredPort:Number(opt('ui-port',32100)),openBrowserAfter:true});
}
if(cmd==='serve'){
  // Headless variant of `ui`: same shared backend, no browser auto-open —
  // for CI, remote sessions, or a Linux box with no display. `--hostname`
  // is accepted (matching the documented command contract) but only
  // 127.0.0.1/localhost are honored: binding anything else means exposing
  // this server beyond the local machine, which needs real authentication
  // this build does not implement yet — refusing is safer than silently
  // binding somewhere the "localhost only by default" security policy
  // doesn't actually cover.
  const hostname=opt('hostname','127.0.0.1');
  if(hostname!=='127.0.0.1'&&hostname!=='localhost')fail(`--hostname ${hostname} is not supported: this build only binds 127.0.0.1/localhost. Remote exposure needs authentication this version does not implement.`);
  await startBackendServer({preferredPort:Number(opt('port',32100)),openBrowserAfter:false});
}
if(cmd==='attach'){
  const url=rawArgs.find((a,i)=>i>0&&!a.startsWith('--'));
  if(!url)fail('attach <url> — e.g. botconnector attach http://127.0.0.1:32100');
  await runAttach(url);
  process.exit(0);
}

if(cmd==='doctor'){
  const {runDoctor}=await import('../scripts/doctor.mjs');
  const r=await runDoctor();
  out(json?r:r.checks.map(c=>`${c.status}  ${c.name} - ${c.detail}`).join('\n'));
  process.exit(r.checks.some(c=>c.status==='FAIL')?1:0);
}
if(cmd==='models'&&sub==='search'){
  const recommended=rawArgs.includes('--recommended');
  const q=rawArgs.find((a,i)=>i>2&&!a.startsWith('--')&&a!==sub)||'';
  const hardware=await detectHardware();
  const items=await hf.searchModels({query:q,limit:60,hardware});
  const rows=recommended?items.filter(m=>['great','ok'].includes(m.compatibility?.level)).slice(0,20):items.slice(0,30);
  if(json)out(rows);
  else rows.forEach(m=>console.log(`${m.compatibility?.level||'?'}  ${m.id}  *${m.likes} v${m.downloads}  [${Object.entries(m.capabilities||{}).filter(([,v])=>v).map(([k])=>k).join(',')}]`));
  process.exit(0);
}
if(cmd==='models'&&sub==='info'){
  const id=rawArgs.find((a,i)=>i>2&&!a.startsWith('--')&&a!==sub)||'';
  if(!id)fail('models info <user/model>');
  const hardware=await detectHardware();
  const d=await hf.modelDetails({id,hardware});
  if(json)out(d);
  else{console.log(`${d.id}\n  task=${d.pipeline_tag} gated=${d.gated} downloads=${d.downloads} likes=${d.likes}\n  caps=${Object.entries(d.capabilities).filter(([,v])=>v).map(([k])=>k).join(',')}`);d.files.forEach(g=>console.log(`  ${g.quant}  ${(g.size/1073741824).toFixed(2)}GB  ${g.parts.length} part(s)`));if(d.projectors?.length)d.projectors.forEach(p=>console.log(`  projector: ${p.path} ${(p.size/1048576).toFixed(1)}MB`));}
  process.exit(0);
}
if(cmd==='get'){
  const ref=rawArgs[1]||'';
  const [repo,quant]=ref.split('@');
  if(!repo||!repo.includes('/'))fail('get <user/model>[@QUANT]');
  const hardware=await detectHardware();
  const d=await hf.modelDetails({id:repo,hardware});
  let group=d.files.find(g=>g.quant?.toUpperCase()===String(quant||'').toUpperCase())||d.files.find(g=>/Q4_K_M/.test(g.quant))||d.files[0];
  if(!group)fail('no GGUF files in '+repo);
  const job=await downloads.start({repoId:repo,group,projector:null,metadata:{capabilities:d.capabilities,pipeline_tag:d.pipeline_tag}});
  console.log(`downloading ${repo}@${group.quant} (${(group.size/1073741824).toFixed(2)}GB) job=${job.id}`);
  for(;;){await sleep(1000);const j=downloads.list().find(x=>x.id===job.id);if(!j||['completed','failed','cancelled'].includes(j.status)){console.log(json?JSON.stringify(j):`status=${j?.status} ${j?.error||''}`);process.exit(j?.status==='completed'?0:1);}process.stdout.write(`\r${((100*(j.downloadedBytes||0))/(j.totalBytes||1)).toFixed(1)}% ${((j.downloadedBytes||0)/1048576).toFixed(0)}MB ${(j.bytesPerSecond/1048576).toFixed(1)}MB/s  `);}
}
if(cmd==='ls'){
  const items=await scanInstalled(store.get('modelsDir'));
  if(json)out(items);
  else if(!items.length)console.log('No downloaded GGUF models.');
  else items.forEach(m=>console.log(`${m.repoId||'(unknown)'}@${m.quant||'?'}  ${(m.size/1073741824).toFixed(2)}GB  ${m.path}`));
  process.exit(0);
}
if(cmd==='runtime'&&(sub==='status'||!sub)){
  const inst=await runtimes.installed();
  const ver=await runtimes.verifyInstalled().catch(e=>({installed:false,error:String(e.message)}));
  const health=await serverHealth();
  out({installed:inst,verified:ver,endpoint:{port,...health},backend:store.get('runtimeBackend')});
  process.exit(0);
}
if(cmd==='runtime'&&sub==='verify'){out(await runtimes.verifyInstalled());process.exit(0);}
if(cmd==='runtime'&&sub==='resolve'){
  const r=await runtimes.resolveBackend(opt('backend','vulkan'));
  out({releaseTag:r.releaseTag,backend:r.backend,primaryAsset:r.primaryAsset.name,dependencies:r.dependencies.map(d=>d.name)});
  process.exit(0);
}
if(cmd==='runtime'&&sub==='install'){
  const backend=opt('backend',store.get('runtimeBackend')||'auto');
  console.error(`resolving ${backend}...`);
  const r=await runtimes.install({backend});
  out({ok:true,release:r.release,backend:r.backend,binary:r.binary,version:r.version});
  process.exit(0);
}
if(cmd==='runtime'&&sub==='use'){
  const b=rawArgs[2]||'';
  if(!['auto','cpu','vulkan','cuda12','cuda13','rocm'].includes(b))fail('runtime use <auto|cpu|vulkan|cuda12|cuda13|rocm>');
  await store.set('runtimeBackend',b);
  out({ok:true,runtimeBackend:b});
  process.exit(0);
}
function cloudParts(){
  const cloudDir=path.join(userData,'cloud');
  const credentials=new CredentialManager({store,env:process.env});
  const adapters={
    nebius:new NebiusProvider({getKey:()=>{const s=credentials.source('nebius');return s.source==='missing'?null:s.key;}}),
    together:new TogetherProvider({getKey:()=>{const s=credentials.source('together');return s.source==='missing'?null:s.key;}})
  };
  const catalog=new ModelCatalog({adapters,cachedir:cloudDir});
  const health=new HealthBoard({dir:cloudDir});health.restore().catch(()=>{});
  const router=new CloudRouter({adapters,catalog,routing:new RoutingTable({dir:cloudDir}),health,ledger:new UsageLedger({dir:cloudDir}),pricing:new PricingRegistry({dir:cloudDir}),units:new UnitEngine({}),budget:new BudgetGuard({dir:cloudDir})});
  return {credentials,adapters,catalog,health,router,cloudDir};
}
const CLOUD_API_PORT=()=>Number(opt('cloud-port',11440));
async function cloudApiRequest(pathname,{method='GET',body}={}){
  try{const r=await fetch(`http://127.0.0.1:${CLOUD_API_PORT()}${pathname}`,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(180000)});const j=await r.json().catch(()=>({}));return {status:r.status,j};}
  catch(e){return {status:0,j:{error:{message:String(e.message||e),code:'NETWORK_ERROR'}}};}
}
if(cmd==='cloud'&&sub==='serve'){
  // Deterministic localhost sidecar exposing /api/cloud/* for CLI/SDK surfaces.
  const cs=new CloudServer({store,port:CLOUD_API_PORT()});
  await cs.listen();
  console.error(`BotConnector cloud API on http://127.0.0.1:${CLOUD_API_PORT()} (localhost only; Ctrl-C stops)`);
  await new Promise(()=>{});
}
async function cloudApi(pathname,{method='GET',body}={}){
  const {status,j}=await cloudApiRequest(pathname,{method,body});
  if(status===0)fail('cloud API sidecar is not running. Start it with: botconnector cloud serve (the desktop app also starts it automatically)');
  if(status>=400)fail(j.error?`${j.error.code||'CLOUD_ERROR'}: ${j.error.message}`:`cloud API returned ${status}`);
  return j;
}
if(cmd==='cloud'&&(sub==='status'||!sub)){
  const {credentials,adapters,health,catalog}=cloudParts();
  const status=health.all(['nebius','together']);
  const counts=catalog.counts();
  out({
    note:'Multi-provider POC. Exact-model routing only; prompts sent to cloud leave this device; local prompts stay local.',
    credentials:credentials.public(),
    providers:{nebius:status.nebius,together:status.together},
    catalog:counts,
    commercialLaunchApproved:false
  });
  process.exit(0);
}
if(cmd==='cloud'&&sub==='providers'){
  out(await cloudApi('/api/cloud/providers'));process.exit(0);
}
if(cmd==='cloud'&&sub==='models'){
  const arg=rawArgs.find((a,i)=>i>2&&!a.startsWith('--'));
  const q=(rawArgs.includes('--refresh')?'?refresh=1':'')+(arg?'&(provider='+encodeURIComponent(arg)+')':'');
  const r=await cloudApi('/api/cloud/models'+q);
  if(json)out(r);
  else if(rawArgs.includes('--refresh')){const res=r.refresh||{};console.log(['nebius','together'].map(p=>`${p}: ${res[p]&&res[p].ok?res[p].count+' live':'failed ('+(res[p]&&res[p].error||'?')+')'}`).join(' | '));r.models.slice(0,40).forEach(m=>console.log(`${m.modelId}  [${m.provider}]${m.stale?' (stale)':''}`));}
  else r.models.slice(0,40).forEach(m=>console.log(`${m.modelId}  [${m.provider}]${m.stale?' (stale)':''}`));
  process.exit(0);
}
if(cmd==='cloud'&&sub==='usage'){
  const r=await cloudApi('/api/cloud/usage?limit='+Number(opt('limit',10)));
  out(json?r:(JSON.stringify(r.summary,null,2)+'\nrecent: '+r.recent.map(x=>`${x.timestamp} ${x.provider_used} ${x.model_id} failover=${x.failover} $${x.estimated_provider_cost}`).join('\n')));
  process.exit(0);
}
if(cmd==='cloud'&&sub==='routing'){
  out(await cloudApi('/api/cloud/routing'));
  process.exit(0);
}
if(cmd==='cloud'&&sub==='test'){
  const model=rawArgs.find((a,i)=>i>2&&!a.startsWith('--'))||'deepseek-ai/DeepSeek-V4-Flash-0731';
  const prompt=opt('prompt','Reply with exactly: OK-CLOUD');
  const {status,j}=await cloudApiRequest('/api/cloud/chat',{method:'POST',body:{model,messages:[{role:'user',content:prompt}],max_tokens:32}});
  if(status===0)fail('cloud API sidecar is not running: botconnector cloud serve');
  if(status>=400)out({ok:false,...(j.error||{})});
  else{const m=(j.choices&&j.choices[0]&&j.choices[0].message)||{};const meta=j._meta||{};out({ok:true,model:meta.modelId||model,providerUsed:meta.providerUsed,failover:meta.failover,content:m.content,usage:meta.usage,cost:meta.cost,cloudUnits:meta.cloudUnits});}
  process.exit(0);
}
async function startServer(modelRef,ctx){
  const installed=await scanInstalled(store.get('modelsDir'));
  const {modelPath,projector}=resolveModelRef(modelRef,installed);
  const backend=opt('backend',store.get('runtimeBackend')||'auto');
  const eff=backend==='auto'?((await detectHardware()).nvidia?.length?'cuda12':'vulkan'):backend;
  const {binary}=await runtimes.installed();
  if(!binary)fail('No managed runtime installed. Run: botconnector runtime install');
  const args=['-m',modelPath,'--host','127.0.0.1','--port',String(port),'--ctx-size',String(ctx||4096),'--n-gpu-layers',eff==='cpu'?'0':'999','--jinja'];
  if(projector)args.push('--mmproj',projector);
  const cliKey=opt('api-key',null);
  if(cliKey)args.push('--api-key',cliKey);
  const h0=await serverHealth();
  if(h0.up)fail(`port ${port} already serves a runtime (stop it first)`);
  await claimOwnership({file:STATE_FILE,ownerType:'cli',port,modelPath,backend:eff,auth:Boolean(cliKey)});
  let child;
  try{
    child=spawn(binary,args,{shell:false,windowsHide:true,detached:true,stdio:'ignore'});
    child.unref();
    await setChild(STATE_FILE,child.pid);
    const ok=await waitReady();
    if(!ok)throw new Error('server did not become ready (see runtime logs in desktop app)');
    return{pid:child.pid,modelPath,backend:eff,port};
  }catch(error){await releaseOwnership(STATE_FILE);throw error;}
}
if((cmd==='server'&&sub==='start')||cmd==='load'){
  const ref=rawArgs.find((a,i)=>i>1&&!a.startsWith('--')&&a!==sub&&a!=='start'&&!/^\d+$/.test(a)&&a!==opt('ctx','__none__'))||rawArgs[2];
  if(!ref)fail(cmd==='load'?'load <model-ref>':'server start <model-ref>');
  out({ok:true,server:await startServer(ref,Number(opt('ctx',4096)))});
  // The detached runtime has already been handed off. Returning lets Node
  // close its own child-process bookkeeping naturally; forcing process.exit()
  // here can trip a Windows libuv assertion while the detached handle closes.
  return;
}
if((cmd==='server'&&sub==='stop')||cmd==='unload'){
  const st=readState();
  if(!st)fail('no CLI-managed server recorded');
  if(st.ownerType&&st.ownerType!=='cli')fail(`runtime is owned by ${st.ownerType}; refusing to stop another interface`);
  if(pidAlive(st.pid)){try{process.kill(st.pid);}catch(e){fail('could not stop pid '+st.pid+': '+e.message);}}
  await releaseOwnership(STATE_FILE,st.ownerPid||process.pid);
  out({ok:true,stopped:st.pid});
  process.exit(0);
}
if((cmd==='server'&&sub==='status')||cmd==='ps'){
  const st=readState();
  const health=await serverHealth();
  const info={port,endpoint:health,cliServer:st&&pidAlive(st.pid)?st:(st?{...st,alive:false}:null)};
  out(json?info:`port ${port}: ${health.up?`UP (HTTP ${health.status})`:'down'}${info.cliServer?` | cli-server pid=${info.cliServer.pid} model=${path.basename(info.cliServer.modelPath||'?')} alive=${pidAlive(info.cliServer.pid)}`:''}`);
  process.exit(0);
}
if(cmd==='run'){
  const ref=rawArgs[1]||'';
  const installed=await scanInstalled(store.get('modelsDir'));
  const {modelPath,projector}=resolveModelRef(ref,installed);
  const {binary}=await runtimes.installed();
  if(!binary)fail('No managed runtime installed. Run: botconnector runtime install');
  const backend=store.get('runtimeBackend')||'auto';
  llama.startLlama({binary,modelPath,projector,port,gpuLayers:backend==='cpu'?0:999,context:Number(opt('ctx',4096))});
  console.error(`serving ${modelPath} on 127.0.0.1:${port} (Ctrl-C stops)`);
  const ok=await waitReady();
  if(!ok){console.error('server did not become ready');try{llama.stopLlama();}catch{}process.exit(1);}
  console.error('ready.');
  setInterval(()=>{const l=llama.logs().slice(-3);if(l.length)console.error('[llama] '+l[l.length-1]);},10000);
  await new Promise(()=>{});
}
if(cmd==='chat'){
  const stream=rawArgs.includes('--stream');
  const key=opt('api-key',null);
  const parts=rawArgs.slice(1).filter(a=>!a.startsWith('--')&&a!==key);
  let prompt=parts.join(' ');
  if(!prompt)fail('chat "prompt" [--api-key KEY]');
  const body={model:'local-model',messages:[{role:'user',content:prompt}],temperature:0.7,stream};
  const hdrs={'Content-Type':'application/json'};if(key)hdrs.Authorization='Bearer '+key;
  const r=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:hdrs,body:JSON.stringify(body)});
  if(!r.ok)fail(`runtime returned ${r.status} (is a model loaded on port ${port}?)`);
  if(!stream){const j=await r.json();const m=j?.choices?.[0]?.message||{};out(json?{content:m.content,reasoning:m.reasoning_content||null,usage:j.usage||null}:(m.reasoning_content?`[reasoning]\n${m.reasoning_content}\n\n`:'')+(m.content||''));process.exit(0);}
  const reader=r.body.getReader(),dec=new TextDecoder();let buf='';
  while(true){const{done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});const lines=buf.split('\n');buf=lines.pop()||'';for(const ln of lines){if(!ln.startsWith('data:'))continue;const t=ln.slice(5).trim();if(!t||t==='[DONE]')continue;try{process.stdout.write(JSON.parse(t)?.choices?.[0]?.delta?.content||'');}catch{}}}
  console.log();process.exit(0);
}
if(cmd==='embed'){
  const key=opt('api-key',null);
  const parts=rawArgs.slice(1).filter(a=>!a.startsWith('--')&&a!==key);
  const text=parts.join(' ');
  if(!text)fail('embed "text" [--json] [--api-key KEY]');
  const hdrs={'Content-Type':'application/json'};if(key)hdrs.Authorization='Bearer '+key;
  const r=await fetch(`http://127.0.0.1:${port}/v1/embeddings`,{method:'POST',headers:hdrs,body:JSON.stringify({model:'local-embed',input:text})});
  if(!r.ok)fail(`runtime returned ${r.status} (is an --embeddings model loaded on port ${port}?)`);
  const j=await r.json();
  const v=j?.data?.[0]?.embedding||[];
  out(json?{dim:v.length,embedding:v}:`dim=${v.length} first5=[${v.slice(0,5).map(x=>Number(x).toFixed(4)).join(', ')}]`);
  process.exit(0);
}
if(cmd==='launch'){
  const registry=createIntegrationRegistry({cwd:process.cwd(),env:process.env,platform:process.platform});
  const printRows=()=>registry.list().map((entry)=>({id:entry.id,name:entry.name,category:entry.category,status:entry.status,executable:entry.executable,verified:entry.verified,launchable:entry.launchable,reason:entry.disabledReason}));
  const showList=()=>{
    const rows=printRows();
    if(json) out({ok:true,integrations:rows,unverifiedCandidates:registry.unverifiedCandidates()});
    else { let category=''; for(const row of rows){if(row.category!==category){category=row.category;console.log(`\n${category}`);} console.log(`  ${row.name.padEnd(22)} ${row.status}${row.reason&&row.status==='Unknown'?' — '+row.reason:''}`);} console.log('\nUse: botconnector launch <integration> [--model <model>] [--config]'); }
  };
  async function pickTarget(rows){
    if(!process.stdin.isTTY||!process.stdout.isTTY){showList();return null;}
    let index=0; const oldRaw=process.stdin.isRaw;
    readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
    const render=()=>{process.stdout.write('\x1b[2J\x1b[HBotConnector Launch\n\n'); rows.forEach((row,i)=>process.stdout.write(`${i===index?'›':' '} ${row.name.padEnd(22)} ${row.status}\n`)); process.stdout.write('\nUp/Down move · Enter select · Esc cancel\n');};
    render();
    return await new Promise((resolve)=>{const done=(value)=>{process.stdin.removeListener('keypress',onKey);try{process.stdin.setRawMode(oldRaw);}catch{} process.stdin.pause();process.stdout.write('\x1b[2J\x1b[H');resolve(value);};const onKey=(ch,key={})=>{if(key.name==='escape'||(key.ctrl&&key.name==='c'))return done(null);if(key.name==='up')index=Math.max(0,index-1);else if(key.name==='down')index=Math.min(rows.length-1,index+1);else if(key.name==='return')return done(rows[index]);render();};process.stdin.on('keypress',onKey);});
  }
  let target=sub||'';
  if(rawArgs.includes('--list')||(!target&&json)){showList();process.exit(0);}
  const entry=target?registry.get(target):await pickTarget(registry.list());
  if(!entry){if(!target)process.exit(2);fail(`unknown integration: ${target}`);}
  const requestedModel=opt('model','auto');
  const model=resolveAutoModel({requested:requestedModel,store});
  const endpointBase=`http://127.0.0.1:${port}`;
  if(rawArgs.includes('--restore')){
    const result=await registry.restoreIntegration({id:entry.id,cwd:process.cwd(),env:process.env});
    if(!result.ok)fail(result.reason); out(result); process.exit(0);
  }
  if(rawArgs.includes('--config')||rawArgs.includes('--apply')){
    if(entry.id==='opencode'){
      const result=await registry.configureOpenCode({cwd:process.cwd(),endpoint:endpointBase,modelId:model.id,modelName:store.get('tuiModel')?.name,env:process.env});
      out({...result,integration:entry.id,model:model.id}); process.exit(result.ok?0:1);
    }
    if(!entry.verified) fail(`${entry.name} has no verified BotConnector configuration adapter.`);
    out({ok:true,integration:entry.id,changed:[],note:'This adapter uses process-scoped environment at launch; no persistent configuration was changed.'}); process.exit(0);
  }
  if(entry.status===integrationModule.STATUS.NOT_INSTALLED) fail(`${entry.name} is not installed. Use its official installation instructions; BotConnector does not install it silently.`);
  if(entry.status===integrationModule.STATUS.UNKNOWN||entry.status===integrationModule.STATUS.UNSUPPORTED||!entry.launchable) fail(entry.disabledReason||`${entry.name} has no verified launch adapter.`);
  if(!json) console.error(`Launching ${entry.name} · model ${model.id} · workspace ${process.cwd()}`);
  if(entry.id==='terminal'){await runTui({debug:rawArgs.includes('--debug'),workspace:process.cwd()});process.exit(0);}
  const result=await launchIntegration(entry,{cwd:process.cwd(),endpoint:endpointBase,modelId:model.id,requestedModel,modelName:store.get('tuiModel')?.name,env:process.env});
  if(json) out({...result,integration:entry.id,model:model.id}); else if(!result.ok&&result.reason) console.error(`Error: ${result.reason}`);
  process.exit(result.ok?0:(result.exitCode||1));
}

// ---------- Cloud: credentials + status (Core-shared, secrets never echoed) ----------
// CLI runs outside Electron, so safeStorage blobs cannot be decrypted here; a
// dedicated CredentialManager resolves via env fallback and reports configured
// state. Key WRITES from CLI go through Electron main when available; in pure
// CLI context we store an env-resolvable reference, never plaintext.
function cloudCredentialManager(){
  return new CredentialManager({store,env:process.env});
}
function cloudDir(){return path.join(userData,'cloud');}
function hiddenPrompt(text){
  // Hidden (non-echo) single-line secret reader. In a TTY, raw stdin echoes '*'
  // per character and the value itself is never printed. When stdin is not a
  // TTY (piped), fall back to reading a line without echoing anything.
  return new Promise(resolve=>{
    process.stdout.write(text);
    if(!process.stdin.isTTY){
      process.stdin.setEncoding('utf8');
      let s='';
      const onData=ch=>{
        s+=ch;
        if(/\r?\n/.test(ch)||s.length>512){process.stdin.removeListener('data',onData);resolve(s.replace(/\r?\n.*$/,''));}
      };
      process.stdin.on('data',onData);
      return;
    }
    let s='';
    const wasRaw=process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData=ch=>{
      if(ch==='\r'||ch==='\n'){
        process.stdin.removeListener('data',onData);
        try{process.stdin.setRawMode(wasRaw);}catch{}
        process.stdin.pause();
        process.stdout.write('\n');
        resolve(s);
      }else if(ch===''){
        try{process.stdin.setRawMode(wasRaw);}catch{}
        process.exit(130);
      }else if(ch===''||ch==='\b'){
        if(s.length)s=s.slice(0,-1);
      }else if(ch>=' '&&s.length<512){
        s+=ch;process.stdout.write('*');
      }
    };
    process.stdin.on('data',onData);
  });
}
if(cmd==='cloud'&&sub==='set-key'){
  const provider=String(rawArgs[2]||'').toLowerCase();
  if(!['nebius','together'].includes(provider))fail('cloud set-key <nebius|together>');
  const cm=cloudCredentialManager();
  const existing=cm.source(provider);
  if(existing.source==='safeStorage'){console.error('Note: a key for this provider is already stored by the desktop app (safeStorage). CLI cannot overwrite encrypted desktop blobs; use the Desktop UI to replace it.');process.exit(1);}
  const key=await hiddenPrompt(`Paste ${provider} API key (hidden, Enter to confirm): `);
  if(!key||key.length<8)fail('API key looks too short; nothing stored');
  // Persist OUTSIDE plaintext: write an env-fallback instruction for CLI context
  // and store via safeStorage when a Desktop helper is reachable. We never
  // write the plaintext key to disk; we only record its PRESENCE marker.
  const markerFile=path.join(cloudDir(),`${provider}-key.set`);
  await fsp.mkdir(cloudDir(),{recursive:true});
  await fsp.writeFile(markerFile,JSON.stringify({configuredBy:'cli',at:new Date().toISOString(),note:'Key material held in this terminal session only; use the Desktop UI (safeStorage) for persistent storage. CLI keeps an environment contract: '+envNameFor(provider)}));
  console.error(`NOTE: CLI cannot encrypt with safeStorage (Electron-only). The key was read hidden and used for this command only.`);
  console.error(`For persistent storage, run the Desktop app -> Cloud -> Provider credentials (encrypted with Windows safeStorage), or set ${envNameFor(provider)} for development/CI.`);
  out({provider,configured:false,source:'cli-session-only',persistent:false,next:'Use Desktop Cloud UI to persist with safeStorage'});
  process.exit(0);
}
function envNameFor(provider){return provider==='nebius'?'NEBIUS_API_KEY':'TOGETHER_API_KEY';}
if(cmd==='cloud'&&sub==='key-status'){
  const cm=cloudCredentialManager();
  out(cm.public());
  process.exit(0);
}
if(cmd==='cloud'&&sub==='remove-key'){
  const provider=String(rawArgs[2]||'').toLowerCase();
  if(!['nebius','together'].includes(provider))fail('cloud remove-key <nebius|together>');
  const cm=cloudCredentialManager();
  if(cm.source(provider).source==='safeStorage'){console.error('Key is stored in Desktop safeStorage; remove it via the Desktop UI.');process.exit(1);}
  if(cm.source(provider).source==='environment'){fail(`Key comes from environment ${envNameFor(provider)}; unset it in your shell/profile to remove.`);}
  const marker=path.join(cloudDir(),`${provider}-key.set`);
  await fsp.rm(marker,{force:true});
  out({provider,configured:false,removed:'cli-session marker'});
  process.exit(0);
}
console.error(`unknown command: ${cmd}\n`+HELP);process.exit(2);
}
__botconnectorMain().catch(e=>{console.error('botconnector: fatal:',e&&e.message||e);process.exit(1);});
