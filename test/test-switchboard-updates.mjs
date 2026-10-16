/**
 * Safe, registry-pinned Switchboard update contract. No installation, external
 * mutation, process restart or Chrome tabs touched.
 */
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { compareStableVersions, OFFICIAL_PACKAGE, OFFICIAL_REGISTRY_URL, SwitchboardUpdateService } from '../dist/services/switchboard-updates.js'
assert.equal(compareStableVersions('0.4.2','0.4.3'),1)
assert.equal(compareStableVersions('0.4.2','0.4.2'),0)
assert.equal(compareStableVersions('0.4.2','0.3.9'),-1)
assert.equal(compareStableVersions('1.10.0','1.9.99'),-1)
assert.equal(compareStableVersions('0.4.2','0.4.3-beta.1'),null)
assert.equal(compareStableVersions('0.4.2','0.4.3;del'),null)
assert.equal(compareStableVersions('0.4.2','9999999.0.0'),null)
assert.equal(OFFICIAL_PACKAGE,'@botconnector/switchboard')
assert.match(OFFICIAL_REGISTRY_URL,/^https:\/\/registry\.npmjs\.org\/@botconnector%2fswitchboard\/latest$/)
const real=globalThis.fetch
const good=(version, name=OFFICIAL_PACKAGE, integrity='sha512-validity-test')=>new Response(JSON.stringify({name,version,dist:{integrity}}),{status:200,headers:{'content-type':'application/json'}})
try {
  let hits=0
  globalThis.fetch=async input=>{
    assert.equal(String(input),OFFICIAL_REGISTRY_URL)
    hits++
    return good('0.4.3')
  }
  const dev=new SwitchboardUpdateService('0.4.2',{global:false})
  let result=await dev.status({force:true})
  assert.equal(result.available,true)
  assert.equal(result.installable,false)
  assert.equal(result.automatic,false)
  assert.equal(result.installType,'development-or-portable')
  assert.equal(hits,1)
  await dev.status()
  assert.equal(hits,1,'cache must suppress repeated registry requests')
  await assert.rejects(dev.install(),/unavailable for portable\/development/)
  await assert.rejects(dev.configure(true),/require npm-global/)
  await assert.rejects(dev.configure('on'),/automatic must be boolean/)
  const available=new SwitchboardUpdateService('0.4.2',{global:true})
  assert.equal((await available.status({force:true})).installable,true)
  globalThis.fetch=async()=>good('0.4.4','@attacker/malicious')
  result=await available.status({force:true})
  assert.equal(result.installable,false)
  assert.match(result.error,/metadata failed/)
  globalThis.fetch=async()=>good('0.4.4',OFFICIAL_PACKAGE,'unverified')
  result=await available.status({force:true})
  assert.equal(result.installable,false)
  globalThis.fetch=async()=>good('0.4.0')
  result=await available.status({force:true})
  assert.equal(result.available,false,'downgrades never allowed')
  globalThis.fetch=async()=>new Response('not json',{status:200,headers:{'content-type':'text/html'}})
  result=await available.status({force:true})
  assert.equal(result.installable,false)
  globalThis.fetch=async()=>{throw Error('offline-simulation')}
  result=await available.status({force:true})
  assert.equal(result.installable,false,'stale candidate cannot install after network error')
  assert.match(result.error,/offline-simulation/)
  console.log('SWITCHBOARD_UPDATE_SIGNED_REGISTRY_CACHE_AND_NO_DOWNGRADE_PASS')
  console.log('SWITCHBOARD_UPDATE_PORTABLE_NO_INSTALL_PASS')
  console.log('SWITCHBOARD_UPDATE_FAIL_CLOSED_ON_BAD_SOURCE_PASS')
  const tmp=await mkdtemp(path.join(os.tmpdir(),'sbx-update-pref-'))
  const oldLocal=process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA=tmp
  try {
    globalThis.fetch=async()=>good('0.4.2')
    const pref=new SwitchboardUpdateService('0.4.2',{global:true})
    await pref.init()
    assert.equal((await pref.status()).automatic,false)
    assert.equal((await pref.configure(true)).automatic,true)
    const data=JSON.parse(await readFile(path.join(tmp,'BotConnector','SwitchboardUpdater','settings.json'),'utf8'))
    assert.equal(data.automatic,true)
    const restored=new SwitchboardUpdateService('0.4.2',{global:true})
    await restored.init()
    assert.equal((await restored.status()).automatic,true)
    assert.equal((await restored.configure(false)).automatic,false)
    console.log('SWITCHBOARD_UPDATE_OPT_IN_PERSISTENCE_NO_DOWNLOAD_PASS')
  } finally {
    if(oldLocal===undefined)delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA=oldLocal
    await rm(tmp,{recursive:true,force:true})
  }
} finally {globalThis.fetch=real}
