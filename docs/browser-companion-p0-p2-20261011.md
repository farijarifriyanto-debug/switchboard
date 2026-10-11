# Switchboard Browser Companion P0–P2 acceptance — 11 October 2026

## Scope and isolation

Source: `farijarifriyanto-debug/switchboard` at baseline `3549bc7`; changes are developed on `fix/real-browser-permission-ux-20261011` in a separate Windows worktree.

No restart of the active local Switchboard (127.0.0.1:7777/7778) and no changes to the Chrome Web Store-installed extension were performed. Validation of the new extension used **visible Chrome for Testing 153 on the user's Windows laptop**, launched with an isolated temporary browser profile (not headless).

## P0 — per-site Chrome permission gate

- `optional_host_permissions` supports user-initiated grants to individual HTTP(S) origins. No automatic all-sites grant.
- Local Switchboard approval alone cannot bypass `chrome.permissions.contains`.
- When an agent requests a target origin without permission, the original action waits, the extension icon shows `!`, and a side-panel card displays the requested origin and action.
- A direct user click invokes `chrome.permissions.request` for that site; the original action resumes only after Chrome permission and local consent are both confirmed.
- Denial leaves the tab unchanged. Restricted mode remains fail-closed. Waiting requests time out after 75 seconds (bridge default timeout 90 seconds).
- Native Chrome permission prompt was observed on the live visible-browser test for `botconnector.id`, and the queued navigation returned success.

## P1 — browser controls and consistent UI

- The side panel now reports active-tab metadata, not stale capture state.
- Site status considers both the browser-native permission and the local Switchboard allowlist.
- Tab listing/selection does not inject page scripts. Inspection/action tools require a permitted site.
- Visible Chrome for Testing 153: real Manifest V3 service worker, single-use pairing, WebSocket, DOM snapshot, browser click and DOM read-back **PASS**.
- Visible Chrome for Testing 153: request for `https://botconnector.id/`, native Chrome permission dialogue, and resumed cross-origin navigation **PASS**.

## P2 — direct side-panel tasks

- Added **Ask Switchboard**, Run in Chrome, Stop, Full chat, streamed final response and tool activity status.
- Reuses the authenticated local Switchboard Web UI backend; no browser-to-cloud bypass.
- CORS preflight is permitted for the extension origin; every actual request still requires the bridge bearer token.
- Invalid/missing token and ordinary web-origin requests remain rejected.
- Authenticated `/api/chat` streaming integration against a deterministic provider fixture returned an agent final response: **PASS**.
- AI prompt context includes site origin, not potentially private full URL query strings.

## Verification

- `npm run typecheck`, `npm run build`, `npm run package:extension`: **PASS**.
- `test-browser-companion`, `test-browser-security`, `test-browser-workflow`, `test-browser-regression`, `test-browser-background-ws`, `test-browser-store-onboarding`, `test-browser-approval-ui`: **PASS**.
- New `test-browser-native-permission`, `test-browser-panel-chat-auth`, `test-browser-panel-chat-stream`: **PASS**.
- Visible Chrome for Testing integration: **PASS** for real extension and native per-site grant / navigation.
- Windows full `npm test`: **NOT PASS**. The CLI JSON test initially collided with the user's active port 7778; isolated that test's browser service. The suite then advanced but stopped at the pre-existing `scripts/test-skills.mjs` Windows symbolic link `EPERM` (not an extension failure). Linux GitHub CI should validate the complete suite.

## Release boundary

Candidate extension manifest version **0.4.2**. The ZIP build is an update candidate and is **not installed into the user's primary Chrome profile or submitted to Chrome Web Store**. The existing installed version will keep its previous behavior until the publisher uploads and the store distributes the newer package.

The Chrome Web Store publisher must review optional host-permission disclosures and perform a final package identity check before update submission. No source changes or installation should imply that Chrome's native permission prompt can be skipped.
