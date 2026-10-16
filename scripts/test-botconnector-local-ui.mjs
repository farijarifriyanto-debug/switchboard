/** Small, dependency-free Settings > Models rendering contract. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
const from = source.indexOf('function renderModelsPanel(panel, data) {')
const until = source.indexOf('\nfunction providerFormHtml()', from)
assert.ok(from > 0 && until > from)
const run = (core, installed = []) => {
  const context = {
    settingsUi: { localCore: core, localCoreLoading: false, localInstalled: installed, editing: null },
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
assert.match(ready, /Plug \/ Hubungkan/)
assert.match(ready, /Unplug \/ Lepas/)
assert.match(ready, /Kelola &amp; Download model/)
assert.match(ready, /disabled>Unplug \/ Lepas/)
assert.match(ready, /Model GGUF terpasang \(0\)/)
assert.match(ready, /<h3>Default model<\/h3>/)
const offline = run({ running: false, models: [], reason: 'Runtime not ready' })
assert.match(offline, /Runtime not ready/)
assert.doesNotMatch(offline, /data-action="local-core-connect"/)
assert.match(offline, /data-action="local-core-refresh"/)
const malicious = run({ running: true, models: [{ id: '<img src=x onerror=alert(1)>' }] })
assert.doesNotMatch(malicious, /<img src=x/)
assert.match(malicious, /&lt;img src=x/)
const installedXss = run({ running: false, models: [], reason: 'Offline' }, [{ id:'fake', repoId: '<img src=x onerror=alert(1)>',name:'bad.gguf', sizeMb: 42, chat:true }])
assert.doesNotMatch(installedXss, /<img src=x/)
assert.match(installedXss, /&lt;img src=x/)
console.log('LOCAL_CORE_UI_CONTRACT_PASS: reuse Models panel, explicit connect, offline & XSS safe')
