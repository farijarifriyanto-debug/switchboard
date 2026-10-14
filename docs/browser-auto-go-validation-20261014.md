# Browser Companion — Windows real-Chrome acceptance evidence (14 October 2026)

**Scope:** only the owner's Windows laptop and GitHub. No VPS access, BotConnector production deployment, Chrome Web Store submission, provider purchase, model download, or new site-permission layer.

**Reference:** docs/claude-in-chrome-reference-20261011.md and AGENTS.md. Claude in Chrome's behavior is the authoritative UX baseline; these tests do not claim to inspect Claude's proprietary implementation.

## Verified real-browser evidence

| Requirement | Evidence | Gate |
| --- | --- | --- |
| Local AI → browser → observed final answer, Auto | test/test-browser-auto-local.mjs, visible Chrome for Testing with real MV3 extension and local Ollama botconnector-fast (Qwen3). browser_click #counter, browser_dom_snapshot, final stopReason=answer and independently read Chrome CDP button text/dataset 'Clicks: 1'. | **GO for this bounded scenario** |
| Auto uncertain action approval | Safety evaluator requested approval for read-only browser_dom_snapshot. Test operator granted once only to the matching localhost test session; no blanket permission, no bypass and no production changes. | **GO for explicit approval path** |
| Native Chrome site deny | test/test-browser-site-deny-visible.mjs. qa.internal is mapped in isolated Chrome to 127.0.0.1 only. No host grant; pending site request appears in real panel. Deny prevents reading, grants nothing and leaves page unchanged. | **GO for deny/fail-closed** |
| Stream UI and Stop | test/test-browser-panel-terminal-visible.mjs, real Chrome extension page, simulated SSE. Success, missing final, error, error+fake-final, cancelled, step limit and Stop all checked. | **GO for UI terminal-state handling (fixture)** |
| Chrome browser security/regressions | Existing test-browser-native-permission, test-browser-cdp, test-browser-action-fail-closed, test-browser-security, test-browser-regression, test-browser-safety, browser-companion, browser-panel-chat-stream and browser-approval-ui tests. | **GO for contract suite** |
| Full Claude in Chrome parity across websites | Direct original-app comparison, site allow-once/revoke on a new HTTPS origin, screenshots with real vision AI, >=5 independent agent steps with recovery and every Stop/reconnect case have not been reproduced together in visible Chrome. | **BELUM TERVERIFIKASI — not approved for a general Web Store release** |

## Reproduce only on laptop

Requirements: npm ci, npm run build, Chrome for Testing supporting unpacked MV3 extensions, and locally running Ollama at 127.0.0.1:11666 with botconnector-fast:latest. The fixture uses only loopback/local DNS override and an ephemeral Chrome profile.

PowerShell example commands:

- $env:SBX_TEST_CHROME_PATH='C:\\path\\to\\Chrome-for-Testing\\chrome.exe'
- $env:SBX_LOCAL_BASE_URL='http://127.0.0.1:11666/v1'
- $env:SBX_LOCAL_MODEL='botconnector-fast:latest'
- node test/test-browser-auto-local.mjs
- node test/test-browser-panel-terminal-visible.mjs
- node test/test-browser-site-deny-visible.mjs

The Auto integration test may take over a minute on the CPU. It requires exactly one agent final event, a real observed DOM change, and an answer consistent with Chrome's DOM. A rejected or unexpected approval fails the test. Only a benign local QA action is approved by the harness. The UI tests are real Chrome rendering tests with mocked stream content; they are NOT evidence of a provider response.

## Implementation changes

Only browser-extension/panel.js was changed in runtime code: Stop aborts immediately before its backend cancel request; errors and truncated streams cannot falsely remain Completed; step-limit and cancelled are truthful terminal states. A fatal error cannot be overwritten by a subsequent fake final event. Chrome's native host permissions and the existing action-mode policy are unchanged.

## Explicit release distinction

GO for bounded Windows/browser evidence does not equal blanket GO for full Claude in Chrome parity or Chrome Web Store deployment. Further cross-site/native-grant and screenshot/vision acceptance still requires real testing. Leave production and Web Store untouched until separate approval and all relevant release gates pass.
