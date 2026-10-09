# Switchboard Browser Agent (Google Chrome & Microsoft Edge)

Official **Manifest V3** browser extension for Switchboard / BotConnector. Provides deep, secure browser automation and autonomous AI companion capabilities for both **Google Chrome** and **Microsoft Edge** with a unified codebase.

---

## Architecture Overview

```
┌────────────────────────────────┐         Authenticated HTTP/SSE         ┌───────────────────────────────┐
│     Google Chrome / Edge       │  ◄──────────────────────────────────►  │    Switchboard Agent Core     │
│  ┌──────────────────────────┐  │        Loopback Bridge (127.0.0.1)      │  ┌─────────────────────────┐  │
│  │   Side Panel Chat UI     │  │                                        │  │ Cordis Agent Harness    │  │
│  │   - AI Streaming         │  │         X-Switchboard-Token            │  │ - Multi-step Agent Loop │  │
│  │   - Model Selector       │  │         DNS Rebinding Protection       │  │ - 13 Browser Tools      │  │
│  │   - Workflow Engine      │  │                                        │  │ - Approval Pipeline     │  │
│  │   - Security & Audit     │  │                                        │  │ - Scheduler Integration │  │
│  └──────────────────────────┘  │                                        └─────────────────────────┘  │
│  ┌──────────────────────────┐  │                                                                     │
│  │   MV3 Background Worker  │  │                                                                     │
│  │   - DOM Compact Ref Tree │  │                                                                     │
│  │   - Credential Shield    │  │                                                                     │
│  │   - Action Verification  │  │                                                                     │
│  └──────────────────────────┘  │                                                                     │
└────────────────────────────────┘                                                                     │
```

---

## Core Capabilities (P0 – P3)

### P0 — Browser Agent Core
- **Side Panel Chat:** Responsive chat interface supporting real-time SSE streaming from Switchboard, model selection, session persistence, and controls (Stop, Retry, Continue).
- **Active Tab Tracking:** Displays current tab title, URL, and origin status with live synchronization.
- **13 Standard Browser Tools:**
  1. `browser_tabs_list`: Query accessible browser tabs.
  2. `browser_tab_select`: Switch active tab by `tabId`.
  3. `browser_navigate`: Safe navigation within approved origins.
  4. `browser_dom_snapshot`: Compact accessibility DOM tree with stable `@ref` references and state hashing.
  5. `browser_screenshot`: Viewport JPEG capture with quality/format options.
  6. `browser_click`: Click element by `@ref`, CSS selector, or XPath with verification.
  7. `browser_type`: Type text or fill input with real `input` and `change` dispatch.
  8. `browser_scroll`: Scroll element or viewport (`top`, `bottom`, `up`, `down`).
  9. `browser_select`: Pick dropdown options by value or text.
  10. `browser_wait`: Wait for DOM selectors, text content, or milliseconds.
  11. `browser_extract`: Extract text or attributes from target elements.
  12. `browser_console_logs`: Capture recent page console warnings/errors.
  13. `browser_network_errors`: Inspect recent failed network requests.
- **Agent Loop Integration:** Autonomous multi-step plan -> tool call -> permission verification -> execution -> observation -> verification -> next step -> answer.

### P1 — Security & Approvals
- **Authenticated Loopback Bridge:** Secure communication guarded by `X-Switchboard-Token` Bearer tokens and DNS-rebinding prevention (`Host` header validation against loopback addresses).
- **Three Permission Modes:**
  1. `Ask Every Time`: Every write/navigation action prompts user confirmation.
  2. `Auto Safe`: Read-only and non-destructive actions proceed automatically on allowed sites; sensitive actions prompt.
  3. `Restricted`: Strict read-only mode (clicks, types, and navigation mutations are blocked).
