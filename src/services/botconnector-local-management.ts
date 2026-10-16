/**
 * Thin read-only installed-model inventory and explicit UI launcher for the
 * ORIGINAL pinned BotConnector Local Core. No downloads or model runtime
 * ownership are implemented here. The Core's own UI performs those actions.
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { SettingsError } from './settings-error.js'
const requireCore = createRequire(import.meta.url)
const { Store } = requireCore('../../vendor/botconnector-local-core/runtime/store.cjs') as {
  Store: new(dir: string) => { load(): unknown; get(key: string): string }
}
const { scanInstalled } = requireCore('../../vendor/botconnector-local-core/runtime/installed.cjs') as {
  scanInstalled: (root: string) => Promise<Array<{
    path:string;name:string;repoId:string|null;quant:string|null;
    size:number;capabilities?:Record<string,boolean>;projector?:string|null
  }>>
}
const { findExisting } = requireCore('../../vendor/botconnector-local-core/webui/single-instance.cjs') as {
  findExisting:(lockFile:string)=>Promise<{pid:number;port:number}|null>
}
const managerCli = fileURLToPath(new URL('../../vendor/botconnector-local-core/bin/botconnector.mjs', import.meta.url))
const uiDataDir=path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'),'BotConnector AI')
const lockFile=path.join(uiDataDir,'ui.lock')
const storeDir=path.join(process.env.APPDATA || path.join(os.homedir(),'AppData','Roaming'),'botconnector-ai-local-cloud')
const wait = (ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
function uiUrl(port:number) {
  if(!Number.isInteger(port)||port<1024||port>65535) throw new SettingsError('Invalid Core manager port.',{status:409})
  return 'http://127.0.0.1:'+port+'/'
}
export async function installedBotConnectorModels() {
  const store=new Store(storeDir)
  store.load()
  const rows=await scanInstalled(store.get('modelsDir'))
  return { models: rows.slice(0,128).map(m=>({
    id:m.path, name:m.name, repoId:m.repoId, quant:m.quant,
    sizeMb:Math.round(m.size/1024/1024), chat:m.capabilities?.chat!==false,
    tools:m.capabilities?.tools===true, vision:m.capabilities?.vision===true,
    coding:m.capabilities?.coding===true, projector:Boolean(m.projector),
  })) }
}
const inUse=async(port:number)=>new Promise<boolean>(resolve=>{
  const socket=net.connect({host:'127.0.0.1',port})
  let finished=false
  const done=(found:boolean)=>{if(finished)return;finished=true;socket.destroy();resolve(found)}
  socket.on('connect',()=>done(true))
  socket.on('error',()=>done(false))
  socket.setTimeout(750,()=>done(false))
})
/** User-initiated: open the Core's own search/download/runtime UI. */
export async function openBotConnectorLocalManager() {
  const existing=await findExisting(lockFile)
  if(existing)return {url:uiUrl(existing.port),alreadyRunning:true}
  const port=32100
  if(await inUse(port)) {
    throw new SettingsError('Port 32100 is already occupied by another process. Run sbx local ui manually.',{status:409})
  }
  const child=spawn(process.execPath,[managerCli,'serve','--port',String(port)],{
    detached:true,windowsHide:true,stdio:'ignore',
  })
  child.unref()
  for(let i=0;i<48;i++){
    const rec=await findExisting(lockFile)
    if(rec&&rec.pid===child.pid) return {url:uiUrl(rec.port),alreadyRunning:false}
    if(child.exitCode!==null) break
    await wait(250)
  }
  throw new SettingsError('BotConnector Local manager did not start. Open it manually with sbx local ui.',{status:503})
}
