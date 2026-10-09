# Switchboard Browser Companion — Real Chrome Background E2E

**Date:** 2026-10-10 (WIB)  
**Branch:** `feat/chrome-browser-companion`  
**Scope:** Local Windows laptop `home`; isolated Chrome for Testing v154; Switchboard local browser bridge.

## Verified

The actual unpacked Chrome extension v0.3.0 used its **Manifest V3 service worker**, not an open side panel, to reconnect and execute tools. The extension panel was **closed** during the proof.

- Browser Companion was paired from its Connection settings using the **8-character, one-time code** printed by `sbx chat --preset browser`. The UI confirmed connected, erased the code input, and retained the persistent local pairing.
- After exiting Switchboard CLI, a fresh Switchboard host started on `127.0.0.1:7778`. The extension reconnected in background.
- `browser_tabs_list` returned the real Chrome test tab.
- `browser_dom_snapshot` read `Clicks: 0` and selector `#increment` on `http://127.0.0.1:8999/`.
- `browser_click` executed through the WebSocket-backed background service worker.
- A second DOM snapshot read **`Clicks: 1`**. The full process exited **0**.
- Two repeats succeeded: about **5.1 seconds** and **12.1 seconds** to reconnect. These are measured examples, not guaranteed reconnect SLOs.
- Legacy HTTP/SSE tests, Browser Companion security, 13-tool bridge tests, TypeScript build, and WebSocket exclusivity tests also passed.

## Evidence

- [Successful background screen recording — 25.5 seconds](./background-closed-success.mp4)
- [Final Chrome screenshot after click](./background-closed-clicks-one.png)
- [Exact successful test output](./background-closed-success.log)

The recording shows the Chrome tab and actual click result, **not a full AI-provider-generated conversation**. It proves the tool transport, browser action, and readback with the extension panel closed. The earlier agent prompt-through-model path was verified separately, but a new combined AI-provider test remains pending when BotConnector authentication is healthy.

## Architecture and safeguards

- Manifest V3 background worker maintains one authenticated localhost WebSocket, with 20-second heartbeat and a 30-second reconnect alarm on supported Chrome.
- CLI pairing code is single-use, 15-minute expiry, and limited to five incorrect guesses per CLI instance.
- The persistent companion secret is never displayed in the extension after pairing and is not included in these artifacts.
- If another paired browser takes over, the earlier connection receives a distinct close code and does not fight to reclaim the session.
- Approved-site permission remains required for page mutations; no production website was modified.

## Outstanding release scope

- Final test with a healthy actual LLM and browser extension *with the panel closed* for prompt -> tool -> final AI answer.
- Web UI-only server needs the equivalent background upgrade bridge; standalone CLI is verified.
- Chrome Web Store and Edge Add-ons packaging, store disclosures, policy review, and publication are **not complete**.
- No production deployment or merge to `master` was performed.

**Verdict:** Background Browser Companion transport, pairing and real Chrome tool operation PASS. Public release NOT YET APPROVED.
