// Regression contract for the additive Switchboard Tasks + secure API key entry.
// Runs without a real browser; real Chrome E2E is a separate release gate.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const panel = readFileSync('browser-extension/panel.js', 'utf8')
const background = readFileSync('browser-extension/background.js', 'utf8')
const consoleSource = readFileSync('web/app.js', 'utf8')
const html = readFileSync('browser-extension/panel.html', 'utf8')

function extract(source, from, to) {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, 'Source section exists: ' + from)
  return source.slice(start, end)
}

const imported = new Function(extract(panel, 'function parseWorkflowImport(', "$('import-workflow-btn')") +
  '\nreturn parseWorkflowImport')()
const valid = imported({version: 1, steps: [
  {action: 'navigate', url: 'https://example.com/products'},
  {action: 'click', selector: '#compare'},
  {action: 'scroll', direction: 'down', amount: 750}
]})
assert.equal(valid.length, 3)
assert.equal(valid[0].url, 'https://example.com/products')
assert.deepEqual(Object.keys(valid[1]), ['action', 'selector'])
for (const raw of [
  {version: 1, steps: [{action: 'type', selector: '#key', value: 'secret'}]},
  {version: 1, steps: [{action: 'click', selector: '@e1'}]},
  {version: 1, steps: [{action: 'click', selector: '#password'}]},
  {version: 1, steps: [{action: 'click', selector: '#pay'}]},
  {version: 1, steps: [{action: 'navigate', url: 'https://example.com/?token=secret'}]},
  {version: 1, steps: [{action: 'navigate', url: 'javascript:alert(1)'}]},
  {version: 1, steps: Array(51).fill({action: 'scroll'})},
]) assert.throws(() => imported(raw), /./)
console.log('PASS workflow import sanitizes and bounds input')
assert.match(extract(panel, "$('export-workflow-btn')", 'function parseWorkflowImport('), /safeSteps = parseWorkflowImport\(/)
console.log('PASS workflow export validates legacy stored steps before saving a file')

let enabled = true
let steps = []
const chrome = {
  storage: {
    session: {get: async () => ({workflowRecording: enabled})},
    local: {
      get: async () => ({workflowSteps: steps}),
      set: async ({workflowSteps}) => { steps = workflowSteps }
    }
  }
}
const recordSource = extract(background, 'async function maybeRecordAgentAction(', 'async function handleToolExecution(')
const recorder = new Function('chrome', recordSource + '\nreturn maybeRecordAgentAction')(chrome)
await recorder('browser_type', {selector: '#name', text: 'private-text'}, {ok: true})
await recorder('browser_navigate', {url: 'https://example.com/path?secret=1'}, {ok: true})
await recorder('browser_click', {selector: '@e3'}, {ok: true})
await recorder('browser_click', {selector: '#compare'}, {ok: false})
assert.equal(steps.length, 0)
await recorder('browser_click', {selector: '#compare'}, {ok: true})
assert.deepEqual(steps, [{action: 'click', selector: '#compare'}])
enabled = false
await recorder('browser_scroll', {direction: 'down', amount: 450}, {ok: true})
assert.equal(steps.length, 1)
console.log('PASS recorder is opt-in and never stores private typed values')

const replaySource = background.slice(background.lastIndexOf('let activeReplayCancelled = false;'))
const calls = []
let release
let actionStarted
const started = new Promise(resolve => { actionStarted = resolve })
const firstAction = new Promise(resolve => { release = resolve })
const context = vm.createContext({
  boundAgentTab: async () => ({id: 1, url: 'http://127.0.0.1:8999/'}),
  executeBrowserAction: async (action) => {
    calls.push(action)
    actionStarted()
    if (calls.length === 1) await firstAction
    return {ok: true}
  },
  setTimeout,
  Promise,
  Error,
  String,
})
vm.runInContext(replaySource + '\nglobalThis.test = {replayWorkflow, validateReplaySteps, cancel: () => { activeReplayCancelled = true }}', context)
const replay = context.test.replayWorkflow([
  {action: 'scroll', direction: 'down'},
  {action: 'scroll', direction: 'down'}
])
await started
context.test.cancel()
release()
const stopped = await replay
assert.equal(stopped.ok, false)
assert.equal(stopped.cancelled, true)
assert.equal(calls.length, 1)
console.log('PASS Stop halts replay after its in-flight action')

assert.equal(context.test.validateReplaySteps([{action: 'click', selector: '#delete-account'}]), false)
assert.equal(context.test.validateReplaySteps([{action: 'click', selector: '#compare'}]), true)
assert.equal(context.test.validateReplaySteps([{action: 'navigate', url: 'javascript:alert(1)'}]), false)
const clickCtx = vm.createContext({
  URL, Error, String, Number, Promise, setTimeout,
  boundAgentTab: async () => ({id: 1, url: 'http://127.0.0.1:8999/'}),
  executeBrowserAction: async () => { throw Error('timeout after click') },
  errorMessage: error => String(error.message),
})
vm.runInContext(replaySource + '\nglobalThis.run = replayWorkflow', clickCtx)
const failedClick = await clickCtx.run([{action: 'click', selector: '#compare'}])
assert.equal(failedClick.ok, false)
assert.equal(failedClick.results[0].attempts, 1, 'Never retry a possibly completed click')
console.log('PASS replay rejects risky actions and does not duplicate clicks after failure')

// Replaying must never silently take over whichever personal Chrome tab is focused.
let personalTabActions = 0
const unbound = vm.createContext({
  URL, Error, String, Number, Promise, setTimeout,
  boundAgentTab: async () => null,
  getActiveTab: async () => ({id: 98, url: 'https://private.example'}),
  executeBrowserAction: async () => { personalTabActions++; return {ok: true} },
  errorMessage: error => String(error.message),
})
vm.runInContext(replaySource + '\nglobalThis.run = replayWorkflow', unbound)
const unsafe = await unbound.run([{action:'scroll', direction:'down', amount:200}])
assert.equal(unsafe.ok, false, 'No bound agent tab must refuse replay')
assert.equal(personalTabActions, 0, 'Never mutate the currently focused personal tab')
console.log('PASS replay refuses unbound/personal tabs')

assert.ok(html.includes('id="task-configure-key"'))
assert.ok(html.includes('id="configure-model-key-settings"'))
assert.match(html,/id="byok-key" type="password"/,'BYOK secret is masked in the side panel')
assert.match(html,/id="byok-provider"/,'BYOK provider choice is present')
assert.match(html,/<option value="botconnector">BotConnector Cloud<\/option>/,
  'BotConnector Cloud is selectable directly in the side panel')
assert.match(html,/<select id="byok-model"/,'BotConnector uses a model dropdown, not a manually typed Model ID')
assert.match(html,/id="byok-model-search" type="search"/,'Cloud model picker provides name search')
assert.match(html,/id="byok-model-filter"/,'Cloud model picker has Free/Plan filtering')
assert.match(html,/id="cloud-quick-model"/,'Chat composer exposes direct AI selection')
assert.match(html,/id="chat-copy"[^>]*aria-label="Salin seluruh percakapan"/,'Chat header has accessible Copy Conversation button')
assert.match(panel,/function createUserMessage\(question\)/,'User questions have their own copy icon')
assert.match(panel,/makeMessageCopyButton\('Salin pertanyaan', 'msg-copy-user'/,'Question copy uses icon-only button')
assert.match(panel,/makeMessageCopyButton\('Salin jawaban AI', 'msg-copy-agent'/,'AI reply copy also uses icon-only button')
assert.match(panel,/querySelector\('\.user-message-text'\)/,'Transcript excludes question copy button content')
assert.match(panel,/function chatTranscriptPlainText\(/,'Chat transcript copy uses a dedicated plaintext source')
assert.match(panel,/button\.addEventListener\('click', \(\) => void copyConversationText\(value\(\), button\)\)/,'Each copy icon invokes clipboard with its own message text')
assert.match(panel,/function renderAgentAnswer\(/,'Both local and cloud answers retain copyable plain text')
for (const id of ['tab-add-open','tab-add-confirm','tab-detach-current','tab-bound-list','tab-available','tab-manager']) {
  assert.ok(html.includes('id="'+id+'"'),'Cloud tab manager control present: '+id)
}
assert.match(panel,/SWITCHBOARD_CLOUD_ATTACH/,'Explicit cloud tab attachment is available')
assert.match(panel,/SWITCHBOARD_CLOUD_DETACH/,'Cloud tab can be detached without closing Chrome')
assert.match(panel,/SWITCHBOARD_CLOUD_TOOL/,'Cloud agent uses scoped tab tool dispatcher')
assert.match(html,/id="byok-model-manual"/,'Legacy local providers retain their manual model input')
assert.match(panel,/keyField\.value = ''/,'API key is cleared after save or failure')
assert.match(panel,/api\/companion-byok\/request|byokApi\(origin, token, 'request'/)
assert.match(consoleSource,/showCompanionByokApproval/,'Separate local console consent stays explicit')
const openSettingsFn = new Function('chrome', 'normalizeWebOrigin', 'taskStatus', '$',
  extract(panel, 'async function openModelKeySettings()', '// BotConnector Cloud standalone stores BYOK') +
  '\nreturn openModelKeySettings')
let settingsUrls = [], settingsHint = ''
const diagnostics = {textContent: ''}
const mockChrome = {
  runtime: {sendMessage: async () => ({connected: false, webOrigin: 'http://127.0.0.1:7777'})},
  tabs: {create: async data => {settingsUrls.push(data.url)}}
}
const openKeySettings = openSettingsFn(mockChrome, value => {
  try {const url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1' ? url.origin : ''} catch {return ''}
}, message => {settingsHint = message}, () => diagnostics)
await openKeySettings()
assert.equal(settingsUrls.length, 0, 'Disconnected companion never opens a stale fallback port')
assert.match(settingsHint, /Hubungkan Browser Companion/)
assert.match(diagnostics.textContent, /Hubungkan Browser Companion/)
mockChrome.runtime.sendMessage = async () => ({connected: true, webOrigin: 'http://127.0.0.1:60410'})
await openKeySettings()
assert.deepEqual(settingsUrls, ['http://127.0.0.1:60410/?settings=models'])
console.log('PASS disconnected handoff fails closed and paired console port is authoritative')
assert.ok(consoleSource.includes("requestedSettings === 'models'"))
assert.ok(consoleSource.includes("await openSettings('models')"))
assert.ok(consoleSource.includes('data-action="save-credential"'))
console.log('PASS model/API key entry reuses local write-only Settings > Models')

// Task receipts must distinguish observed tool execution from model prose.
const receiptCode = extract(panel, 'function toolResultFailed(', 'function note(')
const receipts = new Function(receiptCode + '\nreturn {toolResultFailed, taskReceiptText}')()
assert.equal(receipts.toolResultFailed('Error: site denied'), true)
assert.equal(receipts.toolResultFailed('{"ok":false,"error":"denied"}'), true)
assert.equal(receipts.toolResultFailed('{"ok":true,"result":"done"}'), false)
assert.equal(receipts.toolResultFailed('plain successful output'), false)
assert.match(receipts.taskReceiptText('completed', ['done','done']), /2 .*dilaporkan berhasil/i)
assert.match(receipts.taskReceiptText('completed', []), /tanpa.*aksi browser/i)
assert.match(receipts.taskReceiptText('failed', ['done','failed']), /gagal/i)
assert.match(receipts.taskReceiptText('cancelled', ['done','running']), /dihentikan/i)
assert.match(receipts.taskReceiptText('step_limit', ['done','running']), /batas langkah/i)
console.log('PASS task receipt differentiates tool results, failure, cancellation and unverified answers')

console.log('=== Task UX regression contracts PASS ===')
