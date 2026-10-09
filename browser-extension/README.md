# Switchboard Browser Agent — Chrome and Edge preview

One **Manifest V3** extension codebase for Google Chrome and Microsoft Edge.

## Install

1. Clone this repository and check out `feat/chrome-browser-companion`.
2. Chrome: open `chrome://extensions`; Edge: open `edge://extensions`.
3. Enable Developer mode, select **Load unpacked**, and select this `browser-extension` directory.
4. Open a normal HTTP(S) page and **click the extension toolbar icon**. It captures a snapshot and opens the side panel.

## Implemented

- Read title, URL, selected text, page text and a sample of visible DOM controls.
- Review and copy page context manually to Switchboard.
- Site-origin allow/revoke list; read-only until site is approved.
- Manual click, type and scroll with a **per-action confirmation dialog**.
- Refuse password, file-upload and recognized payment-card input fields.
- Export a local workflow *draft* of manually executed actions. Typed values are redacted in drafts.
- Shared Chrome/Edge codebase; no broad host permissions or automatic network transmission.

## Important limitations

**Not production-ready and not Claude in Chrome parity.** The side panel is not yet connected to the Switchboard agent loop. There is no autonomous AI browser control, no screenshot tool, no multi-tab workflow runner, no schedule execution, and no extension-store publication. The draft is **not replayable**. Clicking a button can submit a form or cause irreversible side effects: always review the target and use only trusted sites.

`activeTab` access is temporary, granted by the extension toolbar click. To operate on a newly navigated page, click the toolbar icon again. Restricted browser pages cannot be accessed. DOM content is untrusted and can contain prompt injection. The captured snapshot remains in session storage; approved site origins and workflow drafts remain in extension local storage.

This extension is for a **single trusted operator**. Do not expose Switchboard's unauthenticated console or a browser-control bridge on a public interface. Before autonomous agent control, add authenticated native messaging or a strictly authenticated loopback bridge, enforce origin-specific policies, approval, audit logging, and E2E tests.

## Manual verification checklist

- Chrome and Edge: load unpacked, click toolbar on a normal HTTPS site, verify panel text and DOM metadata.
- Test selected text, copy, allow and revoke, click/type/scroll with confirmation.
- Confirm password inputs and restricted pages are rejected.
- Confirm changing origin requires a new toolbar click.
- Confirm exported workflow redacts typed values and clear removes draft.
- Inspect extension service worker and network activity for errors or unexpected requests.

**Validation:** source syntax/build checks are not browser E2E. Real-browser validation must be recorded separately before release.
