/** Small, dependency-free Settings > Models rendering contract. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
const from = source.indexOf('function renderModelsPanel(panel, data) {')
const until = source.indexOf('\nfunction providerFormHtml()', from)
assert.ok(from > 0 && until > from)
const run = (core) => {
  const context = {
    settingsUi: { localCore: core, localCoreLoading: false, editing: null },
    state: { models: [] },
    catalogProviderIds: () => ['default'],
    providerCardHtml: () => '',
    esc: (text) => String(text ?? '').replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  }
  vm.runInNewContext(source.slice(from, until), context)
  const panel = { innerHTML: '' }
  context.renderModelsPanel(panel, { providers: [], default: { provider: 'default', model: 'unused' } })
  return panel.innerHTML
}
const ready = run({ running: true, models: [{ id: 'vision-local.gguf' }] })
assert.match(ready, /AI Lokal/)
assert.match(ready, /vision-local\.gguf/)
assert.match(ready, /data-action="local-core-connect"/)
assert.match(ready, /Gunakan model lokal/)
assert.match(ready, /<h3>Default model<\/h3>/)
const offline = run({ running: false, models: [], reason: 'Runtime not ready' })
assert.match(offline, /Runtime not ready/)
assert.doesNotMatch(offline, /data-action="local-core-connect"/)
assert.match(offline, /data-action="local-core-refresh"/)
const malicious = run({ running: true, models: [{ id: '<img src=x onerror=alert(1)>' }] })
assert.doesNotMatch(malicious, /<img src=x/)
assert.match(malicious, /&lt;img src=x/)
console.log('LOCAL_CORE_UI_CONTRACT_PASS: reuse Models panel, explicit connect, offline & XSS safe')
