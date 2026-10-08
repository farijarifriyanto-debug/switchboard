/**
 * Provider registry + credential store unit tests (spec §3-4).
 *
 * Covers: stable/slug ids, immutability, validation, atomic persistence,
 * virtual config-derived default, credential precedence (env > local >
 * config > legacy env), and the write-only guarantee (secret never leaves
 * describe()/state). Temp dirs only — no real credentials.
 *
 *   node scripts/test-providers.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const { Context } = await import('../dist/index.js')
const { ProviderRegistryService } = await import('../dist/services/providers.js')
const { CredentialStoreService } = await import('../dist/services/credentials.js')

const SECRET = 'sk-test-DO-NOT-LEAK-123456'
const savedEnv = { ...process.env }
const dirs = []

async function makeHost(legacy = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sbx-prov-'))
  dirs.push(dir)
  const ctx = new Context()
  const merged = {
    baseURL: 'https://legacy.example/v1',
    defaultModel: 'legacy-model',
    contextCatalogUrl: undefined,
    apiKey: undefined,
    ...legacy,
  }
  await ctx.plugin(ProviderRegistryService, { dir, legacy: merged })
  await ctx.plugin(CredentialStoreService, { dir, legacyConfigKey: merged.apiKey })
  return { ctx, dir, reg: ctx.providers, cred: ctx.credentials }
}

// ------------------------------------------------------------ virtual default

{
  const { reg, cred } = await makeHost()
  const list = reg.list()
  assert.equal(list.length, 1, 'file-less registry exposes exactly the virtual default')
  const virtual = list[0]
  assert.equal(virtual.id, 'default')
  assert.equal(virtual.source, 'config')
  assert.equal(virtual.baseURL, 'https://legacy.example/v1')
  assert.equal(virtual.protocol, 'openai-chat')
  assert.ok(virtual.displayName && virtual.displayName.length >= 1, 'virtual default has a display name')
  assert.deepEqual(reg.default(), { provider: 'default', model: 'legacy-model' })
  assert.equal(reg.isVirtual('default'), true)
  // Creating an entry that would collide with the reserved id must fail.
  await assert.rejects(() => reg.create({ id: 'default', displayName: 'Nope', baseURL: 'http://x', protocol: 'openai-chat' }), /default/i)
  // describe() on the unconfigured virtual default stays honest.
  assert.deepEqual(cred.describe(virtual), { configured: false, source: null })
}

// ------------------------------------------------------- create / slug / id

{
  const { reg, dir } = await makeHost()
  const a = await reg.create({ displayName: 'My Stub API', baseURL: 'http://127.0.0.1:9999/v1', protocol: 'openai-chat' })
  assert.equal(a.id, 'my-stub-api', 'slug derives from display name')
  const b = await reg.create({ displayName: 'My Stub API', baseURL: 'http://127.0.0.1:9998/v1', protocol: 'openai-chat' })
  assert.equal(b.id, 'my-stub-api-2', 'slug collisions get a numeric suffix')
  assert.equal(reg.get('my-stub-api').displayName, 'My Stub API')

  // Id is immutable after create.
  const patched = await reg.update('my-stub-api', { displayName: 'Renamed', baseURL: 'http://127.0.0.1:9997/v1' })
  assert.equal(patched.id, 'my-stub-api')
  assert.equal(patched.displayName, 'Renamed')
  await assert.rejects(() => reg.update('my-stub-api', { id: 'hax' }), /immutable/i)

  // The virtual default is still listed after materializing the file.
  const ids = reg.list().map((p) => p.id)
  assert.deepEqual(ids, ['my-stub-api', 'my-stub-api-2', 'default'])

  // Persistence: file exists, parses, round-trips, no leftover tmp files.
  const text = await readFile(path.join(dir, 'providers.json'), 'utf8')
  const parsed = JSON.parse(text)
  assert.equal(parsed.version, 1)
  assert.equal(parsed.providers.length, 2, 'virtual default is NOT persisted')
  const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], 'atomic writes leave no tmp files')

  const again = await makeHostReload(dir)
  assert.equal(again.reg.get('my-stub-api').baseURL, 'http://127.0.0.1:9997/v1', 'registry reloads from disk')
  assert.equal(again.reg.list().length, 3, 'reload re-adds the virtual default')
}

/** Boots a fresh registry against an existing dir (process-restart simulation). */
async function makeHostReload(dir) {
  const ctx = new Context()
  await ctx.plugin(ProviderRegistryService, { dir, legacy: { baseURL: 'https://legacy.example/v1', defaultModel: 'legacy-model' } })
  await ctx.plugin(CredentialStoreService, { dir })
  return { ctx, reg: ctx.providers, cred: ctx.credentials }
}

