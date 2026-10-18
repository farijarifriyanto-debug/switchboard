# Switchboard Browser Companion — real side-panel acceptance and Claude in Chrome parity

Date: 14 October 2026. Scope: authorized Windows laptop `home` and GitHub only. No VPS, BotConnector production, store upload or billable AI use.

## Root cause and bounded implementation

In a real Chrome MV3 extension, the browser can omit the `Origin` header for a credentialed `GET /api/approvals`. The local Web API previously required a `chrome-extension://` Origin on every companion endpoint, causing **401 for the read-only approval list**. The background agent queued a valid approval, but the side panel could never display it. Consequently Auto tasks stalled.

`src/plugins/web.ts` now permits precisely this **Origin-absent GET to /api/approvals** if and only if the existing bearer matches the currently paired Browser Companion token; it does **not** permit Origin-absent approval POSTs, foreign Origins, or wrong tokens. No new permissions, grant layer or billing route is created. `test/test-browser-panel-chat-auth.mjs` verifies both the authorized case and negative cases.

## Headed Chrome + real local AI tests

The following scripts use Chrome for Testing (unpacked MV3 extension), an ephemeral profile and localhost-only fixture pages. Switchboard Web UI is bound to 127.0.0.1:7777 with a random bearer and isolated `settings.dir`. They use existing Ollama `botconnector-fast:latest`/Qwen3; AI content is not mocked.

| Test | Observation | Status |
| --- | --- | --- |
| `test/test-browser-panel-real-ai-skip-e2e.mjs` | User clicked Send in actual side panel. Real AI chose `browser_tabs_list`, `browser_tab_select`, `browser_click`, `browser_dom_snapshot`; panel showed `Completed.`; independently observed `Clicks: 1`. Other tab switch preserved bound agent tab. Browser bridge reconnected with existing token and did not repeat the click. 57s. | **PASS — Skip** |
| `test/test-browser-panel-real-ai-e2e.mjs` | Same workflow with Auto model-powered screening and native site access maintained. An uncertain snapshot approval appeared visibly in panel, was approved through its actual button, AI reached `Completed.`, final answer matched independent `Clicks: 1`, multitab and reconnect/no duplicate action passed. 93s. | **PASS — Auto** |
| `test/test-browser-panel-long-local-e2e.mjs` | Actual side-panel prompt and model made 7 browser calls: tab list, select, deliberate bad selector click (**failed as expected**), input `#name`, select `#city`, correct `#counter` click, final DOM snapshot. Three explicit panel approvals. Independent Chrome DOM: `name=Bico`, `city=Bandung`, `Clicks: 1`. Terminal `Completed.` with grounded answer; tab context and reconnect/no duplicate click passed. 211s. | **PASS — Auto long workflow with recovery** |
| `test/test-browser-panel-terminal-visible.mjs` | Real Chrome panel with simulated SSE exercises normal final, error, forged final after error, cancelled, step limit, truncated stream and Stop. | **PASS — UI contract with simulated provider** |
| `test/test-browser-site-deny-visible.mjs` | A second origin (`qa.internal`) mapped only to 127.0.0.1 prompts native site permission; selecting Deny in the visible panel rejects tool, grants no access and leaves page unchanged. | **PASS — native site Deny** |
| `test/test-browser-auto-local.mjs` | Independent direct agent Auto test confirms controlled approval, actual Chrome click, observed DOM and final answer. | **PASS — direct agent gate** |

Run locally on Windows after `npm ci` and `npm run build`, with a real local Ollama instance at `127.0.0.1:11666`:

```powershell
$env:SBX_TEST_CHROME_PATH='C:\path\to\Chrome-for-Testing\chrome.exe'
$env:SBX_LOCAL_BASE_URL='http://127.0.0.1:11666/v1'
$env:SBX_LOCAL_MODEL='botconnector-fast:latest'
npm run test:browser-panel-real-ai-auto
npm run test:browser-panel-real-ai-skip
npm run test:browser-panel-real-ai-long
npm run test:browser-panel-terminal-visible
npm run test:browser-site-deny-visible
```

These are manual acceptance tests. Do not run them in generic headless CI and label them equivalent to the owner's visible Chrome. No production credentials needed. One test uses the fixed loopback port 7777; do not run these tests concurrently or over an already running Switchboard instance.

