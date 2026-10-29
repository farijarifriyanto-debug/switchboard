# Release status — single source of truth

Last verified: **29 October 2026**. Update this file with the evidence date whenever a release status changes.
Historical QA and release notes remain useful as evidence but do not override this table.

| Delivery | Version | Status | Evidence / note |
|---|---|---|---|
| npm `@botconnector/switchboard` | **0.4.7** | Published; `latest` | `registry.npmjs.org` read 2026-10-29: version and dist-tag `latest` both `0.4.7`, shasum `9d193c271cf7efda555bede6239d16fa93bfcb87`; GitHub Actions signed provenance logIndex `3568973732` |
| Source / working tree | **0.4.7** | Published in GitHub | PR #51 merged into `master` (`5a9ceca2367e34c9032bdf0decc99a7148e230e6`), tagged `v0.4.7` on 2026-10-29; Browser Companion and Switchboard core aligned to version 0.4.7 |
| Chrome Web Store Browser Companion | **0.4.6** | Published (existing item); **0.4.7 submitted per owner, publication unverified** | Existing item `miehnbiiokkciokmepnhgmlhjpabbkna`; published version 0.4.6 last verified 2026-10-25. Owner confirmed on 2026-10-29 that the 0.4.7 update was submitted to Chrome Web Store; dashboard submission receipt, Google review outcome, and listing version 0.4.7 have not been independently verified. 0.4.7 ZIP SHA-256 `ff7bbc6cac7869ee046f891afee284a5c24ce3e98d19f29a461e3913f2aee475`; do not claim 0.4.7 live until store publication is confirmed |
| Microsoft Edge Add-ons | **unknown** | Unverified | No verified listing/version evidence; do not invent a store URL |
| GitHub Release | **v0.4.7** | Published | `https://github.com/farijarifriyanto-debug/switchboard/releases/tag/v0.4.7` published 2026-10-29; npm tarball, Windows x64 bundle, Chrome/Edge ZIPs, and SHA-256 checksums; workflow `40888992753` succeeded |

## What 0.4.5 contains

Version 0.4.5 hardens local trust boundaries:

- Local CI is disabled by default, requires a per-project trust decision, passes only a base
  environment plus `ci.envAllowlist`, and runs steps in the configured sandbox.
- The browser companion token is non-empty, browser-scoped, cannot start shell-capable chats or
  settle non-browser approvals, and cannot change action mode through extension status updates.
- Browser selectors must exist in the current snapshot; screenshots and downloads always require
  approval; pairing uses mutual HMAC challenge-response and AES-GCM token delivery.
- The side panel learns the local console origin from the paired server (`webOrigin` in the
  pairing/status/`connected` payloads), so `sbx web --port <n>` keeps the panel's Ask, approvals
  and Stop working without a hardcoded 7777. Loopback `http:` origins only; older servers keep
  the visible fallback.
- `withDebugger` enables CDP focus emulation (`Emulation.setFocusEmulationEnabled`) before
  dispatching trusted mouse/key events, preventing silent no-op clicks or key presses when the
  bound agent tab is in the background or the browser window is unfocused/occluded on Windows.
- Trace session keys reject path traversal.
- Unattended automations refuse shell/credential-capable presets unless `allowUnattended: true`.
- Documentation and manifest versions are checked by `scripts/test-docs-consistency.mjs`.

## Verification evidence (18 October 2026)

- `npm run typecheck`, `npm run build` and `npm test` pass on Windows.
- Real Chrome for Testing `155.0.8059.79`, unpacked extension from this source, simulated provider:
  `test/test-browser-panel-terminal-visible.mjs` **PASS** (pairing, authenticated WebSocket,
  panel success/error/cancel/stop/step-limit, no false final).
- Real Chrome for Testing `155.0.8059.79` plus local model `botconnector-fast:latest` (Ollama
  `127.0.0.1:11666`), unpacked extension **unmodified from this source**, real click and independent
  DOM read: `test/test-browser-panel-real-ai-e2e.mjs` **PASS** — the extension discovered the
  console origin `http://127.0.0.1:60410` advertised by the paired bridge (while a live `sbx web`
  still owned 7777), panel chat reached that dynamic port, `Completed.`, visible approvals,
  actual `Clicks: 1`, agent-tab context preserved, reconnect without duplicate action.
  Supporting tests on the same run: `test-browser-panel-chat-auth.mjs` (pair response and WS
  `connected` frame advertise the live console origin), `test-browser-background-ws.mjs` (no
  console running → no `webOrigin`), `test-browser-native-pair.mjs` (extension stores a validated
  loopback origin and ignores `https://evil.example`).
