# Plan — Panel discovers the real web console origin (2026-10-18)

## Problem

`browser-extension/panel.js` hardcodes `http://127.0.0.1:7777` for `/api/chat`,
`/api/approvals`, `/api/runs/:id/cancel` and the "open console" button. With
`sbx web --port <n>` the console lives elsewhere, so the panel talks to the wrong
port (or to an unrelated local server). Real product limitation, owner-reported.

## Design (no new UX, no new settings)

The paired server already owns the truth: it runs the console and the bridge in
one host. Advertise the console origin over channels the extension already uses:

1. **Server** (`src/plugins/browser-companion.ts`): when the web console plugin
   is present, include `webOrigin` (e.g. `http://127.0.0.1:8080`) in the
   `/pair` response, the `/status` response, the WS `connected` frame and the
   SSE `connected` event. Omitted when no console is running.
2. **Extension background** (`browser-extension/background.js`): validate the
   origin (http + loopback only, mirrors `validBridgeUrl`), store it as
   `webOrigin` in `chrome.storage.local`, expose it in `bridgeStatus()`.
3. **Panel** (`browser-extension/panel.js`): use the stored origin instead of
   the literal, default `http://127.0.0.1:7777` for older servers.
4. Old extension + new server: unchanged behavior (hardcoded 7777) until the
   next extension release; new extension + old server: fallback 7777.

## Checklist (TDD: failing test first)

- [x] RED: `test-browser-panel-chat-auth.mjs` — pair response advertises the live
  console origin; WS `connected` frame carries it. Watched fail: `actual: undefined`.
- [x] RED: `test-browser-background-ws.mjs` — no console running → `webOrigin` absent.
- [x] RED: `test-browser-native-pair.mjs` — extension stores validated `webOrigin`
  from a pair response; invalid (non-loopback / https / path) values ignored.
  Watched fail: `background.js exposes the web origin discovery helpers`.
- [x] GREEN: implement server advertisement (pair/status/WS/SSE).
- [x] GREEN: implement extension storage + panel usage (5 call sites).
- [x] RED/GREEN: `test-browser-panel-real-ai-e2e.mjs` — dropped the patched test
  copy; the real extension reached a dynamic web port via discovery.
- [x] Full `npm test` (exit 0, `trace: OK`, `docs: OK`), `npm run typecheck` and
  `npm run build` exit 0.
- [x] Real Chrome E2E with the real model (`botconnector-fast:latest`).
- [x] Evidence log + `docs/release-status.md` update.

## Out of scope

- Old store extension (0.4.4) keeps the hardcoded port until next release.
- `sbx chat --preset browser` without a web console still has no Ask backend.

## Verification log

- RED (before implementation): `test-browser-native-pair.mjs` failed with
  `background.js exposes the web origin discovery helpers`;
  `test-browser-panel-chat-auth.mjs` failed with
  `pair response advertises the live console origin — actual: undefined`.
- GREEN after implementation: `test-browser-native-pair.mjs`,
  `test-browser-panel-chat-auth.mjs`, `test-browser-background-ws.mjs` all exit 0.
- Supporting suite: `test-browser-panel-render.mjs`, `test-browser-panel-chat-stream.mjs`,
  `scripts/test-browser-store-onboarding.mjs`, `test-browser-native-permission.mjs`,
  `scripts/test-web-companion-startup.mjs` exit 0.
- Real Chrome for Testing `155.0.8059.79`, extension loaded **unmodified** from
  `browser-extension/`, local model `botconnector-fast:latest`: the extension adopted
  `http://127.0.0.1:60410` from the paired bridge while a live `sbx web` kept 7777;
  panel Ask reached the dynamic console, real click, DOM read `Clicks: 1`,
  `PASS_FULL_PANEL_REAL_AI_AUTO_BROWSER_FINAL_E2E`, reconnect without duplicate action.
- `npm run typecheck` exit 0; `npm run build` exit 0.
- Reference comparison (Claude in Chrome): the reference does not expose a user-run
  console with a configurable port, so this is internal plumbing, not a new UX
  pattern; the observable result (panel Ask hits the paired local backend) is
  unchanged. No new setting, menu, or confirmation was added.
- Not covered here: the published 0.4.4 extension keeps the literal 7777 until the
  next store release; tests whose fixture pins 7777 keep their own convention.
