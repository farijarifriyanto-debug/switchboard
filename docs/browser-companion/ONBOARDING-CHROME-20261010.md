# Switchboard Browser Companion — Chrome installation onboarding evidence

**Date:** 10 October 2026 WIB
**Branch:** feat/browser-companion-store-onboarding
**Machine:** Windows laptop; isolated Chrome for Testing profiles; local Switchboard API, without using a mock browser-extension transport.

## Real installed-extension E2E — PASS

A fresh isolated Chrome profile loaded the actual unpacked Browser Companion candidate. The Web UI on http://127.0.0.1:7896 showed the Browser preset and correctly detected Companion.

1. Browser preset selected → installation status **Pairing needed**.
2. Open Companion from the Web UI → Chrome opened the extension-owned connection tab.
3. Copy pairing code (Web UI tab focused) → browser clipboard API returned **Code copied**.
4. Enter the one-use code in the extension connection UI → **Connected**, pairing input cleared.
5. Close the extension tab → authenticated background WebSocket remained connected.
6. Switchboard Web UI updated to **Connected**, without keeping Companion open.

The code and authenticated pairing token are deliberately excluded from the machine-readable evidence, screenshots and this report.

## Fresh Chrome without extension — PASS

A separate isolated Chrome profile with extension loading disabled opened the same local Web UI, selected Browser, and showed:

- **Not detected**
- No Open Companion or Copy pairing code controls
- Manual preview link (the official Chrome Web Store / Edge Add-ons listing is not yet available)
- No invented marketplace URL

This validates installation detection from the **current browser**, independently from Switchboard server status. The cross-browser **Connected elsewhere** state is covered by the frontend branch logic and regression tests; a simultaneous live two-browser takeover test is not included in this report.

## Evidence

- [Installed, pairing needed](./onboarding-chrome-pairing-needed.png)
- [Paired, companion panel closed](./onboarding-chrome-connected.png)
- [Fresh Chrome without extension](./onboarding-chrome-not-installed.png)
- [Machine-checkable paired E2E result](./onboarding-chrome-result.json)
- [Machine-checkable no-extension result](./onboarding-chrome-not-installed.json)

## Scope and release gate

These screenshots are from a harmless local isolated test with a deliberately unavailable AI provider. They verify installation/pairing/connection, **not** a fresh real-AI inference test. Actual Switchboard CLI/Web UI → browser tool → model answer was verified separately in v0.4.0.

Store submission still requires actual Chrome Web Store Developer / Microsoft Edge Add-ons accounts and listing approvals. The new Web UI cannot silently install the extension. No merge to master, npm publish, or external marketplace submission was performed by this onboarding test.