- Real Chrome for Testing `155.0.8059.79` plus local model `botconnector-fast:latest`, migrated
  dynamic-port tests (2026-10-18): `test-browser-panel-real-ai-skip-e2e.mjs`,
  `test-browser-panel-stop-real-ai-e2e.mjs`, `test-browser-panel-long-local-e2e.mjs` (five
  operator approvals resolved from `@eN` element refs via the latest `dom_snapshot`; real DOM
  `Clicks: 1`, name `Bico`, city `Bandung`) and `test-browser-claude-parity-readonly.mjs`
  **PASS** on ephemeral web ports instead of a pinned 7777;
  `test-browser-panel-vision-real.mjs` **PASS end-to-end** (2026-10-18) on a dynamic port: real Chrome
  for Testing `155.0.8059.79` plus the free BotConnector-gateway vision model `agnes-3.0-flash`
  (`https://api.botconnector.id/v1`, key via `SBX_LOCAL_API_KEY`). The agent listed tabs, selected the
  test tab, requested `browser_screenshot` (operator-approved, `approvals: 1`), read the canvas from
  pixels (`PANEL_VISION_CANVAS_DOM_EMPTY`), and answered `SATURN 42` + `blue`
  (`PASS_REAL_SIDE_PANEL_AUTO_SCREENSHOT_VISION_ANSWER`, exit 0); the screenshot was forwarded as an
  ephemeral untrusted image with no `data:image/` leak into the session transcript. The Ollama cloud
  default `gemma4:cloud` was unusable (HTTP 429, Ollama Pro weekly limit) and the only local
  vision+tools model `qwen3-vl:4b` is thinking-only (Ollama ignores `think:false`; its reasoning
  exhausts the browser agent's token budget before emitting `browser_screenshot`), so verification used
  the gateway model instead. This run also empirically confirms the allowlist fix: `ac64823` made
  `browser_screenshot` require explicit approval in every mode (`autoConfirmActions` → `require_approval`,
  `browser-companion.ts:829,977,1084`), but the test's approval allowlist omitted it and would reject a
  legitimate screenshot approval as "Unexpected approval"; the allowlist now includes `browser_screenshot`.
- Real Microsoft Edge `155.0.4283.45` (`msedge.exe`), unpacked extension from this source (2026-10-18):
  after enabling `Emulation.setFocusEmulationEnabled` in `withDebugger` (`browser-extension/background.js`,
  locked by `test-browser-cdp.mjs`), all six real-browser E2E suites **PASS** in Edge on dynamic ports:
  `test-browser-claude-parity-readonly.mjs` (`PASS_SWITCHBOARD_ORIGINAL_CLAUDE_SAME_READONLY_FIXTURE`,
  `h1: "QA-BICO-731", button: "Ready"`), `test-browser-panel-real-ai-skip-e2e.mjs`
  (`PASS_FULL_PANEL_REAL_AI_SKIP_BROWSER_FINAL_E2E`, `REAL_CHROME_DOM {"label":"Clicks: 1","n":"1"}`,
  multi-tab bound context + reconnect without duplicate action),
  `test-browser-panel-stop-real-ai-e2e.mjs` (`PASS_REAL_PANEL_STOP_BACKEND_CANCEL_NO_BROWSER_WRITE`),
  `test-browser-panel-long-local-e2e.mjs` (`PASS_LONG_REAL_AI_AUTO_PANEL_SIX_TOOLS_RECOVERY`, five
  operator approvals resolved from `@eN` refs, `REAL_CHROME_DOM {"label":"Clicks: 1","n":"1","name":"Bico","city":"Bandung"}`),
  `test-browser-panel-vision-real.mjs` (`PASS_REAL_SIDE_PANEL_AUTO_SCREENSHOT_VISION_ANSWER` with
  `agnes-3.0-flash`, `SATURN 42` + `blue`, `approvals: 1`), and `test-browser-site-deny-visible.mjs`
  (`PASS_REAL_CHROME_DENY_FAIL_CLOSED_NO_GRANT_NO_MUTATION`).
- Real native site-grant prompt (`chrome.permissions.request`) for both HTTP (`http://qa.internal:<port>`)
  and real HTTPS (`https://botconnector.id`) in both Chrome for Testing `155.0.8059.79` and Microsoft
  Edge `155.0.4283.45` (2026-10-18): `test-browser-site-once-visible.mjs` **PASS** across all four
  runs (Chrome HTTP, Edge HTTP, Chrome HTTPS, Edge HTTPS) — verified `PASS_REAL_CHROME_HOST_PERMISSION_ABSENT`,
  `PASS_REAL_CHROME_SITE_PERMISSION_REQUIRED`, clicking `#site-request-once` in the side panel,
  accepting the native browser permission dialog (`Allow` / `Izinkan`) via Windows UI Automation
  (`InvokePattern`), `PASS_VISIBLE_CHROME_NATIVE_ALLOW_ONCE_RESUMES_TOOL`,
  `PASS_VISIBLE_CHROME_NATIVE_ONE_TIME_GRANT_REVOKED`, and
  `PASS_NATIVE_ALLOW_ONCE_THEN_REQUIRE_PERMISSION_AND_DENY`.
- Not verified: a Chrome Web Store-installed 0.4.5 update (store remains 0.4.4 until submitted), a
  Microsoft Edge Add-ons store listing, and manual side-by-side comparison of every historical Claude
  in Chrome scenario on the owner's daily profile.

## Verification evidence (25 October 2026, `master` after PRs #35–#38)

Verified on Windows, Node 24. `npm run build`, `npm run typecheck`, `npm test` and
`test:docs` pass on the merged tree. Real browsers, unpacked extension built from this source,
models through `https://api.botconnector.id/v1`:

| Browser | Model | Suite | Result |
|---|---|---|---|
| Chrome for Testing `155.0.8059.79` | `gpt-oss-120b` | `test-browser-claude-parity-readonly.mjs` | **PASS** — `QA-BICO-731`, button `Ready` |
| Chrome for Testing `155.0.8059.79` | `gpt-oss-120b` | `test-browser-panel-real-ai-skip-e2e.mjs` | **PASS** — real DOM `Clicks: 1`, multi-tab bound context, reconnect without duplicate action |
| Chrome for Testing `155.0.8059.79` | `glm-5.3-flash` | `test-browser-panel-long-local-e2e.mjs` | **PASS** — five operator approvals, six tools, real DOM `Clicks: 1`, name `Bico`, city `Bandung`, recovery, reconnect |
| Chrome for Testing `155.0.8059.79` | `glm-5.3-flash` | `test-browser-panel-stop-real-ai-e2e.mjs` | **PASS** — backend `cancelled`, no browser write |
| Chrome for Testing `155.0.8059.79` | `glm-5.3-flash` | `test-browser-panel-vision-real.mjs` | **PASS** — `SATURN 42` + blue from pixels, screenshot approved and forwarded, no `data:image/` leak |
| Microsoft Edge `155.0.4283.62` | `glm-5.3-flash` | `test-browser-panel-real-ai-skip-e2e.mjs` | **PASS** — real DOM `Clicks: 1`, multi-tab, reconnect |
| Microsoft Edge `155.0.4283.62` | `glm-5.3-flash` | `test-browser-claude-parity-readonly.mjs` | **PASS** — `QA-BICO-731`, button `Ready` |

The same runs found a regression from the pre-auth body cap: the 64 KB limit also applied to the
authenticated `/api/browser-companion/response` route, so a screenshot result (up to ~7 MB) was
refused with 413 and `browser_screenshot` timed out twice. Fixed: the 64 KB cap applies only to
`pair` and `pair/challenge`; bridge routes accept up to 8 MB, and the dispatch test posts a
300 KB tool result to lock the behaviour. The vision run above is the end-to-end proof of the fix.

Still not verified: a Chrome Web Store-installed update, an Edge Add-ons store listing, Edge runs
for the long/vision/stop suites on this revision, and manual side-by-side comparison of every
historical Claude in Chrome scenario on the owner's daily profile.

## Release gate

**Released.** `0.4.6` was authorized by the owner on 2026-10-25, tagged `v0.4.6` (`25deca9`),
published to npm (`latest`, shasum `1b4c01dd393a22edaf9d6598e78c6bed026d479b`, signed provenance),
published as GitHub Release `v0.4.6` with the npm tarball, Windows x64 portable bundle and
Chrome/Edge extension packages, and the Chrome Web Store item now serves **0.4.6** (public listing
read on 2026-10-25). The Edge Add-ons listing remains unverified and is the only delivery without
published-version evidence.

Owner authorized **GO** for the **0.4.5** package and GitHub/npm release on 2026-10-18 after all six
audit blockers, cloud vision QA (`test-browser-panel-vision-real.mjs`), unpacked Microsoft Edge
`155.0.4283.45` E2E, and the native HTTP/HTTPS site-grant prompt (`test-browser-site-once-visible.mjs`
in Chrome and Edge) passed automated and real-browser verification. `@botconnector/switchboard@0.4.5`
is published on npm (`latest`) with signed provenance, and GitHub Release `v0.4.5` is published with
the npm tarball, Windows x64 portable bundle, Chrome/Edge extension packages, and SHA-256 checksums.
Chrome Web Store submission of `switchboard-chrome.zip` (`0.4.5`, item `miehnbiiokkciokmepnhgmlhjpabbkna`),
Microsoft Edge Add-ons store listing, and post-store-update checks remain manual publisher actions.
