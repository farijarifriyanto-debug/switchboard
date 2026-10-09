# Switchboard Browser Companion — Chrome + Microsoft Edge

Single **Manifest V3** extension codebase for Chrome and Edge. Phase 1: user-initiated, read-only page capture and copy to Switchboard. Not yet connected to the agent runtime; no automated clicks or form filling.

## Install locally

**Chrome:** open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this `browser-extension` directory.

**Edge:** open `edge://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the **same directory**.

1. Navigate to an ordinary HTTP(S) page.
2. **Click the Switchboard toolbar icon**. This grants temporary `activeTab` access, captures the current page, and opens the side panel.
3. Inspect the page text and selection, then click **Copy context for Switchboard**.
4. To capture another page, click the toolbar icon again. The **Show last capture** button only displays the last snapshot; it does not request new page access.

## Security and limitations

No broad host permissions, background crawling, remote transmission, or website mutation. Browser internal pages, restricted sites, and protected documents cannot be captured. A session-scoped snapshot is stored in `chrome.storage.session` (not persisted across browser restarts). Captured pages can contain secrets or prompt injection: treat as untrusted data and review before sharing. The active-tab permission is granted by invoking the toolbar icon, **not** by clicking inside the side panel.

## Verification checklist

- Load unpacked separately in current stable Chrome and Edge.
- Open a normal HTTPS page, click toolbar icon, confirm panel and captured URL/title/text.
- Select text and click toolbar icon again, verify selection.
- Navigate to a different origin; verify that **Show last capture** doesn't silently read the new page.
- Verify copy button, unsupported `chrome://` / `edge://` pages, and restricted pages.
- Verify no unexpected network requests in extension service-worker DevTools.

**Status:** source-only implementation. Browser E2E verification and store publication are pending.

Next phase: authenticated local pairing to Switchboard runtime, origin-scoped action approvals, agent-driven browser operations and integration tests.
