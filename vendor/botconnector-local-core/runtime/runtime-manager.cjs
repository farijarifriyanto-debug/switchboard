const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const {pipeline}=require('node:stream/promises');
const {execFile}=require('node:child_process');
const yauzl=require('yauzl');

const UA='BotConnectorAI/0.4';
const RELEASES_URL='https://api.github.com/repos/ggml-org/llama.cpp/releases';
const SERVER_BIN=process.platform==='win32'?'llama-server.exe':'llama-server';

function digestOf(a){const d=a?.digest||'';return d.replace(/^sha256:/i,'')||null;}

function normRelease(r){
  return {
    tag:r.tag_name,
    name:r.name||r.tag_name,
    prerelease:Boolean(r.prerelease),
    publishedAt:r.published_at||r.created_at||null,
    assets:(r.assets||[]).map(a=>({name:a.name,url:a.browser_download_url,size:a.size,sha256:digestOf(a)}))
  };
}

async function sha256File(p){return await new Promise((resolve,reject)=>{const h=crypto.createHash('sha256'),rs=fs.createReadStream(p);rs.on('data',d=>h.update(d));rs.on('error',reject);rs.on('end',()=>resolve(h.digest('hex')));});}

function verifyBinary(binary,timeout=30000){
  return new Promise((resolve,reject)=>{
    execFile(binary,['--version'],{shell:false,windowsHide:true,timeout},(err,stdout,stderr)=>{
      const out=String(stdout||stderr||'').trim();
      if(err)return reject(new Error(`llama-server --version failed: ${err.message}${out?` — ${out.slice(0,300)}`:''}`));
      resolve(out.slice(0,500));
    });
  });
}

const ARCHIVE_LIMITS=Object.freeze({
  maxArchiveBytes:512*1024*1024,
  maxEntryCount:5000,
  maxSingleEntryUncompressedBytes:512*1024*1024,
  maxTotalUncompressedBytes:2*1024*1024*1024,
  maxCompressionRatio:100,
  maxPathLength:1024
});

function safeEntryName(name){
  const raw=String(name??'');
  if(!raw||raw.includes('\u0000'))return null;
  const n=raw.replace(/\\/g,'/');
  if(n.startsWith('/')||n.startsWith('//')||/^[a-zA-Z]:/.test(n))return null;
  const directory=n.endsWith('/'),body=directory?n.slice(0,-1):n;
  if(!body)return null;
  const parts=body.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'))return null;
  return parts.join('/')+(directory?'/':'');
}

