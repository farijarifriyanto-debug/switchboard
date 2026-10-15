# Switchboard Browser Companion 0.4.4 — public release candidate

Date: 15 October 2026. Owner explicitly requested immediate launch after reviewing QA gaps.

## Identity

- Chrome Web Store existing item ID: `miehnbiiokkciokmepnhgmlhjpabbkna`; installed in owner's primary Chrome with `from_webstore=True`, `location=1`, `update_url=https://clients2.google.com/service/update2/crx`, prior version `0.4.3`.
- Update **same item**, not a duplicate. Manifest update version `0.4.4`.
- Artifact: `switchboard-chrome.zip` (51,817 bytes), SHA-256 `b230f3f36bce5c775a139e67e4a3b3cce31f272c57813c4caa920a1015be7994` (candidate built from branch before final merge; re-check exact published ZIP).
- `scripts/verify-browser-store-zip.py` PASS: eight expected files, matching audited source, images and root manifest valid. Chrome and Edge ZIP built from identical source.
- No change to NPM package version `0.4.1`; Browser Companion update is not a CLI/NPM release.

## Changes included

- Chrome's native single-use per-site grant is requested from an explicit panel user gesture. Grant is removed after one tool; second action requests grant again. No second permission gate.
- Browser screenshot JPEG is sent only on explicit visual user intent, as an ephemeral untrusted attachment to the configured model; never as base64 in chat or persisted session. Malformed/overlong/non-HTTP screenshot results fail closed.
- Screened DOM snapshot retains heading levels and non-sensitive control labels, enabling correct H1/button answers without bypassing page safety.
- Side-panel chat error and Stop outcomes, Auto multi-step recovery and tab-bound interactions from prior acceptance work.

## Acceptance

- Windows `npm test`, `npm run build`, `npm run typecheck` PASS at prior head; combined Node 20/22 GitHub CI PASS on `7b5c206`.
- True headed Chrome service worker, authenticated pairing, native user-granted Allow once → single DOM tool → automatic native revoke → second-action Deny: PASS. **A native Chrome popup unattended without user approval must wait/time out by design**.
- Real side-panel Send → screenshot → `gemma4:cloud` → canvas code `SATURN 42` and blue rectangle recognized: PASS, opt-in Cloud synthetic test only.
- Direct original Claude in Chrome native side panel read-only local QA response validated. Same HTML and prompt in Switchboard initially failed, but corrected semantic snapshot returned `Judul: QA-BICO-731; Tombol: Ready`, matching DOM; PASS with local AI.
- Direct original Claude click, vision and Stop UX comparison remains unverified due Claude nearing weekly quota. Owner accepted remaining comparison limitations for launch, **not** represented as complete pixel-level parity.

## Submission

Upload **only** audited Chrome ZIP version 0.4.4 to existing Chrome Web Store item, review required website-content/privacy disclosures and publisher record, select Submit for review. Publication is not confirmed until Web Store reports Published with the same item ID and current version. Edge Add-ons has its own unverified process. Do not leak API keys, signing keys, personal screenshots or credentials.
