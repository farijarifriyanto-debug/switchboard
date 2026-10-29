// Real visible Chrome acceptance for the additive workflow recorder/replay and
// the model/API-key settings handoff. No provider request or real credential.
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { createHost } from '../dist/index.js'

const chromeBin = process.env.SBX_TEST_CHROME_PATH
if (!chromeBin) throw Error('Set SBX_TEST_CHROME_PATH to Chrome for Testing')
const profile = await mkdtemp(path.join(tmpdir(), 'switchboard-tasks-qa-'))
const fixture = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><title>QA</title><button id="compare" onclick="this.dataset.n=Number(this.dataset.n||0)+1;this.textContent=\'Clicks: \'+this.dataset.n">Clicks: 0</button><button id="other" onclick="this.dataset.n=Number(this.dataset.n||0)+1">Pay now</button>')
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const fixturePort = fixture.address().port
const fixtureUrl = 'http://127.0.0.1:' + fixturePort + '/'
const freePort = async () => {
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const value = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return value
}
const bridgePort = await freePort(), webPort = await freePort()
const chromePortServer = http.createServer()
await new Promise(resolve => chromePortServer.listen(0, '127.0.0.1', resolve))
const chromePort = chromePortServer.address().port
await new Promise(resolve => chromePortServer.close(resolve))
const extensionDir = path.resolve('browser-extension')
const chrome = spawn(chromeBin, [
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--remote-allow-origins=*', '--remote-debugging-port=' + chromePort,
  '--user-data-dir=' + profile, '--load-extension=' + extensionDir,
  '--disable-extensions-except=' + extensionDir, fixtureUrl
], { stdio: 'ignore' })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let ws, host
try {
  let version
  for (let i = 0; i < 70; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + chromePort + '/json/version')
      if (res.ok) { version = await res.json(); break }
    } catch {}
    await sleep(200)
  }
  assert.ok(version, 'Visible Chrome starts with a temporary test profile')
  ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0
  const pending = new Map()
  ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    const callback = pending.get(msg.id)
    if (!callback) return
    pending.delete(msg.id)
    msg.error ? callback.reject(Error(msg.error.message)) : callback.resolve(msg.result)
  }
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  let worker, swSession
  for (let i = 0; i < 50 && !worker; i++) {
    const targets = (await cdp('Target.getTargets')).targetInfos
      .filter(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://') && t.url.endsWith('/background.js'))
    for (const candidate of targets) {
      const session = (await cdp('Target.attachToTarget', { targetId: candidate.targetId, flatten: true })).sessionId
      try {
        await cdp('Runtime.enable', {}, session)
        const probe = await cdp('Runtime.evaluate', { expression: 'chrome.runtime?.getManifest?.().name', returnByValue: true }, session)
        if (probe.result?.value === 'Switchboard Browser Companion') {
          worker = candidate
          swSession = session
          break
        }
      } catch {}
      if (!worker) await cdp('Target.detachFromTarget', {sessionId:session}).catch(() => {})
    }
    if (!worker) await sleep(200)
  }
  assert.ok(worker, 'Real Switchboard MV3 extension worker exists')
  const evaluate = async (expression, sessionId = swSession) => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (result.exceptionDetails) throw Error('Chrome evaluation failed: ' + result.exceptionDetails.text)
    return result.result?.value
  }
  // Some Chrome-for-Testing builds start the command-line page before
  // extension tab enumeration becomes available. Create a normal tab from
  // the installed extension when none is enumerated.
  if (!(await evaluate('chrome.tabs.query({}).then(x=>x.length)'))) {
    await evaluate("chrome.tabs.create({url:" + JSON.stringify(fixtureUrl) + "}).then(x=>({id:x.id,url:x.url}))")
  }
  const listing = await evaluate("chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url})))")
  if (listing.length && !listing.some(t => t.url === fixtureUrl)) {
    await evaluate("chrome.tabs.update(" + listing[0].id + ",{url:" + JSON.stringify(fixtureUrl) + "})")
  }
  let tabs = []
  for (let i = 0; i < 50; i++) {
    tabs = await evaluate("chrome.tabs.query({}).then(t=>t.filter(x=>x.url?.startsWith('http://127.0.0.1:')).map(x=>({id:x.id,url:x.url})))")
    if (tabs.some(t => t.url === fixtureUrl)) break
    await sleep(200)
  }
  const qaTab = tabs.find(t => t.url === fixtureUrl)
  assert.ok(qaTab, 'Local fixture tab exists')
  await evaluate('bindAgentTab(' + qaTab.id + ')')
  await evaluate("chrome.storage.session.set({workflowRecording:true})")
  const first = await evaluate("handleToolExecution('browser_click',{selector:'#compare'})")
  assert.equal(first.ok, true, 'Agent browser click completed')
  const recorded = await evaluate("chrome.storage.local.get('workflowSteps').then(x=>x.workflowSteps)")
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].selector, '#compare')
  const beforeReplay = await evaluate("chrome.scripting.executeScript({target:{tabId:" + qaTab.id + "},func:()=>document.querySelector('#compare').textContent}).then(x=>x[0].result)")
  assert.equal(beforeReplay, 'Clicks: 1', 'Actual Chrome DOM changed')
  await evaluate("chrome.storage.session.set({workflowRecording:false})")
  const replay = await evaluate("replayWorkflow([{action:'click',selector:'#compare'}])")
  assert.equal(replay.ok, true, 'Replay succeeds on Chrome fixture')
  const afterReplay = await evaluate("chrome.scripting.executeScript({target:{tabId:" + qaTab.id + "},func:()=>document.querySelector('#compare').textContent}).then(x=>x[0].result)")
  assert.equal(afterReplay, 'Clicks: 2', 'Replay performs exactly one real click')
  console.log('PASS visible Chrome agent action is recorded and replayed once with actual DOM evidence')
  const riskyReplay = await evaluate("replayWorkflow([{action:'click',selector:'#other'}])")
  assert.equal(riskyReplay.ok, false, 'Sensitive button label blocks workflow replay')
  assert.match(riskyReplay.results[0].error, /sensitive/)
  const riskyClickCount = await evaluate("chrome.scripting.executeScript({target:{tabId:" + qaTab.id + "},func:()=>Number(document.querySelector('#other').dataset.n||0)}).then(x=>x[0].result)")
  assert.equal(riskyClickCount, 0, 'Protected click did not mutate real Chrome DOM')
  console.log('PASS visible Chrome rejects a Pay now button even behind a neutral selector')
  const webToken = randomBytes(32).toString('hex')
  host = await createHost({
    settings: { dir: path.join(profile, 'switchboard-settings') },
    sessions: { dir: '', load: false },
    metrics: { persist: '', load: false },
    approval: { mode: 'risky' },
    browser: { host: '127.0.0.1', port: bridgePort, token: randomBytes(32).toString('hex') },
    web: { enabled: true, host: '127.0.0.1', port: webPort, token: webToken }
  })
  await host.ctx.web.ready()
  // Simulate the operator opening the token-bearing URL printed by sbx web.
  // A first-party HttpOnly cookie is established; the extension never receives
  // or stores this console token, and its browser token remains settings-scoped out.
  const login = await cdp('Target.createTarget', {
    url: 'http://127.0.0.1:' + webPort + '/?token=' + encodeURIComponent(webToken)
  })
  let authenticatedConsole = false
  for (let i = 0; i < 55; i++) {
    const target = (await cdp('Target.getTargets')).targetInfos.find(t => t.targetId === login.targetId)
    authenticatedConsole = Boolean(target && target.url === 'http://127.0.0.1:' + webPort + '/')
    if (authenticatedConsole) break
    await sleep(150)
  }
  assert.ok(authenticatedConsole, 'One-time URL establishes the Web Console cookie before extension handoff')
  const paired = await evaluate("pairBridge({url:" + JSON.stringify('http://127.0.0.1:' + bridgePort) +
    ",code:" + JSON.stringify(host.ctx.browserCompanion.pairingCode) + "})")
  assert.equal(paired.ok, true, 'Real Browser Companion paired to isolated Switchboard host')
  let connected = false
  for (let i = 0; i < 25; i++) {
    const status = await evaluate('bridgeStatus()')
    connected = status?.connected && status.webOrigin === 'http://127.0.0.1:' + webPort
    if (connected) break
    await sleep(200)
  }
  assert.equal(connected, true, 'Real paired host advertises the actual console port')
  const extensionId = worker.url.split('/')[2]
  const panelTarget = await cdp('Target.createTarget', { url: 'chrome-extension://' + extensionId + '/panel.html?view=settings' })
  const panelSession = (await cdp('Target.attachToTarget', { targetId: panelTarget.targetId, flatten: true })).sessionId
  await cdp('Runtime.enable', {}, panelSession)
  let ready = false
  for (let i = 0; i < 50; i++) {
    ready = await evaluate("document.readyState === 'complete' && typeof openModelKeySettings === 'function' && Boolean(companionToken)", panelSession)
    if (ready) break
    await sleep(150)
  }
  assert.equal(ready, true, 'Model key shortcut is initialized in Chrome extension settings')
  await evaluate("document.getElementById('configure-model-key-settings').click()", panelSession)
  let settingsTarget
  for (let i = 0; i < 50; i++) {
    // CDP observes the browser destination independently. Some Chrome builds
    // temporarily expose an empty tab.url to MV3 even after navigation.
    settingsTarget = (await cdp('Target.getTargets')).targetInfos.find(
      t => t.type === 'page' && t.url === 'http://127.0.0.1:' + webPort + '/?settings=models')
    if (settingsTarget) break
    await sleep(150)
  }
  assert.ok(settingsTarget, 'Settings shortcut opens the authenticated loopback console')
  const settingsSession = (await cdp('Target.attachToTarget', {targetId: settingsTarget.targetId, flatten: true})).sessionId
  await cdp('Runtime.enable', {}, settingsSession)
  let modelsDialogOpen = false
  for (let i = 0; i < 60; i++) {
    modelsDialogOpen = await evaluate("Boolean(document.getElementById('settings-dialog')?.open && document.querySelector('.settings-panel[data-settings-panel=models]')?.hidden === false)", settingsSession)
    if (modelsDialogOpen) break
    await sleep(150)
  }
  assert.ok(modelsDialogOpen, 'Actual Web Console models/key form opens, not just a browser URL')
  console.log('PASS visible Chrome authenticated API-key shortcut opens actual Settings > Models UI')
  await evaluate("chrome.storage.local.set({workflowSteps:[{action:'type',selector:'#name',value:'QA_PRIVATE_TEST_VALUE'}]})")
  await sleep(250)
  await evaluate("document.getElementById('export-workflow-btn').click()", panelSession)
  const exportStatus = await evaluate("document.getElementById('replay-progress-bar').textContent", panelSession)
  assert.match(exportStatus, /Ekspor ditolak/, 'Legacy typed values are never exported to JSON')
  console.log('PASS visible Chrome refuses exporting legacy workflow typed values')
  const receipt = await evaluate(`(() => {
    const msg = createAgentMessage();
    const step = document.createElement('div');
    step.className = 'step done';
    msg.items.set('qa', step);
    msg.receipt.textContent = taskReceiptText('completed', ['done']);
    msg.receipt.hidden = false;
    document.getElementById('chat-log').append(msg.root);
    return {visible: !msg.receipt.hidden, text: msg.receipt.textContent,
      noActions: taskReceiptText('completed', [])};
  })()`, panelSession)
  assert.equal(receipt.visible, true)
  assert.match(receipt.text, /dilaporkan berhasil/i)
  assert.match(receipt.text, /bukan verifikasi independen/i)
  assert.match(receipt.noActions, /tanpa aksi browser/i)
  console.log('PASS visible Chrome task receipt distinguishes reported tool success from independent verification')
} finally {
  try { ws?.close() } catch {}
  await host?.dispose().catch(() => {})
  chrome.kill()
  await new Promise(resolve => fixture.close(resolve))
  await sleep(600)
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
}
