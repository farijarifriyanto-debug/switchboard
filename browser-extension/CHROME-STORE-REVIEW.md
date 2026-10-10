# Chrome Web Store — reviewer instructions and release checklist

**Extension:** Switchboard Browser Companion (BotConnector)
**Draft Chrome Web Store item:** existing item in the publisher dashboard; **do not create a new item**.
**Extension package:** v0.4.1 (updated Bico icon and prior tested browser bridge).
**Publishing recommendation:** Unlisted / All regions / Free / manual publication after successful Google review.

## Distribution fields (Dashboard > Distribution)

- **Visibility:** Unlisted — any user with the direct extension link may install; no search discovery. This is **not** a Private trusted-tester release.
- **Geographic distribution:** All regions, unless publisher-specific legal restrictions require exclusions.
- **Pricing:** free extension; no required BotConnector subscription. An external AI model provider may have separate pricing or usage limits.
- **In-app purchases:** No built-in extension purchases. If Google instead asks whether Switchboard's optional external AI service costs money, disclose external third-party provider costs truthfully. Do not label a paid AI model as free.
- **Publishing:** where a separate deferred/manual publish control is offered, use it so the publisher checks approval before going live.
- **Store URLs:** add the **actual** item listing URL to Switchboard configuration only after Google has approved/published it.

## Test instructions — text to paste into reviewer field

Switchboard Browser Companion is a **local** browser companion and has no login or required paid BotConnector account. A locally running Switchboard service is necessary for pairing; the extension does not act as an independent chatbot.

**Quick test (no AI provider key needed):**

1. Install Node.js 20+ and run `npm install -g @botconnector/switchboard@0.4.0`.
2. Start the local app in a terminal: `sbx web --no-open`. The terminal shows an 8-character, one-use Browser Companion pairing code; leave this terminal running.
3. Open `http://127.0.0.1:7777` in Chrome. Switchboard's local Web UI opens without a BotConnector account. Select the **Browser** preset. The local onboarding row may not appear in npm v0.4.0; the extension's own **Connection** tab works independently.
4. Open the installed Switchboard Browser Companion from Chrome's extensions toolbar. Go to **Connection** and connect to `http://127.0.0.1:7778` using the pairing code from the running Switchboard terminal. If pairing expired, restart Switchboard for a fresh code.
5. Confirm **Connected**, then open `https://example.com/` in another browser tab. Click the extension toolbar icon while that tab is active to grant Chrome's temporary `activeTab` permission. In the Browser Companion panel use **Refresh tab**. Review the **Inspector**, **Permissions**, and **Connection** sections.
6. Use **Allow this site** to approve that website. Permission can be revoked in the same panel. Close and reopen the panel and confirm the background connection can recover.
7. To test AI-initiated navigation, clicking, typing, and readback, configure any compatible model provider in Switchboard, then use `sbx chat --preset browser` or the Web UI **Browser** preset. This is **optional** for the no-account/no-AI-key inspection above. The extension itself never needs a separate AI provider API key.

**Expected behavior:** Chrome tab information appears in the companion; site permission controls work; the local background connection operates after the panel closes. Browser write actions to unapproved sites are refused. Password and payment fields are protected from tool input; the extension can still read sensitive page text elsewhere, as disclosed in the privacy policy.

**Restrictions:** Chrome internal pages (`chrome://`), non-HTTP(S) URLs, and some protected pages cannot be automated. Screenshots additionally require the user's Chrome `activeTab` grant, not only site approval. Browser Companion does not inject remote executable JavaScript: all extension JS is packaged in its ZIP, and it receives structured browser actions through the authenticated local service.

**Support:** https://github.com/farijarifriyanto-debug/switchboard/issues

## Privacy declaration checklist

The extension can handle website contents/screenshots, URLs/tab titles, browser actions, a local authentication pairing token, user-entered form input and local audit history. If pages contain personal/health/finance/communication information it can incidentally enter the browser tool output. Declare accurately; do not certify that all browser data stays local because the user-selected model provider can receive it. The three limited-use checkboxes should only be certified after the publisher confirms the actual data-handling practice.

**Stable public privacy policy URL once this PR is merged to master:**
https://github.com/farijarifriyanto-debug/switchboard/blob/master/browser-extension/PRIVACY.md

## Uploaded ZIP — hard verification boundary

An earlier v0.4.0 package was uploaded to the draft **before** the revised Bico v2 artwork was embedded. Consequently, it is **not identical** to the corrected submission ZIP.

**Required:** Dashboard > **Package** > **Upload New Package**, select the v0.4.1 Chrome ZIP provided for this draft (same existing item ID, NOT Add new item). After upload confirm manifest version **0.4.1**, extension name and six permissions and two explicit localhost host matches. Save draft.

Check each archive entry against the version-controlled files, rather than relying on the filename or archive hash alone. ZIP timestamps and compression can change its overall SHA-256 despite identical source file bytes. To prove the exact bytes installed on Google's side, the publisher must provide a downloaded draft package from Google or review the Package tab and confirm its version/content; **local equality cannot independently prove the previously uploaded Google's stored bytes**.

## Final gating

- Publish the privacy document publicly on master with a working URL and a correct publisher contact in the account.
- Replace the outdated store ZIP with matching 0.4.1, and complete all other required Privacy/Store listing fields.
- Confirm Distribution and reviewer instructions against the actual dashboard.
- CI, typecheck, full regression, Chrome extension tests, ZIP root manifest + icons and per-file equality to Git commit must all pass.
- Only then request review; acceptance and store publication remain Google's decision. Do not claim approval before an actual store status change.
