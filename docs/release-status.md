# Release status — single source of truth

Last verified: **18 October 2026**. Update this file with the evidence date whenever a release status changes.
Historical QA and release notes remain useful as evidence but do not override this table.

| Delivery | Version | Status | Evidence / note |
|---|---|---|---|
| npm `@botconnector/switchboard` | **0.4.4** | Published; `latest` | `npm view @botconnector/switchboard version dist-tags` on 2026-10-18 |
| Source / working tree | **0.4.5** | Unpublished security candidate | Based on `origin/master` `c636b00` (v0.4.4); not merged, tagged or published |
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
- Trace session keys reject path traversal.
- Unattended automations refuse shell/credential-capable presets unless `allowUnattended: true`.
- Documentation and manifest versions are checked by `scripts/test-docs-consistency.mjs`.

## Verification evidence (18 October 2026)

- `npm run typecheck`, `npm run build` and `npm test` pass on Windows.
- Real Chrome for Testing `155.0.8059.79`, unpacked extension from this source, simulated provider:
  `test/test-browser-panel-terminal-visible.mjs` **PASS** (pairing, authenticated WebSocket,
  panel success/error/cancel/stop/step-limit, no false final).
- Real Chrome for Testing `155.0.8059.79` plus local model `botconnector-fast:latest` (Ollama
  `127.0.0.1:11666`), unpacked extension, real click and independent DOM read:
  `test/test-browser-panel-real-ai-e2e.mjs` **PASS** — `Completed.`, two visible approvals,
  actual `Clicks: 1`, agent-tab context preserved, reconnect without duplicate action.
  The test used an isolated copy of the extension whose panel API base was pointed at the test's
  dynamic web port instead of `7777`; product source was not changed for this run.
- Not verified: a Chrome Web Store-installed 0.4.5 update (store remains 0.4.4), Edge, a real
  HTTPS native site-grant prompt, and every historical Claude in Chrome parity scenario. This is
  why the release gate below is still closed.

## Release gate

Public beta/production remains **NO-GO** until the owner explicitly authorizes merge, npm publish
and Web Store submission. The six audit blockers now have automated and real-Chrome evidence, but
store-update, Edge, HTTPS site-grant and complete Claude in Chrome parity checks are still outside
this evidence set.
