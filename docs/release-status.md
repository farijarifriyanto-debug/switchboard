# Release status — single source of truth

Last verified: **18 October 2026**. Update this file with the evidence date whenever a release status changes.
Historical QA and release notes remain useful as evidence but do not override this table.

| Delivery | Version | Status | Evidence / note |
|---|---|---|---|
| npm `@botconnector/switchboard` | **0.4.4** | Published; `latest` | `npm view @botconnector/switchboard version dist-tags` on 2026-10-18 |
| Source / working tree | **0.4.5** | Unpublished security candidate | Merged to `origin/master` on 2026-10-18 (source pushed); not tagged or published |
| Chrome Web Store Browser Companion | **0.4.4** | Published (existing item) | Item `miehnbiiokkciokmepnhgmlhjpabbkna`, observed at 0.4.4; update 0.4.5 **not submitted** |
| Microsoft Edge Add-ons | **unknown** | Unverified | No verified listing/version evidence; do not invent a store URL |
| GitHub Release | **v0.4.4** | Published | Existing release; 0.4.5 is not a GitHub release |

## What 0.4.5 contains

The unpublished source version hardens local trust boundaries:

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
- Not verified: a Chrome Web Store-installed 0.4.5 update (store remains 0.4.4), Edge, a real
  HTTPS native site-grant prompt, and every historical Claude in Chrome parity scenario. This is
  why the release gate below is still closed.

## Release gate

Public beta/production remains **NO-GO** until the owner explicitly authorizes npm publish, a
version tag/GitHub Release and Web Store submission. The 0.4.5 source is merged to
`origin/master` (2026-10-18, owner-authorized push; nothing published). The six audit blockers
now have automated and real-Chrome evidence — including the cloud vision QA part of
`test-browser-panel-vision-real.mjs` (verified 2026-10-18 with the free BotConnector-gateway model
`agnes-3.0-flash`) — but store-update, Edge, HTTPS site-grant and complete Claude in Chrome parity
checks are still outside this evidence set.
