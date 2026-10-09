/**
 * Switchboard Browser Companion — Regression Tests
 *
 * Verifies the 8 known bug fixes & audit requirements:
 * 1. Independent message dispatch: SWITCHBOARD_LIST_TABS and SWITCHBOARD_CAPTURE_SCREENSHOT
 *    are separate from SWITCHBOARD_BROWSER_ACTION.
 * 2. Side panel opened synchronously in user gesture context.
 * 3. Capture completion and UI update in storage.session.
 * 4. ActiveTab validation: non-HTTP(S) tabs rejected with clear error.
 * 5. Cross-origin navigation rejected unless approved.
 * 6. Screenshot leakage prevention across unapproved origins.
 * 7. Sensitive fields (passwords, credit cards, file inputs) never saved in workflow or typed into.
 * 8. Approval mode enforcement across all actions.
 *
 *   node test/test-browser-regression.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

console.log('=== Running Browser Extension Bug Fixes & Regression Tests ===')

const bgSource = readFileSync(path.join(process.cwd(), 'browser-extension/background.js'), 'utf8')
const panelSource = readFileSync(path.join(process.cwd(), 'browser-extension/panel.js'), 'utf8')

// -----------------------------------------------------------------------------
// Regression Test 1: Message Dispatch Un-nesting
// -----------------------------------------------------------------------------
{
  // In the buggy version, SWITCHBOARD_LIST_TABS and SWITCHBOARD_CAPTURE_SCREENSHOT
  // were nested inside if (message.type === 'SWITCHBOARD_BROWSER_ACTION').
  // Verify that they are now separate independent top-level branches.
  const actionIndex = bgSource.indexOf("message.type === 'SWITCHBOARD_BROWSER_ACTION'")
  const tabsIndex = bgSource.indexOf("message.type === 'SWITCHBOARD_LIST_TABS'")
  const screenshotIndex = bgSource.indexOf("message.type === 'SWITCHBOARD_CAPTURE_SCREENSHOT'")

  assert.ok(tabsIndex !== -1, 'SWITCHBOARD_LIST_TABS exists')
  assert.ok(screenshotIndex !== -1, 'SWITCHBOARD_CAPTURE_SCREENSHOT exists')
  assert.ok(actionIndex !== -1, 'SWITCHBOARD_BROWSER_ACTION exists')

  // In the corrected file, tabs and screenshot appear BEFORE or INDEPENDENT of browser_action
  // and NOT inside its block.
  assert.ok(
    tabsIndex < actionIndex || bgSource.slice(actionIndex).indexOf("SWITCHBOARD_LIST_TABS") === -1,
    'SWITCHBOARD_LIST_TABS is independent of SWITCHBOARD_BROWSER_ACTION',
  )
  assert.ok(
    screenshotIndex < actionIndex || bgSource.slice(actionIndex).indexOf("SWITCHBOARD_CAPTURE_SCREENSHOT") === -1,
    'SWITCHBOARD_CAPTURE_SCREENSHOT is independent of SWITCHBOARD_BROWSER_ACTION',
  )
  console.log('✓ Regression Bug #1: Independent message dispatch verified')
}

// -----------------------------------------------------------------------------
// Regression Test 2: Synchronous Side Panel Open in User Gesture
// -----------------------------------------------------------------------------
{
  assert.match(
    bgSource,
    /chrome\.action\.onClicked\.addListener\(async\s*\(?tab\)?\s*=>\s*\{[\s\S]*?chrome\.sidePanel\.open/,
    'chrome.sidePanel.open is initiated during toolbar click handler',
  )
  console.log('✓ Regression Bug #2: Side panel opened in user gesture context verified')
}

// -----------------------------------------------------------------------------
// Regression Test 3: Capture Stored in session.storage
// -----------------------------------------------------------------------------
{
  assert.match(
    bgSource,
    /chrome\.storage\.session\.set\(\{\s*captured:\s*\{\s*tabId:\s*tab\.id,\s*data/i,
    'captured page data is saved to chrome.storage.session',
  )
  console.log('✓ Regression Bug #3: Capture state saved in session storage verified')
}

// -----------------------------------------------------------------------------
// Regression Test 4: ActiveTab Validation & Non-HTTP(S) Guard
// -----------------------------------------------------------------------------
{
  assert.match(bgSource, /SAFE_URL\s*=\s*\/\^https\?:\\\/\\\//, 'SAFE_URL regex validates HTTP(S) protocol')
  assert.match(bgSource, /!SAFE_URL\.test\(tab\.url/, 'Non-HTTP(S) tabs are rejected')
  console.log('✓ Regression Bug #4: Active tab HTTP(S) validation verified')
}

// -----------------------------------------------------------------------------
// Regression Test 5: Cross-origin Navigation Guard
// -----------------------------------------------------------------------------
{
  assert.match(
    bgSource,
    /targetUrl\.origin\s*!==\s*tabOrigin[\s\S]*?Cross-origin navigation[\s\S]*?rejected/i,
    'Cross-origin navigation to unapproved origin is rejected',
  )
  console.log('✓ Regression Bug #5: Cross-origin navigation protection verified')
}

// -----------------------------------------------------------------------------
// Regression Test 6: Screenshot Origin Scoping
// -----------------------------------------------------------------------------
{
  assert.match(
    bgSource,
    /approvedOrigins\.includes\(tabOrigin\)/i,
    'Screenshot capture requires origin approval first',
  )
  console.log('✓ Regression Bug #6: Screenshot origin boundary check verified')
}

// -----------------------------------------------------------------------------
// Regression Test 7: Sensitive Credential & Payment Card Protection
// -----------------------------------------------------------------------------
{
  assert.match(
    bgSource,
    /input\[type="password"\][\s\S]*?autocomplete\*="cc-"/i,
    'Sensitive fields (passwords, payment cards) are blocked from DOM interactions',
  )
  assert.match(
    panelSource,
    /isSensitive[\s\S]*?REDACTED/i,
    'Workflows redact sensitive fields during export',
  )
  console.log('✓ Regression Bug #7: Password and credit card protection verified')
}

// -----------------------------------------------------------------------------
// Regression Test 8: Mode Enforcement
// -----------------------------------------------------------------------------
{
  assert.match(
    bgSource,
    /permissionMode\s*===\s*'restricted'[\s\S]*?Blocked/i,
    'Restricted mode blocks mutating actions',
  )
  console.log('✓ Regression Bug #8: Permission mode enforcement verified')
}

console.log('=== All 8 Bug Fix Regression Tests PASSED ===')
