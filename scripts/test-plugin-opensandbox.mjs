import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'
const dir = await mkdtemp(path.join(tmpdir(),'sbx-opensandbox-plugin-'))
const keyFile=process.env.SBX_TEST_OPENSANDBOX_KEY_FILE
if (!keyFile) throw Error('Set SBX_TEST_OPENSANDBOX_KEY_FILE to an existing private test key file')
const secret = (await readFile(keyFile,'utf8')).trim()
if (!secret) throw Error('Missing sandbox canary key')
let host
try {
  host = await createHost({
    llm:{baseURL:'http://127.0.0.1:9/v1',defaultModel:'stub',retries:0},
    metrics:{persist:'',load:false}, sessions:{dir:'',load:false},
    settings:{dir}, approval:{mode:'off'}, web:{enabled:true,host:'127.0.0.1',port:0},
  })
  const result = await host.ctx.pluginCatalog.install('opensandbox',{endpoint:process.env.SBX_TEST_OPENSANDBOX_ENDPOINT||'127.0.0.1:18088',apiKey:secret})
  assert.equal(result.state,'up')
  assert.ok(result.toolCount>0)
  console.log('PASS OpenSandbox official MCP connected (tools)',result.toolCount)
  const persisted = await readFile(path.join(dir,'installed-mcp.json'),'utf8')
  assert.ok(!persisted.includes(secret),'Registry must never contain a secret')
  assert.equal(JSON.parse(persisted).installed[0].endpoint,process.env.SBX_TEST_OPENSANDBOX_ENDPOINT||'127.0.0.1:18088')
  // Exercise the official MCP end-to-end, not only tool discovery.
  const created = await host.ctx.tools.callResult('mcp__opensandbox__sandbox_create', {
    image:process.env.SBX_TEST_OPENSANDBOX_IMAGE||'botconnector/opensandbox-code:20261012',timeout_seconds:100,ready_timeout_seconds:55,
    resource:{cpu:'500m',memory:'512Mi'},
  })
  assert.notEqual(created.isError,true,created.content)
  const creation = created.structuredContent || JSON.parse(created.content.replace(/^.*?\{/, '{'))
  console.log('CREATE_RESULT_KEYS',Object.keys(creation).join(','))
  const sandboxId = creation.sandbox_id || creation.id || creation.sandbox?.id || creation.result?.sandbox_id
  assert.match(String(sandboxId),/^[a-f0-9-]{20,}$/i)
  try {
    const run = await host.ctx.tools.callResult('mcp__opensandbox__command_run',{sandbox_id:sandboxId,command:'python3 -c "print(6*7)"'})
    assert.notEqual(run.isError,true,run.content)
    assert.match(JSON.stringify(run.structuredContent || run.content),/42/)
    console.log('PASS OpenSandbox MCP executes real code in isolated container (42)')
  } finally {
    const killed=await host.ctx.tools.callResult('mcp__opensandbox__sandbox_kill',{sandbox_id:sandboxId})
    assert.notEqual(killed.isError,true,killed.content)
    console.log('PASS MCP sandbox container destroyed after test')
  }
  console.log('PASS API key absent from plugin metadata')
  const cred = await readFile(path.join(dir,'credentials.json'),'utf8')
  assert.ok(cred.includes(secret),'Key should be saved in existing private credential store')
  await host.ctx.pluginCatalog.uninstall('opensandbox')
  assert.ok(!host.ctx.mcp.status().some(s=>s.name==='opensandbox'))
  const after = await readFile(path.join(dir,'credentials.json'),'utf8')
  assert.ok(!after.includes(secret),'Uninstall must remove plugin credential')
  console.log('PASS OpenSandbox removal clears key and tools')
  console.log('OPENSANDBOX_PLUGIN_E2E_PASS')
}finally{await host?.dispose();await rm(dir,{recursive:true,force:true})}