> 2026-10-18 update: the panel no longer requires port 7777. The paired server advertises its
> real console origin and the side panel follows it
> (`docs/superpowers/plans/2026-10-18-panel-web-origin-discovery.md`); the real-model E2E now runs
> the unmodified extension against a dynamic console port. Tests that still configure their own
> web server on a fixed port keep the old "do not run concurrently" guidance until they migrate.

## Claude in Chrome behavioral comparison

Primary official references and previously reviewed 11 October 2026 notes are in `docs/claude-in-chrome-reference-20261011.md` and `docs/browser-parity-gate-20261011.md`:
- [Getting started](https://support.claude.com/id/articles/12012173-mulai-dengan-claude-di-chrome)
- [Permissions guide](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide)
- [Safety guide](https://support.claude.com/en/articles/12902428-use-claude-in-chrome-safely)
- [Troubleshooting](https://support.claude.com/id/articles/12902405-pemecahan-masalah-claude-di-chrome)

**No live current original Claude in Chrome application was controlled alongside Switchboard in this session**, so classifications are comparisons to *documented behavior*, not a claim about undocumented proprietary internals or full visual identity.

| Feature | Documented reference | Real Switchboard behavior | Classification |
| --- | --- | --- | --- |
| Chat-first workflow | Visible side panel starts tasks, displays tool activity, result and Stop | Real Send → AI/Qwen3 → Chrome actions → streamed final; verified DOM | **ADAPTASI SETARA** for tested workflows |
| Native site consent | Chrome-granted access is prerequisite, no duplicate custom site gate | Visible Chrome Deny case works; existing native permission contracts pass | **ADAPTASI SETARA** for Deny; once/persistent grant+revoke on new HTTPS origin still unverified |
| Action consent Manual / Auto / Skip | Auto screens content/actions; uncertain actions request consent; Manual explicitly asks | Auto actual panel displayed and settled action approvals; Skip remains an owner-approved **DIFF** for protected actions | **ADAPTASI SETARA** Auto tested; **DIFF DISETUJUI** for Skip limits |
| Multitab target | Agent task target persists across user tab changes | 2 local tabs, correct tab explicitly selected by AI, bound target persists after user tab change | **ADAPTASI SETARA** on tested fixture |
| Reconnect and retry | Losing connection must not replay unsafe actions | Real bridge reconnection with persistent pairing; counter unchanged | **ADAPTASI SETARA** for tested bridge scenario |
| Long autonomous task | Multiple actions, failure recovery, observable completion | 7 real browser tool calls incl. deliberate failure, safe correction, form and independent verification | **ADAPTASI SETARA** for tested fixture |
| Stop/error presentation | Stop interrupts task, failure clearly distinguished from Completed | Real panel Stop during a live local Ollama session: backend session becomes cancelled, composer is re-enabled, fixture DOM unchanged. Simulated SSE error/step-limit contracts also PASS. | **ADAPTASI SETARA** for tested Stop and error flows |
| Screenshots + vision | Visual screenshot tasks using a capable model | Screenshot CDP contract tested, but no complete side-panel vision model run | **BELUM TERVERIFIKASI** |
| Native HTTPS allow-once and revoke | Time-scoped/permanent Chrome host grants with correct button/UX | Deny tested real; grant-once and revoke verified in contracts only | **BELUM TERVERIFIKASI** for real HTTPS |
| Direct head-to-head original Claude in Chrome | Compare actual installed app UX/workflows | Original app was not part of this instrumented laptop test | **BELUM TERVERIFIKASI** |

## Additional real UI evidence and remaining native-host test gap

\`test/test-browser-panel-stop-real-ai-e2e.mjs\` was executed in visible Chrome with a real local model. The panel started an authenticated agent session, the Stop control aborted it, the backend session status became \`cancelled\`, and independent Chrome DOM remained \`Clicks: 0\`. **PASS for live Stop.**

\`test/test-browser-site-once-visible.mjs\` is a **QA diagnostic only**, not a release gate PASS: a trusted CDP click triggered native Chrome's Allow once prompt, but permission was not consistently settled in the browser and a pending action did not reliably complete. This test did *not* programmatically force \`chrome.permissions\` grants. Deny remains independently PASS. A proper user-confirmed native consent test is still required.

## Release gate

**GO for the tested local browser-agent workflows, including Auto, explicit approval, recovery, multitab binding and reconnect.** This is not blanket GO for full feature parity or a Chrome Web Store release. An update to the public extension still needs independent real-site HTTPS allow-once/revoke, end-to-end vision (or explicit unsupported UI), and direct original-app behavior comparison where available. No site permission was silently granted, no production deployment performed.

## Installed original-app metadata cross-check (read-only)

On the owner's Windows Chrome **Default** profile, a locally installed extension manifest was identified as **Claude 1.0.100**, MV3, extension ID \`fcoeoabgfenejglbffodgkkbkcdhcgfn\`. Candidate Switchboard Browser Companion reports **0.4.3**, MV3. Both declare core browser automation permissions including \`sidePanel\`, \`debugger\`, \`tabs\` and \`tabGroups\`. Claude also declares \`webNavigation\`, \`declarativeNetRequestWithHostAccess\`, \`offscreen\`, \`unlimitedStorage\` and \`identity\`; Switchboard does not. These are **metadata differences**, not proof of missing user-visible behavior, and should **not** be copied blindly. Claude's own manifest has no static \`side_panel\` field despite declaring the permission, so absence of that field must not be misrepresented as absence of side-panel support.

This inspection did **not** access Claude account data, conversation history, or operate the original Claude side panel. Consequently a direct, current UI-to-UI parity claim is **BELUM TERVERIFIKASI**. It remains a release gate separate from Switchboard's demonstrated QA workflows.


## Focused gap retest — 14 October 2026, later QA

**Screenshot → model vision → verified result (PASS for the component chain):** In an isolated headed Chrome for Testing browser with the actual unpacked Switchboard extension, the authorized \`browser_screenshot\` tool returned a genuine JPEG (~53.5 KB). A QA canvas drew **SATURN 42** and a **blue** rectangle; \`document.body.innerText\` was empty. The screenshot's JPEG bytes went to the existing, vision-capable \`gemma4:cloud\` model through the Ollama account already connected on the laptop. Its answer was exactly **"SATURN 42, blue."** The test exited 0; script: \`test/test-browser-screenshot-vision-real.mjs\`. This uses **Cloud inference**, not offline/local-only inference, and service usage rules/quota may apply. It is deliberately **opt-in** using \`SBX_ALLOW_CLOUD_VISION_TEST=1\` to prevent unrequested calls. No user content/screenshots were used or uploaded; only a synthetic fixture.

**Boundary:** This proves real Chrome screenshot → actual vision model → correct result, **not yet a single automatic vision step inside the side-panel agent chat**. The existing browser screenshot tool returns a JPEG data URL while the current agent tool history is text-based; this has not been reworked to transmit a tool-result image as a multimodal model input automatically. Do **not** mark full Claude visual intelligence parity.

**Allow once (partial fix, NOT a real native UI PASS):** When the read-only \`browser_dom_snapshot\` tool has already read, safety-screened and bound a DOM snapshot, a second, hidden DOM injection from revalidation used to consume a new native one-action grant while the *same* tool had not finished. For this **read-only tool only**, Switchboard now uses the already screened snapshot and rechecks the tab ID/origin via \`browser_tabs_list\` (no DOM access). Mutating browser actions retain the original full content/hash revalidation; Chrome native host consent remains the sole authority. \`test/test-browser-once-snapshot-contract.mjs\` demonstrates exactly **one** consented DOM read plus tab identity check and passes together with native-permission security contracts. Actual native Chrome one-action **Allow once** tests in isolated Chrome remain inconsistent because \`chrome.permissions.request\` needs a genuine browser-level user gesture/consent prompt; do not inject a fake host grant or claim a final PASS until a real approved action, automatic revoke, and second-action reprompt are witnessed together.

**Installed original Claude in Chrome UI (limited real-app inspection):** Owner laptop has Claude for Chrome **1.0.100** installed. We started its actual installed extension package in a completely separate, fresh Chrome for Testing profile, *without copying owner profile cookies or credentials*. Chromium loaded the original extension, and opening its \`sidepanel.html\` showed title \`Claude for Chrome\`, but the unsigned-in isolated profile rendered no interactive chat controls and initiated the \`claude.ai\` OAuth login flow. We did not login, inspect the owner's conversation history, or take over their existing Chrome profile. As a result direct current **authenticated Claude UI feature parity remains BELUM TERVERIFIKASI**; the manifest and official documented behavior comparison remains an evidence-based *reference*, not an equivalent live session. Do not copy extra Claude permissions or proprietary UI code just to mimic package metadata.
