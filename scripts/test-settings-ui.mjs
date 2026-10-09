/**
 * Settings panel helper tests — loads the real classic script web/settings.js
 * the same way test-badge.mjs loads badge.js. Pure helpers only (spec §9):
 * provider form validation, model grouping, credential source labels,
 * delete-recovery copy, discovery diff, and option value encode/parse.
 *
 *   node scripts/test-settings-ui.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const src = await readFile(new URL('../web/settings.js', import.meta.url), 'utf8').catch(() => '')
assert.ok(src.trim(), 'web/settings.js should exist and be non-empty')
const factory = new Function(
  `${src}\n;return { validateProviderForm, groupModelsByProvider, credentialSourceLabel, deleteRecoveryCopy, diffDiscovery, encodeModelOption, parseModelOption, applyModelPick, PROTOCOL_OPTIONS }`,
)
const {
  validateProviderForm,
  groupModelsByProvider,
  credentialSourceLabel,
  deleteRecoveryCopy,
  diffDiscovery,
  encodeModelOption,
  parseModelOption,
  applyModelPick,
  PROTOCOL_OPTIONS,
} = factory()

// --------------------------------------------- validateProviderForm
{
  assert.deepEqual(PROTOCOL_OPTIONS, ['openai-chat', 'openai-responses', 'anthropic-messages'], 'only the tested trio')

  const ok = validateProviderForm({ displayName: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', protocol: 'openai-chat' })
  assert.deepEqual(ok, [], 'a complete valid form passes')

  const withId = validateProviderForm({
    id: 'openrouter',
    displayName: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    protocol: 'openai-responses',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  })
  assert.deepEqual(withId, [], 'optional id + env name validate when well formed')

  const fields = (form) => validateProviderForm(form).map((issue) => issue.field)
  assert.deepEqual(fields({ displayName: '', baseURL: 'https://x', protocol: 'openai-chat' }), ['displayName'], 'empty name flagged')
  assert.deepEqual(
    fields({ displayName: 'x'.repeat(81), baseURL: 'https://x', protocol: 'openai-chat' }),
    ['displayName'],
    'overlong name flagged',
  )
  assert.deepEqual(fields({ displayName: 'x', baseURL: '', protocol: 'openai-chat' }), ['baseURL'], 'empty base URL flagged')
  assert.deepEqual(fields({ displayName: 'x', baseURL: 'not a url', protocol: 'openai-chat' }), ['baseURL'], 'garbage URL flagged')
  assert.deepEqual(fields({ displayName: 'x', baseURL: 'ftp://x', protocol: 'openai-chat' }), ['baseURL'], 'non-http scheme flagged')
  assert.deepEqual(fields({ displayName: 'x', baseURL: 'https://x', protocol: 'grpc' }), ['protocol'], 'bad protocol flagged')
  assert.deepEqual(
    fields({ id: 'Bad ID', displayName: 'x', baseURL: 'https://x', protocol: 'openai-chat' }),
    ['id'],
    'non-slug id flagged',
  )
  assert.deepEqual(
    fields({ displayName: 'x', baseURL: 'https://x', protocol: 'openai-chat', apiKeyEnv: '1BAD' }),
    ['apiKeyEnv'],
    'bad env name flagged',
  )

  const messages = validateProviderForm({ displayName: '', baseURL: 'nope', protocol: 'nope' })
  assert.equal(messages.length, 3, 'all problems reported at once')
  for (const issue of messages) {
    assert.equal(typeof issue.message, 'string')
    assert.ok(issue.message.length > 8, 'messages are actionable sentences')
    assert.ok(!issue.message.includes('[object Object]'), 'never render raw objects')
  }
  // The protocol message names the allowed values (recovery built in).
  const proto = messages.find((m) => m.field === 'protocol')
  assert.match(proto.message, /openai-chat/)
  assert.match(proto.message, /anthropic-messages/)
}

// --------------------------------------------- groupModelsByProvider
{
  const models = [
    { id: 'gpt-6', provider: 'openrouter', providerName: 'OpenRouter' },
    { id: 'claude', provider: 'anthropic', providerName: 'Anthropic' },
    { id: 'glm', provider: 'openrouter', providerName: 'OpenRouter' },
    { id: 'agnes', provider: 'default', providerName: 'Default (config)' },
  ]
  const groups = groupModelsByProvider(models)
  assert.deepEqual(
    groups.map((g) => [g.provider, g.models.map((m) => m.id)]),
    [
      ['openrouter', ['gpt-6', 'glm']],
      ['anthropic', ['claude']],
      ['default', ['agnes']],
    ],
    'groups keep first-seen provider order and row order',
  )
  assert.equal(groups[0].providerName, 'OpenRouter', 'group carries the display label')
  assert.deepEqual(groupModelsByProvider([]), [], 'empty input -> empty list')
  // Legacy rows without provider identity land in the default group.
  const legacy = groupModelsByProvider([{ id: 'only' }])
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0].provider, 'default')
}

// --------------------------------------------- credentialSourceLabel
{
  assert.equal(credentialSourceLabel(null), 'not configured')
  assert.equal(credentialSourceLabel(undefined), 'not configured')
  assert.equal(credentialSourceLabel({ configured: false, source: null }), 'not configured')
  assert.equal(credentialSourceLabel({ configured: true, source: 'env', envName: 'OPENAI_API_KEY' }), 'configured via env (OPENAI_API_KEY)')
  assert.equal(credentialSourceLabel({ configured: true, source: 'local', updatedAt: 1 }), 'configured via local store')
  assert.equal(credentialSourceLabel({ configured: true, source: 'config' }), 'configured via config file')
  // Never leaks anything secret-shaped — labels are fixed vocabulary.
  assert.equal(credentialSourceLabel({ configured: true, source: 'local', updatedAt: 1 }).includes('sk-'), false)
}

// --------------------------------------------- deleteRecoveryCopy
{
  const copy = deleteRecoveryCopy(
    { displayName: 'OpenRouter' },
    [
      { id: 's-1', title: 'Refactor parser' },
      { id: 's-2', title: 'Write tests' },
    ],
    { provider: 'default', model: 'agnes-3.0-flash' },
  )
  assert.match(copy.title, /OpenRouter/, 'title names the provider')
  assert.match(copy.body, /2 sessions/, 'body counts the affected sessions')
  assert.match(copy.body, /Refactor parser/, 'body lists session titles')
  assert.match(copy.body, /Write tests/)
  assert.match(copy.body, /default/, 'body states the fallback')
  assert.match(copy.body, /agnes-3\.0-flash/, 'body names the fallback model')
  assert.ok(copy.confirm.length > 0 && copy.confirm !== copy.title, 'confirm label is its own action text')

  const single = deleteRecoveryCopy({ displayName: 'X' }, [{ id: 's', title: 'Solo' }], { provider: 'default', model: 'm' })
  assert.match(single.body, /1 session/, 'singular copy for one session')
  assert.ok(!/\b2 sessions\b/.test(single.body))

  const none = deleteRecoveryCopy({ displayName: 'X' }, [], { provider: 'default', model: 'm' })
  assert.equal(none.body.includes('session'), false, 'no sessions -> no session list in the copy')
}

// --------------------------------------------- diffDiscovery
{
  const candidates = diffDiscovery(['gpt-6'], [
    { id: 'gpt-6', displayName: 'GPT-6' },
    { id: 'kimi', displayName: 'Kimi' },
  ])
  assert.deepEqual(
    candidates.map((c) => [c.id, c.status]),
    [
      ['gpt-6', 'dup'],
      ['kimi', 'new'],
    ],
    'existing ids are dup, the rest are new',
  )
  assert.equal(candidates[1].displayName, 'Kimi', 'candidate payload survives the diff')
  assert.deepEqual(
    diffDiscovery([], [{ id: 'a' }]).map((c) => c.status),
    ['new'],
    'empty catalog -> everything new',
  )
  assert.deepEqual(diffDiscovery(['a'], []), [], 'no candidates -> nothing to show')
}

// --------------------------------------------- option value encode/parse
{
  // regression (found in a real browser): after a run the picker snapped to the first model because the
  // session's `model` held the encoded value and was encoded a second time
  const session = { model: 'old', provider: undefined }
  applyModelPick(session, 'default::gemini-2.5-flash-lite')
  assert.deepEqual(session, { model: 'gemini-2.5-flash-lite', provider: 'default' })
  assert.equal(encodeModelOption(session.provider, session.model), 'default::gemini-2.5-flash-lite', 'encodes once, matching the option value')
  applyModelPick(session, 'openrouter::gpt-6')
  assert.deepEqual(session, { model: 'gpt-6', provider: 'openrouter' })
  applyModelPick(session, 'bare-id')
  assert.deepEqual(session, { model: 'bare-id', provider: 'default' })
  assert.equal(applyModelPick(null, 'x'), null)
  assert.equal(encodeModelOption('openrouter', 'gpt-6'), 'openrouter::gpt-6')
  assert.equal(encodeModelOption(null, 'agnes-3.0-flash'), 'agnes-3.0-flash', 'legacy value stays bare')
  assert.equal(encodeModelOption('default', 'm1'), 'default::m1', 'explicit default is still encodable')

  assert.deepEqual(parseModelOption('openrouter::gpt-6'), { provider: 'openrouter', model: 'gpt-6' })
  assert.deepEqual(parseModelOption('agnes-3.0-flash'), { provider: 'default', model: 'agnes-3.0-flash' }, 'bare ids map to the default provider')
  assert.deepEqual(parseModelOption('p::with::colon'), { provider: 'p', model: 'with::colon' }, 'only the first separator splits')
  assert.deepEqual(parseModelOption(''), { provider: 'default', model: '' })

  // Round trip: encode(parse(v)) is stable for both shapes.
  assert.equal(encodeModelOption(...Object.values(parseModelOption('openrouter::gpt-6'))), 'openrouter::gpt-6')
  const bare = parseModelOption('m1')
  assert.equal(encodeModelOption(bare.provider, bare.model), 'default::m1', 're-encoding a bare id makes the provider explicit')
}

console.log('settings-ui: OK (validation, grouping, labels, recovery copy, discovery diff, option encode/parse)')
