# Switchboard Browser Companion — phase 1

Chrome Manifest V3 side panel for explicitly reading the active HTTP(S) page and selected text. No background scraping, no automatic network transmission, and no privileged website mutation.

## Try it
1. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose this directory.
2. Open a regular HTTP(S) page and click the extension icon.
3. Select **Read active tab**, inspect the extracted context, then **Copy context for Switchboard**.

## Scope and limitations
This is the first read-only slice, **not yet** a Claude-in-Chrome-equivalent agent. It does not connect to the Switchboard agent runtime, click or fill forms, manage tabs, or submit actions. Browser internal pages, extension pages, and other protected pages are inaccessible. The `activeTab` permission is temporary and granted by user invocation; access may need renewed invocation when changing sites. Page text is untrusted and may contain prompt injection or secrets; review it before sharing.

## Next phases
Add a locally authenticated bridge, pairing, per-origin permissions, DOM-targeted actions with user confirmation, then workflow tests on real Chrome. Never expose a raw shell or unauthenticated localhost command endpoint to page scripts.
