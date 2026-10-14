# P0 Allow once + P1 Auto Vision — Windows Chrome QA, 15 Oct 2026

Scope: owner Windows laptop and GitHub only. No VPS, production, extension Web Store update, or imported upstream proprietary code. Authoritative Chrome UX reference: Claude in Chrome, per `AGENTS.md`.

## P0 — Single native Chrome site permission

Chrome for Testing, actual unpacked Switchboard MV3 extension, local-only QA origin `qa.internal` resolved to loopback, real side-panel click and native Chrome host-permission prompt. No fake host grant, no `Browser.grantPermissions`.

- **PASS one full real-browser trial** (`test/test-browser-site-once-visible.mjs`, exit code 0): native Allow once accepted; `browser_dom_snapshot` returned real page content; `chrome.permissions.contains` confirmed no remaining site grant; second tool requested the permission again; Deny aborted it and page remained unchanged.
- **Unstable replication**: another real-browser trial of the same test (exit code 1) left Chrome native permission pending. The test environment must have an interactive foreground browser and a real response to Chromium's permission prompt. Do **not** claim unconditional GO for native Allow once while this is inconsistent. Do not automatically grant site permissions in a test.
- **PASS contract regression**: `test/test-browser-once-snapshot-contract.mjs` ensures read-only DOM snapshot consumes only one grant; no hidden second DOM capture. Native permission and fail-closed tests PASS.

Native consent is the sole site gate; Manual/Auto remain *action* approvals only. No extra site permission logic added in this branch.

## P1 — Screenshot automatically forwarded as image to AI

Runtime change: `src/plugins/agent.ts`. When user explicitly asks for a screenshot/visual answer and agent calls the existing `browser_screenshot` tool:

1. Validate real browser result, HTTP(S) origin, image MIME/base64 and size (up to 7M characters encoded).
2. Replace tool result exposed to UI and persistent session with a short, safe text receipt. **Do not persist or log JPEG base64.**
3. Pass the captured pixels only in the **next model turn** via an ephemeral, untrusted image attachment. Reuse existing OpenAI Chat/Responses/Anthropic image adapters; no new image gateway, menu or custom permissions.
4. Screenshot forwarding without explicit user visual request, oversized/invalid data or non-HTTP origin fails closed. Provider/model limitations must surface as errors; do not claim a nonvision model understands pixels.

Verification on visible Chrome for Testing, browser extension pairing and authenticated WebSocket, synthetic canvas drawn with `SATURN 42` and a blue rectangle, no DOM text:

- **PASS unit** `test/test-browser-agent-vision-forwarding.mjs`: five contract checks, including transient image only, no screenshot leak to persistent session/event stream, invalid image and nonvisual request fail closed.
- **PASS real agent** `test/test-browser-agent-vision-real.mjs`: actual model `gemma4:cloud` automatically calls `browser_screenshot`, receives real JPEG via new forwarding path and replies `SATURN 42, blue`; agent completion about 6 seconds.
- **PASS real side panel** `test/test-browser-panel-vision-real.mjs`: user's synthetic instruction through the actual Switchboard side-panel Send control → real agent chooses tabs and `browser_screenshot` → model vision → panel `Completed.` with correct answer; ~14 seconds. The screenshot JPEG is not written to session history or panel events.
- These two *real* vision tests use **Ollama Cloud inference (`gemma4:cloud`)**, not an on-device vision model, and are strictly opt-in via `SBX_ALLOW_CLOUD_VISION_TEST=1`. Only a synthetic QA canvas was sent; no user tab, credentials, or private screenshot was sent.

Run manually on Windows after `npm ci && npm run build`, with `ollama serve` on `127.0.0.1:11666`:

```powershell
$env:SBX_TEST_CHROME_PATH='C:\path\to\Chrome-for-Testing\chrome.exe'
$env:SBX_LOCAL_BASE_URL='http://127.0.0.1:11666/v1'
$env:SBX_ALLOW_CLOUD_VISION_TEST='1'
$env:SBX_VISION_MODEL='gemma4:cloud'
npm run test:browser-vision-agent-real
npm run test:browser-vision-panel-real
```

The unit test runs in ordinary `npm test` without Cloud usage.

## P2 — Original Claude in Chrome login and comparison

Owner confirmed logged in on `claude.ai/new` and sent a screenshot showing Claude's actual native side panel. Read-only checks found installed original Claude extension version 1.0.100. Opening its `sidepanel.html` directly in a **separate ordinary Chrome tab** showed `Can't reach the Claude extension` even after Retry. This unsupported standalone-tab context is **not** equivalent to the official Chrome side-panel view, and is not evidence of an original-app defect or a successful parity test. No private conversation or account credentials were read; do not claim current logged-in Claude task parity without interacting in its native side panel. Keep P2 open until a harmless task runs end-to-end side-by-side with Switchboard.

Release: **P1 GO for explicitly tested visual QA workflow. P0 one real PASS + contracts PASS, but unstable repeat: HOLD. P2 current installed-original runtime comparison: unverified.** No production/Store deployment.