// ------------------------------------------------------------- validation

{
  const { reg } = await makeHost()
  const cases = [
    [{ displayName: '', baseURL: 'http://x', protocol: 'openai-chat' }, /display name/i],
    [{ displayName: 'X', baseURL: 'not-a-url', protocol: 'openai-chat' }, /base url/i],
    [{ displayName: 'X', baseURL: 'ftp://x', protocol: 'openai-chat' }, /base url/i],
    [{ displayName: 'X', baseURL: 'http://x', protocol: 'gemini' }, /protocol/i],
    [{ id: 'Bad_ID!', displayName: 'X', baseURL: 'http://x', protocol: 'openai-chat' }, /id/i],
    [{ id: 'default', displayName: 'X', baseURL: 'http://x', protocol: 'openai-chat' }, /default/i],
  ]
  for (const [input, re] of cases) {
    await assert.rejects(() => reg.create(input), re, `create rejects ${JSON.stringify(input)}`)
  }
  // A validation failure must carry a recovery hint for the API layer.
  try {
    await reg.create({ displayName: '', baseURL: 'http://x', protocol: 'openai-chat' })
    assert.fail('expected rejection')
  } catch (error) {
    assert.ok(typeof error.hint === 'string' && error.hint.length > 0, 'error carries a recovery hint')
    assert.equal(error.status, 400)
  }
  await assert.rejects(() => reg.update('default', { displayName: 'X' }), /config/i, 'virtual default edits point at the config file')

  // Model catalog validation.
  const p = await reg.create({ displayName: 'Cat', baseURL: 'http://127.0.0.1:1/v1', protocol: 'openai-responses' })
  await reg.setModels(p.id, [{ id: 'm1', displayName: 'Model One', context: 131_072, maxOutput: 8_192, inputs: { vision: true, tools: true } }])
  assert.equal(reg.models(p.id)[0].context, 131_072)
  await assert.rejects(() => reg.setModels(p.id, [{ context: 5 }]), /model id/i)
  await assert.rejects(() => reg.setModels(p.id, [{ id: 'm', context: -1 }]), /context/i)
  await assert.rejects(() => reg.setModels(p.id, [{ id: 'm', maxOutput: 0 }]), /output/i)

  // Default selection validates against the registry.
  await reg.setDefault({ provider: p.id, model: 'm1' })
  assert.deepEqual(reg.default(), { provider: p.id, model: 'm1' })
  await assert.rejects(() => reg.setDefault({ provider: 'ghost', model: 'x' }), /unknown provider/i)
  await assert.rejects(() => reg.setDefault({ provider: p.id, model: 'ghost-model' }), /model/i)
}

// ------------------------------------------------------ credential store

