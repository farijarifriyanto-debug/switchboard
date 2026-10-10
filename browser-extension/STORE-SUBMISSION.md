# Browser Companion — Chrome Web Store / Edge Add-ons submission

## Status

**Submission candidate. Not yet published in either store.**

The Switchboard v0.4.0 GitHub Release includes manual installation ZIPs, not a real marketplace listing. This new candidate adds Bico icons and local Web UI installation detection and must be reviewed independently before marketplace submission.

## Intended end-user experience

1. User runs Switchboard locally and selects the **Browser** preset in the Web UI.
2. Web UI checks whether Browser Companion is installed in the current browser and whether its authenticated local background connection is healthy.
3. If not installed, a real **Install from Chrome Web Store** or **Install from Edge Add-ons** link opens the store. The user confirms installation in the browser. No website can silently install an extension.
4. User refreshes Switchboard after installation, clicks **Open Companion**, then clicks **Copy pairing code**. The local API returns a single-use code only on explicit request from the authorized local UI. User enters it in Companion → Connection.
5. After pairing, the extension reconnects in the background without requiring its panel to stay open. Users type prompts in Switchboard, not in a second AI chat.

Until official store URLs have been approved/configured, the UI shows **Preview setup (manual)** instead of a misleading one-click store button.

## What the owner must do in each marketplace

### Chrome Web Store

- Open the Chrome Web Store Developer Dashboard using the intended publisher Google account.
- Complete account verification and any required developer registration/payment.
- Create an extension item and upload **switchboard-chrome.zip** from the candidate build.
- Fill name, short and full description, category, screenshots, language, single-purpose use, permission explanations, privacy disclosures, public privacy-policy URL and publisher support email.
- Submit the item for review. Wait for the store's actual publication confirmation and listing URL.

### Microsoft Edge Add-ons

- Open the Microsoft Partner Center / Edge Add-ons developer dashboard with the publisher account.
- Complete any required account/onboarding steps and create the new extension item.
- Upload **switchboard-edge.zip** and fill the listing, permissions, screenshots, privacy declarations, publisher contact and support information.
- Submit for review and wait for its own confirmed listing URL.

**No marketplace ID or listing URL is known yet. Never guess one.**

Once published, set these nonsecret environment variables when launching the **local** Switchboard process and restart the Web UI:

- **SWITCHBOARD_CHROME_WEB_STORE_URL** = https://chromewebstore.google.com/detail/(actual-approved-path-or-id)
- **SWITCHBOARD_EDGE_ADDONS_URL** = https://microsoftedge.microsoft.com/addons/detail/(actual-approved-path-or-id)

The server rejects non-HTTPS and nonofficial listing URLs. An unavailable URL leaves the store button hidden. Never commit the private store developer signing key or a private CRX key.

## Suggested store metadata

- **Name:** Switchboard Browser Companion
- **Short description:** Control approved Chrome and Edge tabs through the Switchboard agent running locally on your computer.
- **Purpose:** A controlled browser automation bridge for Switchboard. It is not a separate AI chat app.
- **Suggested category:** Productivity (subject to available marketplace categories).
- **Support:** https://github.com/farijarifriyanto-debug/switchboard/issues
- **Privacy policy, after merge:** https://github.com/farijarifriyanto-debug/switchboard/blob/master/browser-extension/PRIVACY.md
- **To supply before submission:** Publisher-owned email, screenshots from a clean isolated browser, correct data-use disclosures, store developer access.

## Permission justifications

| Permission | Intended use |
| --- | --- |
| activeTab | User-initiated temporary tab access and limited browser screenshot permission |
| scripting | Execute approved DOM inspection and controlled browser actions |
| tabs | Identify/select tabs and display active-tab context |
| storage | Local pairing secret, approved sites, settings and bounded audit log |
| sidePanel | Companion connection, permissions, inspection and history |
| alarms | Recover background connection after browser or service-worker suspension |
| HTTP loopback host access | Communicate exclusively with the Switchboard service on this computer |

The new content script runs only on HTTP localhost/127.0.0.1 pages; it handles installation **ping** and **open-own-extension-page**, not browser commands or pairing credentials.

## Privacy review

- Browser page content and action results can be returned to Switchboard and then sent to whichever AI provider the user configured. Do **not** claim all website content stays on the device.
- Disclose website content handling accurately in both marketplaces. The extension itself does not independently obtain AI-provider API keys.
- The user can approve/revoke site origins, see bounded browser audit entries and disconnect Companion.
- Do not include user chats, passwords, payment information, keys or tokens in public listing screenshots.
- A browser page can spoof its own install-detection display; this is only visual advice. The Switchboard server is authoritative about the authenticated background connection.

## Acceptance before marketplace submission

- Full build, typecheck, test suite, Chrome/Edge ZIP integrity, and icon validation.
- Install in a clean Chrome profile and a clean Edge profile: detection, pairing, closing panel, agent tool action and user approval.
- Verify Web UI never shows an invented marketplace URL. On first installation users may need to refresh their local Switchboard tab before detection.
- Review extension store policies and disclosures with the publisher's actual account.
- Chrome and Edge independently assign item IDs and control approval timelines and auto-updates.

**Remaining human step:** Connect or create Chrome Web Store and Microsoft Edge Add-ons developer publisher accounts, enter real publisher details, and submit each extension for review. This cannot be completed merely by publishing Switchboard to npm or GitHub.