function archiveIsDirectory(entry){return entry.fileName.endsWith('/')||Boolean(Number(entry.externalFileAttributes||0)&0x10);}
function archiveIsSymlink(entry){return ((Number(entry.externalFileAttributes||0)>>>16)&0xf000)===0xa000;}
function archiveIsUnsupportedSpecial(entry){
  const platform=Number(entry.versionMadeBy||0)>>>8;
  if(platform!==3)return false;
  const type=((Number(entry.externalFileAttributes||0)>>>16)&0xf000);
  return type!==0&&type!==0x4000&&type!==0x8000;
}
function archiveLimit(value,fallback){const n=Number(value);return Number.isFinite(n)&&n>0?n:fallback;}
function archiveOptions(options={}){return {
  maxArchiveBytes:archiveLimit(options.maxArchiveBytes,process.env.BOTCONNECTOR_MAX_ARCHIVE_BYTES||ARCHIVE_LIMITS.maxArchiveBytes),
  maxEntryCount:archiveLimit(options.maxEntryCount,process.env.BOTCONNECTOR_MAX_ENTRY_COUNT||ARCHIVE_LIMITS.maxEntryCount),
  maxSingleEntryUncompressedBytes:archiveLimit(options.maxSingleEntryUncompressedBytes,process.env.BOTCONNECTOR_MAX_SINGLE_ENTRY_UNCOMPRESSED_BYTES||ARCHIVE_LIMITS.maxSingleEntryUncompressedBytes),
  maxTotalUncompressedBytes:archiveLimit(options.maxTotalUncompressedBytes,process.env.BOTCONNECTOR_MAX_TOTAL_UNCOMPRESSED_BYTES||ARCHIVE_LIMITS.maxTotalUncompressedBytes),
  maxCompressionRatio:archiveLimit(options.maxCompressionRatio,process.env.BOTCONNECTOR_MAX_COMPRESSION_RATIO||ARCHIVE_LIMITS.maxCompressionRatio),
  maxPathLength:archiveLimit(options.maxPathLength,process.env.BOTCONNECTOR_MAX_PATH_LENGTH||ARCHIVE_LIMITS.maxPathLength)
};}
function inside(root,target){const rel=path.relative(root,target);return rel!==''&&!rel.startsWith(`..${path.sep}`)&&rel!=='..'&&!path.isAbsolute(rel);}
async function assertSafeComponents(root,target){
  const rootStat=await fsp.lstat(root);
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error('Extraction root is not a private directory');
  const relative=path.relative(root,path.dirname(target));
  let current=root;
  for(const part of relative?relative.split(path.sep):[]){
    current=path.join(current,part);
    try{
      const stat=await fsp.lstat(current);
      if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error(`Unsafe extraction component: ${part}`);
    }catch(error){
      if(error.code!=='ENOENT')throw error;
      await fsp.mkdir(current);
      const stat=await fsp.lstat(current);
      if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error(`Unsafe extraction component: ${part}`);
    }
  }
}
function openArchive(zipPath){return yauzl.openPromise(zipPath,{lazyEntries:true,validateEntrySizes:true,decodeStrings:true});}
async function extractZipSecure(zipPath,extractionRoot,options={}){
  const limits=archiveOptions(options),archiveStat=await fsp.lstat(zipPath);
  if(!archiveStat.isFile()||archiveStat.isSymbolicLink())throw new Error('Archive must be a regular file');
  if(archiveStat.size>limits.maxArchiveBytes)throw new Error('Archive size limit exceeded');
  const root=path.resolve(extractionRoot);try{await fsp.mkdir(root);}catch(error){if(error.code!=='EEXIST')throw error;}
  const rootStat=await fsp.lstat(root);if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw new Error('Extraction root is unsafe');
  const zip=await openArchive(zipPath),seen=new Set();let count=0,total=0;
  try{
    return await new Promise((resolve,reject)=>{
      let settled=false;
      const fail=error=>{if(settled)return;settled=true;try{zip.close();}catch{}reject(error);};
      zip.on('error',fail);
      zip.on('end',()=>{if(!settled){settled=true;resolve({entries:count,totalUncompressedBytes:total});}});
      zip.on('entry',entry=>{
        (async()=>{
          const name=safeEntryName(entry.fileName);
          if(!name||name.length>limits.maxPathLength)throw new Error(`Unsafe archive entry blocked: ${entry.fileName}`);
          count++;if(count>limits.maxEntryCount)throw new Error('Archive entry count limit exceeded');
          if(archiveIsSymlink(entry)||archiveIsUnsupportedSpecial(entry))throw new Error(`Unsupported archive entry blocked: ${entry.fileName}`);
          const uncompressed=Number(entry.uncompressedSize),compressed=Number(entry.compressedSize);
          if(!Number.isSafeInteger(uncompressed)||uncompressed>limits.maxSingleEntryUncompressedBytes)throw new Error(`Archive entry size limit exceeded: ${entry.fileName}`);
          total+=uncompressed;if(total>limits.maxTotalUncompressedBytes)throw new Error('Archive total expansion limit exceeded');
          if(uncompressed>0&&(!compressed||uncompressed/compressed>limits.maxCompressionRatio))throw new Error(`Archive compression ratio limit exceeded: ${entry.fileName}`);
          const key=process.platform==='win32'?name.toLowerCase():name;
          if(seen.has(key))throw new Error(`Duplicate archive entry blocked: ${entry.fileName}`);seen.add(key);
          const target=path.resolve(root,name.replace(/\//g,path.sep));
          if(!inside(root,target))throw new Error(`Archive entry escapes extraction root: ${entry.fileName}`);
          if(archiveIsDirectory(entry)){
            if(await fsp.lstat(target).then(s=>s.isDirectory()&&!s.isSymbolicLink()).catch(e=>e.code==='ENOENT'?false:Promise.reject(e))){}else{
              await assertSafeComponents(root,target);
              await fsp.mkdir(target);
            }
            zip.readEntry();return;
          }
          await assertSafeComponents(root,target);
          try{await fsp.lstat(target);throw new Error(`Archive destination collision: ${entry.fileName}`);}catch(error){if(error.code!=='ENOENT')throw error;}
          const flags=fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|(fs.constants.O_NOFOLLOW||0);
          const handle=await fsp.open(target,flags,0o600);
          try{
            const stream=await new Promise((res,rej)=>zip.openReadStream(entry,(error,readable)=>error?rej(error):res(readable)));
            await pipeline(stream,handle.createWriteStream());
          }finally{await handle.close();}
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  }finally{try{zip.close();}catch{}}
}

// Linux llama.cpp releases ship .tar.gz, not .zip. Node has no built-in tar
// parser, and reaching for a dependency (or shelling out to the system's
// `tar`, trusting whatever version/behavior happens to be installed) both
// sit less comfortably next to extractZipSecure's from-scratch, fully
//-audited approach than just parsing the (simple, fixed-layout) POSIX
// ustar format directly — reusing every one of extractZipSecure's safety
// primitives (safeEntryName, inside, assertSafeComponents, the same byte
// limits) so both archive formats get identical guarantees. ustar only:
// GNU longname ('L') entries and anything else non-plain-file/directory is
// rejected rather than guessed at.
function tarString(buf,start,len){const i=buf.indexOf(0,start);const end=i>=0&&i<start+len?i:start+len;return buf.toString('utf8',start,end).trim();}
function tarOctal(buf,start,len){const s=tarString(buf,start,len).trim();return s?parseInt(s,8):0;}
async function extractTarGzSecure(tarGzPath,extractionRoot,options={}){
  const limits=archiveOptions(options),archiveStat=await fsp.lstat(tarGzPath);
  if(!archiveStat.isFile()||archiveStat.isSymbolicLink())throw new Error('Archive must be a regular file');
  if(archiveStat.size>limits.maxArchiveBytes)throw new Error('Archive size limit exceeded');
  const root=path.resolve(extractionRoot);try{await fsp.mkdir(root);}catch(error){if(error.code!=='EEXIST')throw error;}
  const rootStat=await fsp.lstat(root);if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw new Error('Extraction root is unsafe');
  const gz=await fsp.readFile(tarGzPath);
  let tar;
  try{tar=zlib.gunzipSync(gz,{maxOutputLength:limits.maxTotalUncompressedBytes});}
  catch(e){throw new Error(`Archive is not valid gzip or exceeds expansion limit: ${e.message}`);}
  if(tar.length/Math.max(1,gz.length)>limits.maxCompressionRatio)throw new Error('Archive compression ratio limit exceeded');
  const seen=new Set();let count=0,offset=0;
  while(offset+512<=tar.length){
    const header=tar.subarray(offset,offset+512);
    if(header.every(b=>b===0)){offset+=512;continue;} // end-of-archive padding block
    const name=tarString(header,0,100);
    const prefix=tarString(header,345,155);
    const fullName=prefix?`${prefix}/${name}`:name;
    const size=tarOctal(header,124,12);
    const typeflag=String.fromCharCode(header[156]||0);
    offset+=512;
    const dataBlocks=Math.ceil(size/512);
    const data=tar.subarray(offset,offset+size);
    offset+=dataBlocks*512;
    if(!fullName)continue; // pure padding / malformed, already handled by the all-zero check above
    if(typeflag==='g'||typeflag==='x')continue; // pax extended header blocks — no entries in these releases use them; skip safely, entry name/size below still comes from the ustar fields, never from pax data
    if(typeflag==='L')throw new Error(`Unsupported archive entry (GNU long name) blocked: ${fullName}`);
    // Symlinks are otherwise rejected outright (same as the zip path) —
    // EXCEPT the narrow, validated case tar-packaged Linux binaries
    // actually need: a relative symlink whose target contains no '..' and
    // resolves to somewhere still inside the extraction root (standard
    // shared-library SONAME convention, e.g. libllama.so -> libllama.so.0
    // — confirmed live: llama.cpp's own Ubuntu release tarball ships
    // exactly this, and llama-server will not dynamically link without
    // it). Anything else about the symlink (absolute target, '..', a
    // target that resolves outside root) is still blocked.
    if(typeflag==='2'){
      const linkTarget=tarString(header,157,100);
      if(!linkTarget||linkTarget.includes('\u0000')||path.isAbsolute(linkTarget)||linkTarget.split(/[\\/]/).some(p=>p==='..'))
        throw new Error(`Unsafe symlink target blocked: ${fullName} -> ${linkTarget||'(empty)'}`);
      const bareName=fullName.replace(/\/+$/,'');
      const entryName=safeEntryName(bareName);
      if(!entryName||entryName.length>limits.maxPathLength)throw new Error(`Unsafe archive entry blocked: ${fullName}`);
      count++;if(count>limits.maxEntryCount)throw new Error('Archive entry count limit exceeded');
      const key=process.platform==='win32'?entryName.toLowerCase():entryName;
      if(seen.has(key))throw new Error(`Duplicate archive entry blocked: ${fullName}`);seen.add(key);
      const target=path.resolve(root,entryName.replace(/\//g,path.sep));
      if(!inside(root,target))throw new Error(`Archive entry escapes extraction root: ${fullName}`);
      const resolvedTarget=path.resolve(path.dirname(target),linkTarget);
      if(!inside(root,resolvedTarget))throw new Error(`Symlink target escapes extraction root: ${fullName} -> ${linkTarget}`);
      await assertSafeComponents(root,target);
      try{await fsp.lstat(target);throw new Error(`Archive destination collision: ${fullName}`);}catch(error){if(error.code!=='ENOENT')throw error;}
      await fsp.symlink(linkTarget,target);
      continue;
    }
    if(typeflag!=='0'&&typeflag!=='\0'&&typeflag!=='5')throw new Error(`Unsupported archive entry type blocked: ${fullName}`);
    const isDirectory=typeflag==='5'||fullName.endsWith('/');
    // fullName may already carry its own trailing slash (common from
    // GNU/BSD tar) — strip before conditionally re-adding exactly one, or
    // safeEntryName correctly (by design) rejects the resulting empty path
    // segment from a doubled "name//" as unsafe. Caught live: this exact
    // bug blocked every directory entry in a real llama.cpp release tarball.
    const bareName=fullName.replace(/\/+$/,'');
    const entryName=safeEntryName(isDirectory?`${bareName}/`:fullName);
    if(!entryName||entryName.length>limits.maxPathLength)throw new Error(`Unsafe archive entry blocked: ${fullName}`);
    count++;if(count>limits.maxEntryCount)throw new Error('Archive entry count limit exceeded');
    if(!Number.isSafeInteger(size)||size>limits.maxSingleEntryUncompressedBytes)throw new Error(`Archive entry size limit exceeded: ${fullName}`);
    const key=process.platform==='win32'?entryName.toLowerCase():entryName;
    if(seen.has(key))throw new Error(`Duplicate archive entry blocked: ${fullName}`);seen.add(key);
    const target=path.resolve(root,entryName.replace(/\//g,path.sep));
    if(!inside(root,target))throw new Error(`Archive entry escapes extraction root: ${fullName}`);
    if(isDirectory){
      if(await fsp.lstat(target).then(s=>s.isDirectory()&&!s.isSymbolicLink()).catch(e=>e.code==='ENOENT'?false:Promise.reject(e))){}else{
        await assertSafeComponents(root,target);
        await fsp.mkdir(target);
      }
      continue;
    }
    await assertSafeComponents(root,target);
    try{await fsp.lstat(target);throw new Error(`Archive destination collision: ${fullName}`);}catch(error){if(error.code!=='ENOENT')throw error;}
    // 0o700, not the zip path's 0o600: these entries are Linux ELF binaries
    // that must be directly executable by the owner (tar's own claimed mode
    // bits are never trusted, same philosophy as the zip path — this is a
    // fixed value BotConnector chooses, not one the archive can dictate).
    const handle=await fsp.open(target,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|(fs.constants.O_NOFOLLOW||0),0o700);
    try{await handle.writeFile(data);}finally{await handle.close();}
  }
  return {entries:count};
}

class RuntimeManager{
  constructor({baseDir,emit}){this.baseDir=baseDir;this.emit=emit||(()=>{});}

  async listReleases(limit=15){
    const url=`${RELEASES_URL}?per_page=${Math.min(30,Math.max(1,limit))}`;
    const res=await fetch(url,{headers:{'User-Agent':UA,'Accept':'application/vnd.github+json'}});
    if(!res.ok)throw new Error(`GitHub ${res.status} listing llama.cpp releases`);
    const arr=await res.json();
    return arr.map(normRelease);
  }

  // Newest release first that contains an official x64 asset for THIS platform
  // (excludes arm64-only, source tarballs). Windows -> *.zip, Linux -> *.tar.gz.
  async latest(){
    const releases=await this.listReleases(15);
    const re=process.platform==='win32'?/-win-.*-x64\.zip$/i:/-ubuntu-.*x64\.tar\.gz$/i;
    const usable=releases.find(r=>(r.assets||[]).some(a=>re.test(a.name)));
    if(!usable)throw new Error(`No recent llama.cpp release contains an official ${process.platform==='win32'?'Windows':'Linux'} x64 asset`);
    return usable;
  }

  normalizeBackend(b){
    const v=String(b||'auto').toLowerCase();
    if(v==='hip')return 'rocm';
    if(v==='cuda')return 'cuda12';
    return v;
  }

  chooseAssets(release,backend){
    backend=this.normalizeBackend(backend);
    if(backend==='auto')throw new Error('Use resolveBackend() for backend "auto" (tries vulkan, then cpu fallback)');
    const a=(release.assets||[]).filter(x=>!/-arm64\./i.test(x.name));
    const find=re=>a.find(x=>re.test(x.name));
    const win=process.platform==='win32';
    const platformLabel=win?'Windows':'Linux';
    let primary=null;
    if(win){
      if(backend==='cuda12')primary=find(/^llama-.*-bin-win-cuda-12(?:\.[0-9.]+)?-x64\.zip$/i);
      if(backend==='cuda13')primary=find(/^llama-.*-bin-win-cuda-13(?:\.[0-9.]+)?-x64\.zip$/i);
      if(backend==='vulkan')primary=find(/^llama-.*-bin-win-vulkan-x64\.zip$/i);
      if(backend==='rocm')primary=find(/^llama-.*-bin-win-(rocm|hip).*x64\.zip$/i);
      if(backend==='cpu')primary=find(/^llama-.*-bin-win-cpu-x64\.zip$/i);
    }else{
      // ggml-org/llama.cpp does not currently publish cuda12/cuda13 Ubuntu
      // binaries (verified live against the actual releases API — only
      // win-cuda-* exists) — those fall through to the "not found" error
      // below rather than silently substituting a different backend.
      if(backend==='vulkan')primary=find(/^llama-.*-bin-ubuntu-vulkan-x64\.tar\.gz$/i);
      if(backend==='rocm')primary=find(/^llama-.*-bin-ubuntu-rocm.*-x64\.tar\.gz$/i);
      if(backend==='cpu')primary=find(/^llama-.*-bin-ubuntu-x64\.tar\.gz$/i);
    }
    if(!primary){
      const re=win?/^llama-.*-bin-win-.*\.zip$/i:/^llama-.*-bin-ubuntu-.*\.tar\.gz$/i;
      const cands=a.filter(x=>re.test(x.name)).map(x=>x.name).slice(0,8);
      throw new Error(`No official ${platformLabel} x64 llama.cpp asset found for backend ${backend} in ${release.tag}${cands.length?` (${platformLabel.toLowerCase()} assets: ${cands.join(', ')})`:''}`);
    }
    const out=[primary];
    if(win&&backend==='cuda12'){const c=find(/^cudart-llama-bin-win-cuda-12.*-x64\.zip$/i);if(c)out.push(c);}
    if(win&&backend==='cuda13'){const c=find(/^cudart-llama-bin-win-cuda-13.*-x64\.zip$/i);if(c)out.push(c);}
    return out;
  }

  // Phase G structured resolution: scan multiple recent releases, newest-first.
  async resolveBackend(backend='vulkan',limit=15){
    backend=this.normalizeBackend(backend);
    const candidates=backend==='auto'?['vulkan','cpu']:[backend];
    const releases=await this.listReleases(limit);
    const tried=[];
    for(const b of candidates){
      for(const rel of releases){
        try{
          const assets=this.chooseAssets(rel,b);
          return {releaseTag:rel.tag,releaseName:rel.name,backend:b,primaryAsset:assets[0],dependencies:assets.slice(1),triedReleases:tried.slice()};
        }catch(e){tried.push(`${rel.tag}/${b}: ${e.message.slice(0,120)}`);}
      }
    }
    throw new Error(`No compatible official Windows x64 asset for backend(s) ${candidates.join(', ')} in the ${releases.length} most recent llama.cpp releases`);
  }

  async downloadAsset(asset,zipPath,meta){
    const res=await fetch(asset.url,{headers:{'User-Agent':UA},redirect:'follow'});
    if(!res.ok)throw new Error(`Runtime download ${res.status} for ${asset.name}`);
    const total=Number(res.headers.get('content-length')||asset.size||0);
    await fsp.mkdir(path.dirname(zipPath),{recursive:true});
    const tmp=zipPath+'.part';
    try{await fsp.rm(tmp,{force:true});}catch{}
    const ws=fs.createWriteStream(tmp),reader=res.body.getReader();
    let got=0;
    try{
      while(true){
        const{done,value}=await reader.read();
        if(done)break;
        if(!ws.write(Buffer.from(value)))await new Promise(r=>ws.once('drain',r));
        got+=value.byteLength;
        this.emit('runtime:install-progress',{...meta,asset:asset.name,downloadedBytes:got,totalBytes:total,status:'downloading'});
      }
      await new Promise((resolve,reject)=>ws.end(err=>err?reject(err):resolve()));
    }catch(e){try{await fsp.rm(tmp,{force:true});}catch{}throw e;}
    if(asset.sha256){
      this.emit('runtime:install-progress',{...meta,asset:asset.name,status:'verifying',downloadedBytes:total,totalBytes:total});
      const actual=await sha256File(tmp);
      if(actual.toLowerCase()!==String(asset.sha256).toLowerCase()){await fsp.rm(tmp,{force:true});throw new Error(`SHA256 verification failed for ${asset.name}`);}
    }
    await fsp.rename(tmp,zipPath);
    return {zipPath,bytes:got||total};
  }

  async install({backend='vulkan'}={}){
    if(process.platform!=='win32'&&process.platform!=='linux')throw new Error(`Managed runtime installation targets Windows and Linux x64 (this platform: ${process.platform}).`);
    const norm=this.normalizeBackend(backend);
    const order=norm==='auto'?['vulkan','cpu']:[norm];
    let lastError=null;
    for(const b of order){
      try{
        return await this.installBackend(b);
      }catch(e){
        lastError=e;
        this.emit('runtime:install-progress',{backend:b,release:null,status:'backend-failed',error:String(e.message||e),fallback:b==='vulkan'&&order.includes('cpu')?'cpu':null});
        if(b!=='vulkan'||!order.includes('cpu'))throw e;
        // fall through to cpu fallback, preserving vulkan diagnostic
      }
    }
    throw lastError||new Error('Runtime installation failed');
  }

  async installBackend(backend){
    const resolved=await this.resolveBackend(backend);
    const {releaseTag,primaryAsset,dependencies}=resolved;
    const assets=[primaryAsset,...dependencies];
    const finalDir=path.join(this.baseDir,releaseTag,backend);
    await fsp.mkdir(this.baseDir,{recursive:true});
    const stagingDir=await fsp.mkdtemp(path.join(this.baseDir,`.staging-${releaseTag}-${backend}-${process.pid}-`));
    let prevBackup=null;
    try{
      let assetIndex=0;
      for(const asset of assets){
        assetIndex++;
        const meta={backend,release:releaseTag,asset:asset.name,assetIndex,assetCount:assets.length};
        const zipPath=path.join(stagingDir,asset.name);
        await this.downloadAsset(asset,zipPath,meta);
        this.emit('runtime:install-progress',{...meta,status:'extracting',downloadedBytes:asset.size||0,totalBytes:asset.size||0});
        if(/\.tar\.gz$/i.test(asset.name))await extractTarGzSecure(zipPath,stagingDir);
        else await extractZipSecure(zipPath,stagingDir);
        await fsp.rm(zipPath,{force:true});
      }
      const exe=await this.findServer(stagingDir);
      if(!exe)throw new Error(`${SERVER_BIN} was not found after extraction`);
      // Verification gate (shell:false) BEFORE promotion.
      this.emit('runtime:install-progress',{backend,release:releaseTag,status:'verifying-binary'});
      const versionOutput=await verifyBinary(exe);
      // Atomic promotion: keep previous working runtime until replacement is verified.
      await assertSafeComponents(this.baseDir,finalDir);
      try{
        const st=await fsp.lstat(finalDir);
        if(st.isSymbolicLink()||!st.isDirectory())throw new Error('Existing runtime target is unsafe');
        prevBackup=path.join(this.baseDir,`.prev-${releaseTag}-${backend}-${Date.now()}`);await fsp.rename(finalDir,prevBackup);
      }catch(error){if(error.code!=='ENOENT')throw error;}
      await fsp.mkdir(path.dirname(finalDir),{recursive:true});
      try{await fsp.rename(stagingDir,finalDir);}catch(error){if(prevBackup){try{await fsp.rename(prevBackup,finalDir);prevBackup=null;}catch{}}throw error;}
      const promotedExe=await this.findServer(finalDir);
      if(prevBackup){try{await fsp.rm(prevBackup,{recursive:true,force:true});}catch{}}
      const out={backend,release:releaseTag,binary:promotedExe||exe,dir:finalDir,version:versionOutput,resolution:{releaseTag,backend,primaryAsset:primaryAsset.name,dependencies:dependencies.map(d=>d.name)}};
      this.emit('runtime:install-progress',{backend,release:releaseTag,status:'completed',binary:out.binary});
      return out;
    }catch(e){
      try{await fsp.rm(stagingDir,{recursive:true,force:true});}catch{}
      throw e;
    }
  }

  async findServer(dir=this.baseDir){const stack=[dir];while(stack.length){const d=stack.pop();let items=[];try{items=await fsp.readdir(d,{withFileTypes:true});}catch{continue;}for(const x of items){const p=path.join(d,x.name);if(x.isDirectory()){if(path.basename(p).startsWith('.staging-'))continue;stack.push(p);}else if(x.name.toLowerCase()===SERVER_BIN){
    // Extraction always writes 0o700; this only matters for a binary that
    // reached this directory some other way (a manually-copied build, a
    // pre-existing install from before this fix) — belt-and-braces so
    // "found" always implies "runnable".
    if(process.platform!=='win32'){try{fs.chmodSync(p,0o700);}catch{}}
    return p;
  }}}return null;}
  async installed(){const exe=await this.findServer();return exe?{installed:true,binary:exe}:{installed:false,binary:null};}
  async verifyInstalled(){const s=await this.installed();if(!s.installed)return{installed:false,verified:false};try{const out=await verifyBinary(s.binary);return{installed:true,binary:s.binary,verified:true,version:out};}catch(e){return{installed:true,binary:s.binary,verified:false,error:String(e.message||e)};}}
}
module.exports={ARCHIVE_LIMITS,RuntimeManager,verifyBinary,safeEntryName,extractZipSecure,extractTarGzSecure,SERVER_BIN};
