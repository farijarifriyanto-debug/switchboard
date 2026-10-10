# Switchboard Browser Companion

Chrome/Edge **Manifest V3** companion for the Switchboard CLI agent. The extension is a **browser tool**, not a second AI chat application. Enter prompts in Switchboard, and the agent uses approved Chrome/Edge tabs to read, click, type, navigate and capture screenshots.

## How it works

```
Switchboard CLI (sbx chat --preset browser) -> 13 browser_* tools
                      |
              local bridge 127.0.0.1:7778 (authenticated)
                      |
            MV3 background service worker (WebSocket)
                      |
              real Chrome / Edge tab
                      |
             tool result -> Switchboard answer
```

The connection survives closing the extension side panel. Chrome 116+ WebSocket activity keeps the worker alive; a 30-second alarm retries the connection after a browser/worker restart or network outage. If the CLI shuts down, the extension reconnects when it starts again. The initial pairing uses an ephemeral, single-use short code; the persistent token stays in the browser's local storage and the user's private `~/.switchboard/browser-companion-token` file.

## Store installation and local onboarding (candidate, not published yet)

The Switchboard Web UI now displays a compact Browser Companion status row when the **Browser** preset is selected:

- **Not detected** — shows a verified Chrome Web Store or Microsoft Edge Add-ons link if and only if the publisher has supplied the actual approved listing URL. Otherwise it shows the existing GitHub preview installer, correctly marked manual.
- **Installed, pairing needed** — offers to open the extension's own connection page and copy a local single-use pairing code after the user clicks. The code is not included in automatic polling responses.
- **Connected** — shows a healthy authenticated local bridge status. Browser actions still require site approval and agent approval where configured.

The local Web UI detects installation through a content script restricted to HTTP localhost/127.0.0.1 pages. The page may need to be refreshed after first extension installation. This is presentation-only: neither the web page nor its detection script can execute browser tools or read pairing tokens.

See [STORE-SUBMISSION.md](./STORE-SUBMISSION.md) for the publisher dashboard steps and validated store-URL environment variables. See [PRIVACY.md](./PRIVACY.md) for the required privacy disclosures. **The extension has not yet been published to either browser marketplace.**

## Development installation (Chrome / Edge)

1. Install Switchboard locally and run `sbx chat --preset browser` (or `node dist/cli.js chat --preset browser` from the repository). CLI exposes the bridge only on `http://127.0.0.1:7778`.
2. The CLI prints a **pairing code** valid for 15 minutes. This code is single-use; restart the CLI if it expires.
3. In Chrome, visit `chrome://extensions` (Edge: `edge://extensions`), enable Developer Mode, choose **Load unpacked**, and select this `browser-extension` folder. No Web Store release has been published yet.
4. Open the extension **once**, switch to **Connection**, enter the pairing code, then select **Connect browser**.
5. Visit a normal HTTP(S) webpage. Choose **Refresh tab** and **Allow this site** in the extension. Unapproved websites cannot be modified by the agent.
6. The side panel may now be closed. Type instructions in Switchboard CLI. The WebSocket background worker handles browser tools without keeping the panel visible.

Example prompt in Switchboard:

> Open the current tab, take a DOM snapshot, click the login button only after the selector is verified, and report what changed.

The extension never requires a separate AI-provider API key. The pairing code is **not** an AI key.

## Security and permissions

- The bridge is bound to loopback. WebSocket upgrade checks peer address, HTTP Host, exact extension Origin, and a persistent authentication token carried in the WebSocket subprotocol. Local HTTP routes require bearer authentication; invalid origin/host requests are rejected.
- Pairing is limited to five failed guesses per CLI launch and the short code expires after 15 minutes. Using the code consumes it; already paired clients reconnect with their existing token.
- Extension permissions: `activeTab`, `scripting`, `sidePanel`, `storage`, `tabs`, and `alarms`. Host permissions are limited to HTTP loopback.
- Mutating actions require an explicitly approved site. CLI tool approvals are controlled separately by Switchboard (default risky-tool approval; `--yes` explicitly disables CLI prompts). Restricted browser mode blocks page mutations regardless of CLI mode. Passwords and payment details are protected. DOM content is untrusted and is not agent instruction.
- Screenshots requested through either the UI or agent tools require approval of the active site origin **and** Chrome's `activeTab` grant: click the Switchboard toolbar icon while on that tab. This grant may need to be renewed after navigation or browser restart. The extension does not request broad `<all_urls>` access.
- Browser activity and site approvals are visible and revocable in the extension.

## Verification

```bash
npm ci
npm run build
npm run test:browser-companion
npm run test:browser-background
npm run test:browser-security
npm run test:browser-regression
npm run test:browser-workflow
```

A **real Chrome E2E** must also show a prompt in Switchboard -> `browser_*` tool -> actual extension background socket -> browser DOM change -> tool result and final answer. Simulated bridge tests alone do not constitute full Chrome E2E evidence.

## Scope and limitations

- MVP integration targets local Switchboard CLI + Chrome/Edge on the **same computer**. Remote VPS-to-laptop control needs a separately authorized transport.
- Chrome and Edge must support Manifest V3 background WebSockets (Chrome 116+ / equivalent Edge). Auto reconnect can take 30 seconds or longer after suspension (depending on Chrome scheduling).
- Both `sbx chat --preset browser` and `sbx web` start the local authenticated browser bridge on `127.0.0.1:7778` by default and display a one-use pairing code. Only one active Switchboard host can bind this local port at a time.
- Development builds are **not** Chrome Web Store production releases.