{
  const dir = await mkdtemp(path.join(tmpdir(), 'sbx-cred-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(ProviderRegistryService, { dir, legacy: { baseURL: 'https://legacy.example/v1', defaultModel: 'm', apiKey: 'cfg-key-111' } })
  await ctx.plugin(CredentialStoreService, { dir, legacyConfigKey: 'cfg-key-111' })
  const reg = ctx.providers
  const cred = ctx.credentials
  const entry = await reg.create({ displayName: 'Cred Test', baseURL: 'http://127.0.0.1:1/v1', protocol: 'anthropic-messages' })
  const virtual = reg.get('default')

  // Unconfigured.
  assert.equal(cred.resolve(entry), undefined)
  assert.deepEqual(cred.describe(entry), { configured: false, source: null })

  // Local store: write-only API, atomic file, mode 0600.
  await cred.set(entry.id, `  ${SECRET}  `)
  assert.equal(cred.resolve(entry), SECRET, 'stored key resolves and is trimmed')
  const desc = cred.describe(entry)
  assert.equal(desc.configured, true)
  assert.equal(desc.source, 'local')
  assert.ok(Number.isInteger(desc.updatedAt))
  assert.ok(!JSON.stringify(desc).includes(SECRET), 'describe never carries the secret')
  const credText = await readFile(path.join(dir, 'credentials.json'), 'utf8')
  assert.ok(credText.includes(SECRET), 'secret lives only in the credential file')
  const regText = await readFile(path.join(dir, 'providers.json'), 'utf8')
  assert.ok(!regText.includes(SECRET), 'providers.json must never contain the secret')
  const mode = (await stat(path.join(dir, 'credentials.json'))).mode & 0o777
  if (process.platform !== 'win32') assert.equal(mode, 0o600, 'credential file is owner-only')
  await assert.rejects(() => cred.set(entry.id, ''), /key/i)
  await assert.rejects(() => cred.set(entry.id, 'x'.repeat(9000)), /key/i)

  // Precedence: env(apiKeyEnv) > local.
  process.env.SBX_TEST_KEY = 'from-env'
  const withEnv = await reg.update(entry.id, { apiKeyEnv: 'SBX_TEST_KEY' })
  assert.equal(cred.resolve(withEnv), 'from-env')
  assert.equal(cred.describe(withEnv).source, 'env')
  assert.equal(cred.describe(withEnv).envName, 'SBX_TEST_KEY')
  delete process.env.SBX_TEST_KEY
  assert.equal(cred.resolve(reg.get(entry.id)), SECRET, 'falls back to local once env is gone')

  // Precedence: local > config (default provider only).
  assert.equal(cred.resolve(virtual), 'cfg-key-111')
  assert.equal(cred.describe(virtual).source, 'config')
  await cred.set('default', 'local-for-default')
  assert.equal(cred.resolve(reg.get('default')), 'local-for-default')
  assert.equal(cred.describe(reg.get('default')).source, 'local')

  // Precedence: config > legacy BOTCONNECTOR env (default provider only).
  await cred.remove('default')
  process.env.BOTCONNECTOR_API_KEY = 'legacy-env-key'
  assert.equal(cred.resolve(reg.get('default')), 'cfg-key-111', 'config beats legacy env')
  await cred.remove('default')
  // Legacy configKey cleared -> legacy env wins with source env.
  const ctx2 = new Context()
  await ctx2.plugin(ProviderRegistryService, { dir, legacy: { baseURL: 'https://legacy.example/v1', defaultModel: 'm' } })
  await ctx2.plugin(CredentialStoreService, { dir })
  assert.equal(ctx2.credentials.resolve(ctx2.providers.get('default')), 'legacy-env-key')
  assert.equal(ctx2.credentials.describe(ctx2.providers.get('default')).source, 'env')
  delete process.env.BOTCONNECTOR_API_KEY

  // Removal.
  await cred.remove(entry.id)
  assert.equal(cred.resolve(reg.get(entry.id)), undefined)
  assert.equal(cred.describe(reg.get(entry.id)).configured, false)
}

// Cleanup env pollution even if an assertion above throws (finally at module level).
try {
  assert.ok(dirs.length >= 3)
  console.log('test-providers: OK (registry + credential store)')
} finally {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
}