- **Origin-Level Permissions:** Explicit site origin allowlisting and one-click revocation.
- **Credential & Sensitive Field Shield:** Automatic refusal to interact with password fields (`type="password"`), credit card / CVV inputs, social security number inputs, or file uploads.
- **Prompt Injection Demarcation:** DOM text and extracted content are encapsulated in clear `[UNTRUSTED WEBPAGE CONTENT START ... END]` guardrails.
- **Audit Logging:** Every browser action is recorded locally with timestamp, origin, tool name, parameters, result status, and approval decision.

### P2 — Advanced Browser Automation
- **Multi-Tab Management:** List and switch between open tabs safely.
- **Workflow Recording:** Record user interactions (clicks, types, scrolls, navigations) directly in the side panel. Typed text in sensitive fields is automatically redacted.
- **Workflow Replay Engine:** Re-run recorded workflows sequentially with element validation, retries, configurable timeouts, stop/cancel support, and step-by-step reporting.
- **Automations Scheduler Integration:** Sync and schedule recurring browser workflows directly with Switchboard's built-in cron scheduler.
- **Token Optimization:** Compact DOM snapshots (~70-85% token reduction vs raw HTML), DOM state hashing to avoid redundant re-fetches, and diff-based inspection.

### P3 — Chrome & Edge Release Readiness
- **Unified Manifest V3 Codebase:** Single extension directory works out-of-the-box on both Google Chrome and Microsoft Edge.
- **Minimal Permissions:** Uses only `activeTab`, `scripting`, `sidePanel`, `storage`, and `tabs`. Zero broad `host_permissions` required.
- **Reproducible Packaging:** `scripts/package-extension.mjs` generates compliant `switchboard-chrome.zip` and `switchboard-edge.zip` with verified SHA256 checksums.

---

## Installation & Usage

### 1. Start Switchboard
Run Switchboard with the Browser Companion plugin enabled:
```bash
# Start Switchboard
node dist/cli.js
```
The browser companion bridge automatically starts at `http://127.0.0.1:41888/` (or via the main Switchboard HTTP port) with an active authorization token stored in `.switchboard/browser-companion.json`.

### 2. Load Extension in Google Chrome
1. Navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `browser-extension/` directory.
4. Pin the **Switchboard Browser Agent** icon to your toolbar.

### 3. Load Extension in Microsoft Edge
1. Navigate to `edge://extensions/`
2. Enable **Developer mode** (left sidebar).
3. Click **Load unpacked** and select the `browser-extension/` directory.

### 4. Connect & Operate
1. Open any HTTP/HTTPS web page.
2. Click the extension toolbar icon to open the **Side Panel**.
3. Under the **Settings** tab, verify the bridge URL (`http://127.0.0.1:41888`) and paste the Bridge Token from `.switchboard/browser-companion.json`.
4. Switch to the **Chat** tab to instruct the agent, or the **Workflows** tab to record and replay automations.

---

## Verification & Test Suite

Run the automated verification suite:

```bash
# Unit & integration tests for all 13 tools
node test/test-browser-companion.mjs

# P1 Security & negative acceptance tests
node test/test-browser-security.mjs

# P2 Workflow recording, replay, retry, and scheduling tests
node test/test-browser-workflow.mjs

# Regression tests for all known bugs
node test/test-browser-regression.mjs

# Real Google Chrome E2E test with live CDP and real AI loop
node test/test-browser-e2e-chrome.mjs

# Package Chrome and Edge ZIP archives
node scripts/package-extension.mjs
```

---

## Troubleshooting

- **Side Panel does not open:** Ensure you click the extension toolbar icon on an active HTTP/HTTPS tab (Chrome and Edge do not allow side panels on `chrome://` or `edge://` internal URLs).
- **Bridge Connection Error:** Verify Switchboard is running and check `.switchboard/browser-companion.json` for the valid auth token.
- **Action Denied (Restricted):** Check the **Security & Audit** tab in the side panel. If the site is in `Restricted` mode or unapproved, approve the site or switch to `Auto Safe`.
- **Password field rejected:** This is an intentional security guard. Sensitive authentication fields cannot be automated by the agent.
