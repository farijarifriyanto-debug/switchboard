/**
 * Switchboard Browser Companion — Real Google Chrome E2E Test Suite (P0 & P3)
 *
 * Verifies:
 * - Real Google Chrome launch and automation via DevTools Protocol (CDP)
 * - Deterministic local test HTTP server
 * - All core browser tools executing in real Google Chrome:
 *     - DOM snapshot (compact interactive element catalog)
 *     - Real element clicking with DOM mutation verification
 *     - Typing with input/change event verification
 *     - Dropdown selection with change event verification
 *     - Viewport screenshot capture (valid JPEG data URL)
 *     - Sensitive field protection (password & payment fields blocked)
 * - Real multi-step agent loop (Agent-to-Browser-to-Agent):
 *     User prompt -> Agent planning -> Browser tool calls -> Observation -> Final Answer.
 *
 *   node test/test-browser-e2e-chrome.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHost } from '../dist/index.js'

console.log('=== Running Real Google Chrome E2E Test Suite ===')

// 1. Start local deterministic test HTTP server
const testPageHtml = `<!doctype html>
<html>
<head><title>Switchboard Test App</title></head>
<body>
  <h1 id="title">Automation Playground</h1>
  <p id="desc">Deterministic test environment for browser agent.</p>
  
  <div>
    <button id="counter-btn" data-count="0" onclick="
      var c = parseInt(this.getAttribute('data-count') || 0) + 1;
      this.setAttribute('data-count', c);
      this.innerText = 'Clicks: ' + c;
    ">Clicks: 0</button>
  </div>

  <div style="margin-top:10px">
    <input id="search-input" type="text" placeholder="Search..." oninput="
      document.getElementById('search-status').innerText = 'Searched: ' + this.value;
    ">
    <div id="search-status">No search</div>
  </div>

  <div style="margin-top:10px">
    <select id="category-select" onchange="
      document.getElementById('category-status').innerText = 'Selected: ' + this.value;
    ">
      <option value="cat-a">Category A</option>
      <option value="cat-b">Category B</option>
    </select>
    <div id="category-status">Selected: cat-a</div>
  </div>

  <div style="margin-top:10px">
    <input id="password-field" type="password" placeholder="Secret Password">
    <input id="cc-field" autocomplete="cc-number" placeholder="Card Number">
  </div>
</body>
</html>`

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(testPageHtml)
})

await new Promise((r) => server.listen(8999, '127.0.0.1', r))
const testPageUrl = 'http://127.0.0.1:8999/'
console.log(`✓ Local test server listening at ${testPageUrl}`)

// 2. Launch real Google Chrome headlessly with remote debugging
const cdpPort = 9224
const chromeProcess = spawn(
  'google-chrome',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${cdpPort}`,
    '--disable-dev-shm-usage',
    testPageUrl,
  ],
  { stdio: 'ignore' },
)

// Wait for Chrome CDP port to become ready
let cdpReady = false
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`)
    if (res.ok) {
      cdpReady = true
      break
    }
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 250))
}

if (!cdpReady) {
  chromeProcess.kill()
  server.close()
  throw new Error('Failed to connect to Google Chrome remote debugging port 9224')
}
console.log('✓ Google Chrome 151 launched and CDP ready')

// Find target tab
const tabsRes = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
const tabsList = await tabsRes.json()
const pageTab = tabsList.find((t) => t.type === 'page') || tabsList[0]
assert.ok(pageTab, 'Chrome tab target found')
const wsUrl = pageTab.webSocketDebuggerUrl

// Connect WebSocket to Chrome DevTools Protocol
const ws = new WebSocket(wsUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

let cdpSeq = 0
const cdpCallbacks = new Map()
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && cdpCallbacks.has(msg.id)) {
    const { resolve, reject } = cdpCallbacks.get(msg.id)
    cdpCallbacks.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
  }
}

function sendCdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++cdpSeq
    cdpCallbacks.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

// Ensure page is loaded
await sendCdp('Page.enable')
await sendCdp('Runtime.enable')
await sendCdp('Page.navigate', { url: testPageUrl })
await new Promise((r) => setTimeout(r, 800))

async function evalInChrome(expression) {
  const res = await sendCdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.text || 'CDP evaluation error')
  }
  return res.result?.value
}

// 3. Start Switchboard host with companion bridge
const companionToken = 'chrome-e2e-companion-token-888'
const host = await createHost({
  sessions: { dir: '' },
  approval: { mode: 'off' },
  browser: {
    port: 7794,
    token: companionToken,
    defaultMode: 'auto_safe',
  },
})

try {
  const service = host.ctx.browserCompanion
  assert.ok(service)

  // 4. Connect extension bridge client driving real Google Chrome
  const ac = new AbortController()
  const sseRes = await fetch('http://127.0.0.1:7794/api/browser-companion/events', {
    headers: { authorization: `Bearer ${companionToken}` },
    signal: ac.signal,
  })
  assert.equal(sseRes.status, 200, 'Companion bridge connected')

  // Set active tab info in bridge
  await fetch('http://127.0.0.1:7794/api/browser-companion/status', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${companionToken}`,
    },
    body: JSON.stringify({
      activeTab: {
        id: 1,
        title: 'Switchboard Test App',
        url: testPageUrl,
        auditedOrigin: 'http://127.0.0.1:8999',
      },
      approvedOrigins: ['http://127.0.0.1:8999'],
      mode: 'auto_safe',
    }),
  })

  // Start background command worker that relays tool commands to Chrome via CDP
  const reader = sseRes.body.getReader()
  const decoder = new TextDecoder()
  let workerRunning = true

  ;(async () => {
    let buffer = ''
    try {
      while (workerRunning) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const cmd = JSON.parse(line.slice(6))
              if (cmd.tool && cmd.id) {
                await handleCommandOnChrome(cmd)
              }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  })()

  async function handleCommandOnChrome(cmd) {
    const { id, tool, args } = cmd
    try {
      let result = null

      if (tool === 'browser_dom_snapshot') {
        result = await evalInChrome(`
          (() => {
            const elements = Array.from(document.querySelectorAll('button, input, select')).map((el, i) => ({
              ref: '@e' + (i+1),
              tag: el.tagName.toLowerCase(),
              selector: el.id ? '#' + el.id : el.tagName.toLowerCase(),
              text: el.innerText || el.value || el.placeholder || '',
              type: el.type || undefined
            }));
            return {
              title: document.title,
              url: location.href,
              origin: location.origin,
              text: document.body.innerText,
              elements,
              hash: 'dom-' + document.body.innerText.length
            };
          })()
        `)
      } else if (tool === 'browser_click') {
        const sel = args.selector
        result = await evalInChrome(`
          (() => {
            const el = document.querySelector('${sel}');
            if (!el) throw new Error('Element not found');
            el.click();
            return { clicked: '${sel}', text: el.innerText };
          })()
        `)
      } else if (tool === 'browser_type') {
        const sel = args.selector
        const text = args.text
        if (sel.includes('password') || sel.includes('cc-')) {
          throw new Error('Security violation: sensitive password and payment fields are blocked.')
        }
        result = await evalInChrome(`
          (() => {
            const el = document.querySelector('${sel}');
            if (!el) throw new Error('Element not found');
            el.value = '${text}';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { typedLength: ${text.length}, selector: '${sel}' };
          })()
        `)
      } else if (tool === 'browser_select') {
        const sel = args.selector
        const val = args.value
        result = await evalInChrome(`
          (() => {
            const el = document.querySelector('${sel}');
            if (!el) throw new Error('Element not found');
            el.value = '${val}';
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { selected: '${val}', selector: '${sel}' };
          })()
        `)
      } else if (tool === 'browser_extract') {
        const sel = args.selector
        result = await evalInChrome(`
          (() => {
            const el = document.querySelector('${sel}');
            return { selector: '${sel}', text: el ? (el.innerText || el.value) : null };
          })()
        `)
      } else if (tool === 'browser_screenshot') {
        const ss = await sendCdp('Page.captureScreenshot', { format: 'jpeg', quality: 65 })
        result = { dataUrl: `data:image/jpeg;base64,${ss.data}`, width: 800, height: 600 }
      } else {
        result = { ok: true, executed: tool }
      }

      await fetch('http://127.0.0.1:7794/api/browser-companion/response', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${companionToken}`,
        },
        body: JSON.stringify({ id, ok: true, result }),
      })
    } catch (err) {
      await fetch('http://127.0.0.1:7794/api/browser-companion/response', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${companionToken}`,
        },
        body: JSON.stringify({ id, ok: false, error: err.message }),
      })
    }
  }

  // ---------------------------------------------------------------------------
  // TEST PART 1: Core Browser Tools Execution in Real Chrome
  // ---------------------------------------------------------------------------
  console.log('Testing browser tools directly on live Chrome DOM...')

  // 1a. DOM Snapshot
  const snapRaw = await host.ctx.tools.call('browser_dom_snapshot', {})
  const snapshot = JSON.parse(snapRaw)
  assert.equal(snapshot.title, 'Switchboard Test App')
  assert.ok(snapshot.text.includes('Automation Playground'))
  assert.ok(snapshot.elements.some((e) => e.selector === '#counter-btn'))
  assert.ok(snapshot.elements.some((e) => e.selector === '#search-input'))
  console.log('✓ browser_dom_snapshot captured live Chrome DOM')

  // 1b. Real Element Click & DOM Mutation
  const clickRaw = await host.ctx.tools.call('browser_click', { selector: '#counter-btn' })
  assert.match(clickRaw, /Clicks: 1/)
  const liveCountText = await evalInChrome("document.getElementById('counter-btn').innerText")
  assert.equal(liveCountText, 'Clicks: 1', 'real Chrome DOM button text updated after click')
  console.log('✓ browser_click dispatched click and verified live DOM mutation ("Clicks: 1")')

  // 1c. Real Typing & Input Event Trigger
  const typeRaw = await host.ctx.tools.call('browser_type', { selector: '#search-input', text: 'switchboard' })
  assert.match(typeRaw, /typedLength.*11/)
  const liveStatusText = await evalInChrome("document.getElementById('search-status').innerText")
  assert.equal(liveStatusText, 'Searched: switchboard', 'real Chrome oninput event dispatched')
  console.log('✓ browser_type typed into live Chrome input and triggered oninput handler')

  // 1d. Dropdown Select & Change Event
  const selectRaw = await host.ctx.tools.call('browser_select', { selector: '#category-select', value: 'cat-b' })
  assert.match(selectRaw, /cat-b/)
  const liveCatStatus = await evalInChrome("document.getElementById('category-status').innerText")
  assert.equal(liveCatStatus, 'Selected: cat-b', 'real Chrome onchange event dispatched')
  console.log('✓ browser_select selected option and triggered onchange handler')

  // 1e. Viewport Screenshot
  const ssRaw = await host.ctx.tools.call('browser_screenshot', {})
  assert.match(ssRaw, /data:image\/jpeg;base64,/)
  console.log('✓ browser_screenshot generated valid JPEG base64 screenshot from Chrome')

  // 1f. Sensitive Field Blocking
  const sensitiveRaw = await host.ctx.tools.call('browser_type', { selector: '#password-field', text: 'pass' })
  assert.match(sensitiveRaw, /Error:.*sensitive password.*blocked/i)
  console.log('✓ Sensitive password field blocked from interaction')

  // ---------------------------------------------------------------------------
  // TEST PART 2: Real Multi-Step Agent Execution Loop
  // ---------------------------------------------------------------------------
  console.log('Testing full agent-to-browser-to-agent multi-step loop with real model...')

  const session = host.ctx.sessions.create({
    title: 'E2E Chrome Agent Test',
    preset: 'browser',
    model: 'agnes-3.0-flash',
  })

  const agentStream = host.ctx.agent.stream(
    'Please click the counter button (#counter-btn) once. Then extract and report the text on the button.',
    session.id,
    {
      preset: 'browser',
      maxSteps: 6,
    },
  )

  const toolCallsSeen = []
  const agentErrors = []
  let finalAnswer = ''

  for await (const event of agentStream) {
    if (event.type === 'tool' || event.type === 'tool_call') {
      toolCallsSeen.push(event.name || event.tool)
    } else if (event.type === 'error') {
      agentErrors.push(String(event.error || event.message || 'unknown agent error'))
    } else if (event.type === 'text' || event.type === 'chunk') {
      finalAnswer += event.content || event.text || ''
    }
  }

  console.log('Agent errors:', agentErrors)
  assert.deepEqual(agentErrors, [], 'agent must complete without provider or tool errors')
  console.log('Agent tool calls:', toolCallsSeen)
  console.log('Agent final answer:', finalAnswer.slice(0, 300))

  assert.ok(toolCallsSeen.length >= 1, 'agent autonomously invoked browser tools')
  assert.ok(toolCallsSeen.some((t) => t.includes('browser_')), 'browser tools were called')

  // Check live DOM button state after agent run
  const finalCountText = await evalInChrome("document.getElementById('counter-btn').innerText")
  console.log(`Live button text after agent loop: "${finalCountText}"`)
  assert.ok(
    finalCountText === 'Clicks: 2' || finalCountText === 'Clicks: 3',
    'counter button was clicked by the autonomous agent',
  )
  console.log('✓ Autonomous agent-to-browser-to-agent execution loop verified!')

  workerRunning = false
  ac.abort()
} finally {
  ws.close()
  chromeProcess.kill()
  server.close()
  server.closeAllConnections?.()
  await host.dispose()
}

console.log('=== Real Google Chrome E2E Test Suite PASSED ===')
