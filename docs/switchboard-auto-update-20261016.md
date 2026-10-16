# Switchboard auto-update candidate — 16 October 2026

STATUS: CANDIDATE PASS; NOT INSTALLED TO LIVE GLOBAL SBX; NOT PUBLISHED TO NPMJS.

## Scope
Switchboard main app is installed via npmjs @botconnector/switchboard. Chrome Web Store owns companion extension updates. Windows portable ZIP is a separate delivery mechanism.

Public npmjs latest v0.4.2 and live global Switchboard v0.4.2 were verified at start; development checkout still contains package.json v0.4.1. Live global app has extra Auto/Local Core/Chrome hotfix overlays which an unreviewed npm upgrade could erase.

## Implemented
- Official HTTPS npmjs stable package/version metadata only, including sha512 integrity metadata; bounded response, timeout and 6-hour cache, no prerelease/downgrade.
- Settings > General > Pembaruan Switchboard displays installed/published version and Check update. Newer stable release can be installed without typing npm commands.
- Optional auto-install for new published versions, OFF by default; explicit user opt-in stored under LOCALAPPDATA/BotConnector/SwitchboardUpdater/settings.json; no automatic restart.
- Pinned package name/version, Node running npm-cli.js without shell, ignore lifecycle scripts, re-check final installed package version.
- No arbitrary URLs, packages, registry or untrusted Origin accepted through update APIs.
- Portable/dev checkout installation disabled. Chrome extension update unchanged.
- Source: src/services/switchboard-updates.ts, src/plugins/web.ts, web/app.js, web/settings.css, README.md.
- Test sources: test/test-switchboard-updates.mjs and test/test-switchboard-update-ui-windows.mjs.

## Evidence
Typecheck, build, full npm test: PASS (exit 0).
Semver, errors/offline, cache, dev/portable safeguard, preference persistence: PASS in isolated tests (no real npm installation).
Visible Chrome for Testing desktop 1365 and mobile 390: PASS, Settings buttons, version 0.4.1 vs fake newer 0.4.2, responsive. Screenshot location: TEMP/sbx-update-ui-3095eq/screens.
API: same-origin localhost guard, cross-origin POST denied, nonboolean opt-in rejected.
Installed global Switchboard v0.4.2, PID 48580, Chrome companion Connected and Skip mode remain unchanged; no npm publish, restart, or VPS edits performed for this feature.

## Outstanding release gate
Real npm global upgrade v0.4.2 to a higher newly-published version has NOT been tested: no newer release exists. The beta checkout must first be rebased/consolidated with all production hotfixes, version bumped above v0.4.2, reviewed and published only with owner approval. Then canary on disposable Windows npm global installation should prove upgrade success, config/models/session preservation, safe restart and rollback on install failure. Do not label production-ready or claim full end-to-end success yet.

## Reference comparison
Chrome extension auto-update: browser-managed, unchanged (MATCH).
Desktop app update detection: official stable release checks (PASS in actual Chrome with npm metadata fixture).
Auto install/activation: opt-in background install, delayed restart (CONTRACT PASS, real version upgrade NOT YET VERIFIED).
Portable installation: installer deliberately refuses global npm update (PASS).
