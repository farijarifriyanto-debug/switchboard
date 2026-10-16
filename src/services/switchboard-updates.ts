/**
 * Switchboard release watcher (npmjs is the source of truth for npm installs).
 * No GitHub branch HEAD, arbitrary URLs or untrusted shell commands can trigger
 * an update. Only a confirmed, published stable version is installable.
 * Checking is automatic and cached. Background installation is OFF by default
 * and requires opt-in; the running host is never forcibly restarted.
 */
import { readFile, access, mkdir, writeFile, rename } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const OFFICIAL_PACKAGE = '@botconnector/switchboard'
export const OFFICIAL_REGISTRY_URL = 'https://registry.npmjs.org/@botconnector%2fswitchboard/latest'
const CACHE_MS = 6 * 60 * 60 * 1000
const MAX_META_BYTES = 160 * 1024
const VERSION_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
const packageFile = fileURLToPath(new URL('../../package.json', import.meta.url))
const isNpmGlobal = (root: string): boolean => {
  const normal = path.normalize(root).toLowerCase()
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA
    return Boolean(appdata) && normal === path.join(appdata!, 'npm', 'node_modules', '@botconnector', 'switchboard').toLowerCase()
  }
  return normal.includes('/lib/node_modules/@botconnector/switchboard')
}
export function compareStableVersions(current: string, published: string): number | null {
  const a = VERSION_RE.exec(current), b = VERSION_RE.exec(published)
  if (!a || !b) return null
  for (let i = 1; i <= 3; i++) {
    const d = Number(b[i]) - Number(a[i])
    if (d) return Math.sign(d)
  }
  return 0
}
export type UpdateStatus = {
  packageName: string
  current: string
  latest: string | null
  available: boolean
  installable: boolean
  installType: 'npm-global' | 'development-or-portable'
  checkedAt: string | null
  error?: string
  installing: boolean
  installedVersion?: string
  restartRequired: boolean
  automatic: boolean
}
type NpmMeta = { name?: string; version?: string; dist?: { integrity?: string } }
export class SwitchboardUpdateService {
  private lastCheck = 0
  private result: { latest:string|null; error?:string } = {latest:null}
  private pending: Promise<void> | null = null
  private installing = false
  private installedVersion: string | undefined
  private automatic = false
  private automaticTimer: NodeJS.Timeout | undefined
  private readonly preferencesPath = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'),'BotConnector','SwitchboardUpdater','settings.json')
  private readonly root = path.dirname(packageFile)
  private readonly currentVersion: string
  private readonly global: boolean
  constructor(version: string, opts?: { global?: boolean }) {
    this.currentVersion=version
    this.global=opts?.global ?? isNpmGlobal(this.root)
  }
  static async create() {
    const pkg=JSON.parse(await readFile(packageFile,'utf8'))
    if (pkg.name!==OFFICIAL_PACKAGE || !VERSION_RE.test(pkg.version)) {
      throw new Error('Switchboard package identity/version mismatch.')
    }
    return await new SwitchboardUpdateService(pkg.version).init()
  }
  async status(opts?:{force?:boolean}): Promise<UpdateStatus> {
    if (opts?.force && this.installing) return this.view()
    if ((opts?.force || Date.now()-this.lastCheck > CACHE_MS) && !this.pending) {
      this.pending=this.refresh().finally(()=>{this.pending=null})
    }
    if (this.pending) await this.pending
    return this.view()
  }
  private view(): UpdateStatus {
    const latest=this.result.latest
    const newer=latest?compareStableVersions(this.currentVersion,latest):null
    return {
      packageName: OFFICIAL_PACKAGE,
      current:this.currentVersion,latest,
      available:newer===1,
      installable:this.global && newer===1 && !this.result.error && !this.installing && !this.installedVersion,
      installType:this.global?'npm-global':'development-or-portable',
      checkedAt:this.lastCheck?new Date(this.lastCheck).toISOString():null,
      ...(this.result.error?{error:this.result.error}:{}),
      installing:this.installing,
      ...(this.installedVersion?{installedVersion:this.installedVersion}:{}),
      restartRequired:Boolean(this.installedVersion),
      automatic:this.automatic,
    }
  }
  async init() {
    const stored=await readFile(this.preferencesPath,'utf8').catch(()=>'')
    if (stored && stored.length<2048) {
      try {this.automatic=JSON.parse(stored)?.automatic===true} catch {this.automatic=false}
    }
    // A released build can check and install without additional clicks once
    // the user explicitly opts in. Never forcibly restart a live agent run.
    this.automaticTimer=setInterval(()=>{void this.autoTick()},CACHE_MS)
    this.automaticTimer.unref()
    void this.autoTick()
    return this
  }
  async configure(automatic:boolean) {
    if(typeof automatic!=='boolean')throw new Error('automatic must be boolean')
    if(automatic&&!this.global)throw new Error('Automatic updates require npm-global installation')
    const dir=path.dirname(this.preferencesPath)
    await mkdir(dir,{recursive:true})
    const temp=this.preferencesPath+'.tmp-'+process.pid
    await writeFile(temp,JSON.stringify({automatic})+'\n',{encoding:'utf8',mode:0o600})
    await rename(temp,this.preferencesPath)
    this.automatic=automatic
    if(automatic)void this.autoTick()
    return this.view()
  }
  private async autoTick() {
    if(!this.automatic||!this.global||this.installedVersion||this.installing)return
    const status=await this.status({force:true})
    if(status.installable)await this.install().catch(error=>{
      this.result={...this.result,error:error instanceof Error?error.message:'Auto update failed'}
    })
  }
  private async refresh() {
    try {
      const response=await fetch(OFFICIAL_REGISTRY_URL,{
        headers:{accept:'application/json'},
        signal:AbortSignal.timeout(7000),redirect:'error',
      })
      if (!response.ok) throw new Error('Registry npmjs HTTP '+response.status)
      const type=response.headers.get('content-type')??''
      if (!type.includes('json')) throw new Error('Registry did not return JSON')
      const declared=Number(response.headers.get('content-length')??'0')
      if(declared>MAX_META_BYTES) throw new Error('Registry response exceeded size limit')
      const chunks:Uint8Array[]=[]
      let bytes=0
      if(!response.body) throw new Error('Registry returned an empty response')
      for await(const chunk of response.body) {
        bytes+=chunk.byteLength
        if(bytes>MAX_META_BYTES) throw new Error('Registry response exceeded size limit')
        chunks.push(chunk)
      }
      const meta=JSON.parse(Buffer.concat(chunks).toString('utf8')) as NpmMeta
      if(meta.name!==OFFICIAL_PACKAGE||!meta.version||!VERSION_RE.test(meta.version)
         ||!meta.dist?.integrity?.startsWith('sha512-')) {
        throw new Error('Published npmjs metadata failed package/version/integrity validation')
      }
      this.result={latest:meta.version}
    } catch(error) {
      this.result={latest:this.result.latest,error:error instanceof Error?error.message:'Cannot check npmjs'}
    } finally {
      this.lastCheck=Date.now()
    }
  }
  /** Called by an explicit click, or by the user's saved opt-in auto-update policy. */
  async install():Promise<UpdateStatus> {
    if(this.installing) throw new Error('An update is already running.')
    if(!this.global) throw new Error('Automatic npm installation is unavailable for portable/development copies.')
    if(this.installedVersion) throw new Error('Update already installed; restart Switchboard first.')
    const data=await this.status({force:true})
    if(!data.installable||!data.latest) throw new Error(data.error||'No newer, verified stable npmjs release available.')
    const target=data.latest
    // Launch the npm JS entrypoint with the SAME Node.js executable: no shell,
    // no cmd.exe, and no unvalidated user-supplied version/URL.
    const npmCli=path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js')
    await access(npmCli,constants.R_OK)
    this.installing=true
    try {
      await new Promise<void>((resolve,reject)=>{
        const child=spawn(process.execPath,[
          npmCli,'install','--global',OFFICIAL_PACKAGE+'@'+target,
          '--ignore-scripts','--no-audit','--no-fund','--fetch-retries=1',
        ],{cwd:os.homedir(),windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false})
        let errors='',out='',exited=false
        const deadline=setTimeout(()=>{child.kill();reject(new Error('npm update timed out after 3 minutes.'))},180000)
        child.stdout.on('data',b=>{out=(out+String(b)).slice(-1600)})
        child.stderr.on('data',b=>{errors=(errors+String(b)).slice(-1600)})
        child.on('error',error=>{if(exited)return;exited=true;clearTimeout(deadline);reject(error)})
        child.on('close',code=>{if(exited)return;exited=true;clearTimeout(deadline);code===0?resolve():reject(new Error('npm install failed ('+code+'): '+(errors||out).slice(-350)))})
      })
      const latestPackage=JSON.parse(await readFile(packageFile,'utf8'))
      if(latestPackage.name!==OFFICIAL_PACKAGE||latestPackage.version!==target) {
        throw new Error('npm exited successfully but installed package version is not the requested release')
      }
      this.installedVersion=target
      return this.view()
    } finally {this.installing=false}
  }
}
