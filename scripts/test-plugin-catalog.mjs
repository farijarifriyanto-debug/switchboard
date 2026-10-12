import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'

const dir = await mkdtemp(path.join(tmpdir(), 'sbx-catalog-integration-'))
const api = async (base, route, options={}) => {
  const r = await fetch(base + route, { ...options, headers: { ...(options.body ? { 'content-type':'application/json' } : {}), ...options.headers } })
  return { status:r.status, data:await r.json() }
}
const make = (overrides={}) => createHost({
  llm:{baseURL:'http://127.0.0.1:9/v1',defaultModel:'fixture',retries:0},
  metrics:{persist:'',load:false}, sessions:{dir:'',load:false},
  approval:{mode:'off'},settings:{dir}, web:{enabled:true,host:'127.0.0.1',port:0},...overrides,
})
let host
try {
  host = await make()
  const {url} = await host.ctx.web.ready()
  const initial = await api(url, 'api/plugin-catalog')
  assert.equal(initial.status,200)
  assert.deepEqual(initial.data.plugins.map(x=>x.id),['semgrep','opensandbox'])
  assert.deepEqual(initial.data.plugins.map(x=>x.installed),[false,false])
  console.log('PASS approved catalog list')

  const forbidden = await api(url,'api/plugin-catalog/install',{method:'POST',headers:{origin:'https://botconnector.id'},body:JSON.stringify({id:'semgrep'})})
  assert.equal(forbidden.status,403)
  console.log('PASS remote-website cannot silently install')

  const unknown = await api(url,'api/plugin-catalog/install',{method:'POST',body:JSON.stringify({id:'not-approved'})})
  assert.equal(unknown.status,400)
  const arbitrary = await api(url,'api/plugin-catalog/install',{method:'POST',body:JSON.stringify({id:'semgrep',command:'curl evil'})})
  assert.equal(arbitrary.status,400)
  console.log('PASS unknown package and arbitrary code blocked')

  const semgrep = await api(url,'api/plugin-catalog/install',{method:'POST',body:JSON.stringify({id:'semgrep'})})
  assert.equal(semgrep.status,200,JSON.stringify(semgrep.data))
  assert.equal(semgrep.data.plugin.state,'up')
  assert.ok(semgrep.data.plugin.toolCount>=5)
  assert.ok(host.ctx.tools.get('mcp__semgrep__semgrep_scan_with_custom_rule'))
  console.log('PASS Semgrep installed without restarting Switchboard',semgrep.data.plugin.toolCount)
  const rule = 'rules:\n  - id: bc.plugin-catalog.exec\n    pattern: exec(...)\n    message: Unsafe dynamic exec\n    languages: [python]\n    severity: ERROR\n'
  const scan = await host.ctx.tools.callResult('mcp__semgrep__semgrep_scan_with_custom_rule',{code_files:[{path:'demo.py',content:'exec(input())\n'}],rule})
  assert.notEqual(scan.isError,true,scan.content)
  assert.match(JSON.stringify(scan.structuredContent??scan.content),/bc\.plugin-catalog\.exec/)
  console.log('PASS real Semgrep MCP scan finds unsafe exec')
  const persisted = JSON.parse(await readFile(path.join(dir,'installed-mcp.json'),'utf8'))
  assert.deepEqual(persisted.installed,[{id:'semgrep'}])
  const registryStat = await stat(path.join(dir,'installed-mcp.json'))
  if(process.platform!=='win32')assert.equal(registryStat.mode & 0o777,0o600)
  console.log('PASS non-secret install persists with private permissions')

  const badEndpoint = await api(url,'api/plugin-catalog/install',{method:'POST',body:JSON.stringify({id:'opensandbox',endpoint:'203.0.113.1:18088',apiKey:'example'})})
  assert.equal(badEndpoint.status,400)
  assert.match(badEndpoint.data.error,/local endpoint|Tailscale/)
  console.log('PASS public OpenSandbox HTTP endpoint refused')

  await host.dispose();host=undefined
  host = await make()
  assert.equal(host.ctx.mcp.status().find(s=>s.name==='semgrep')?.state,'up')
  console.log('PASS installed plugin automatically reconnects after restart')
  const secondUrl=(await host.ctx.web.ready()).url
  const del=await api(secondUrl,'api/plugin-catalog/semgrep',{method:'DELETE'})
  assert.equal(del.status,200,JSON.stringify(del.data))
  assert.equal(host.ctx.tools.get('mcp__semgrep__semgrep_scan'),undefined)
  const after = JSON.parse(await readFile(path.join(dir,'installed-mcp.json'),'utf8'))
  assert.deepEqual(after.installed,[])
  console.log('PASS uninstall disconnects tools and removes persisted entry')
  // Existing manual MCP takes precedence over old managed metadata.
  await host.dispose();host=undefined
  await writeFile(path.join(dir,'installed-mcp.json'),JSON.stringify({version:1,installed:[{id:'semgrep'}]}))
  const fixture=path.resolve('test/fixtures/fake-mcp.mjs')
  host=await make({mcp:{servers:{semgrep:{transport:'stdio',command:process.execPath,args:[fixture]}}}})
  const manual=(await api((await host.ctx.web.ready()).url,'api/plugin-catalog')).data.plugins.find(p=>p.id==='semgrep')
  assert.equal(manual.installed,true);assert.equal(manual.managed,false)
  await assert.rejects(host.ctx.pluginCatalog.uninstall('semgrep'),/manually configured/)
  assert.equal(host.ctx.mcp.status().find(s=>s.name==='semgrep').state,'up')
  console.log('PASS manual MCP precedence prevents removing manually configured server')
  console.log('PLUGIN_CATALOG_E2E_PASS')
}finally{await host?.dispose();await rm(dir,{recursive:true,force:true})}
