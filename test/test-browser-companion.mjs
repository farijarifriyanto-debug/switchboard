/**
 * Switchboard Browser Companion — Unit and Integration Tests
 *
 * Verifies:
 * - Registration and presence of all 13 browser automation tools
 * - Bridge pairing, token authentication, and state management
 * - Disconnected companion error messaging
 * - Full bi-directional command dispatch via loopback bridge
 * - Audit logging and session tracking
 *
 *   node test/test-browser-companion.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHost } from '../dist/index.js'

console.log('=== Running Browser Companion Bridge & Tools Integration Tests ===')

// 1. Tool registration & Disconnected Error
{
  const host = await createHost({
    sessions: { dir: '' },
    approval: { mode: 'off' },
  })
  try {
    const tools = host.ctx.tools.list().map((t) => t.name).filter((n) => n.startsWith('browser_'))
    assert.equal(tools.length, 13, 'all 13 browser tools are registered')

    const expectedTools = [
      'browser_tabs_list',
      'browser_tab_select',
      'browser_navigate',
      'browser_dom_snapshot',
      'browser_screenshot',
      'browser_click',
      'browser_type',
      'browser_scroll',
      'browser_select',
      'browser_wait',
      'browser_extract',
      'browser_console_logs',
      'browser_network_errors',
    ]

    for (const name of expectedTools) {
      assert.ok(tools.includes(name), `tool "${name}" is present in registry`)
    }

    // Call when disconnected should return clear, actionable error
    const res = await host.ctx.tools.call('browser_dom_snapshot', {})
    assert.match(
      res,
      /Switchboard Browser Companion extension is not connected/i,
      'disconnected tool call returns clear instructions to connect companion',
    )
    console.log('✓ 13 browser tools registered and disconnected guard verified')
  } finally {
    await host.dispose()
  }
}

// 2. Bridge Pairing, SSE Stream & Bi-directional Tool Execution
{
  const token = 'test-token-companion-1234'
  const host = await createHost({
    sessions: { dir: '' },
    approval: { mode: 'off' },
    browser: {
      port: 7789,
      token,
      timeoutMs: 5000,
    },
  })

  try {
    const service = host.ctx.browserCompanion
    assert.ok(service, 'BrowserCompanionService is available on host context')
    assert.equal(service.currentToken, token, 'configured token matches')

    // 2a. Pairing test
    const pairRes = await fetch('http://127.0.0.1:7789/api/browser-companion/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    assert.equal(pairRes.status, 200, 'pairing succeeds with valid token')
    const pairData = await pairRes.json()
    assert.equal(pairData.ok, true)
    assert.equal(pairData.token, token)
    assert.equal(pairData.mode, 'ask_every_time')
    console.log('✓ Pairing handshake succeeded')

    // 2b. SSE Stream Connection (simulate browser extension worker)
    const controller = new AbortController()
    const sseRes = await fetch('http://127.0.0.1:7789/api/browser-companion/events', {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    assert.equal(sseRes.status, 200, 'SSE stream opened')
    assert.equal(service.isClientConnected(), true, 'service detects connected companion')

    const reader = sseRes.body.getReader()
    const decoder = new TextDecoder()

    // 2c. Update status from companion
    const statusRes = await fetch('http://127.0.0.1:7789/api/browser-companion/status', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        activeTab: {
          id: 42,
          title: 'Test Page',
          url: 'http://127.0.0.1:8080/app',
          auditedOrigin: 'http://127.0.0.1:8080',
        },
        approvedOrigins: ['http://127.0.0.1:8080'],
        mode: 'auto_safe',
      }),
    })
    assert.equal(statusRes.status, 200)
    assert.equal(service.currentMode, 'auto_safe')
    assert.equal(service.getActiveTab()?.id, 42)
    console.log('✓ Status synchronization verified')

    // 2d. Bi-directional tool call test:
    // When agent calls `browser_click`, the command is streamed via SSE,
    // extension responds via `/api/browser-companion/response`,
    // and `ctx.tools.call` returns the structured result.
    const toolCallPromise = host.ctx.tools.call('browser_click', { selector: '#btn-submit' })

    // Extension reads from SSE stream to find command
    let commandData = null
    while (!commandData) {
      const { value, done } = await reader.read()
      if (done) break
      const text = decoder.decode(value)
      const lines = text.split('\n')
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const parsed = JSON.parse(line.slice(6))
          if (parsed.tool === 'browser_click') {
            commandData = parsed
            break
          }
        }
      }
    }

    assert.ok(commandData, 'command was broadcast to SSE stream')
    assert.equal(commandData.tool, 'browser_click')
    assert.equal(commandData.args.selector, '#btn-submit')

    // Extension posts result back to bridge
    const postRes = await fetch('http://127.0.0.1:7789/api/browser-companion/response', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        id: commandData.id,
        ok: true,
        result: { clicked: '#btn-submit', text: 'Submit Form' },
      }),
    })
    assert.equal(postRes.status, 200)

    const toolResult = await toolCallPromise
    assert.match(toolResult, /#btn-submit/)
    assert.match(toolResult, /Submit Form/)
    console.log('✓ End-to-end tool dispatch and response resolved successfully')

    // 2e. Audit log inspection
    const auditRes = await fetch('http://127.0.0.1:7789/api/browser-companion/audit', {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(auditRes.status, 200)
    const auditData = await auditRes.json()
    assert.ok(auditData.audit.length >= 1)
    assert.equal(auditData.audit[0].tool, 'browser_click')
    assert.equal(auditData.audit[0].status, 'success')
    console.log('✓ Action audit log verified')

    controller.abort()
  } finally {
    await host.dispose()
  }
}

console.log('=== All Browser Companion Bridge Tests PASSED ===')
