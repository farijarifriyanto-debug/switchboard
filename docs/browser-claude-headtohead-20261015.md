# Direct Claude in Chrome vs Switchboard — read-only QA parity

Date: 15 October 2026. Scope: authorized Windows laptop `home`, original Chrome profile only for a benign local test, isolated Chrome for Testing for Switchboard. No VPS, production deployment, model downloads, or Chrome Web Store release.

## Reference and limitations

Original installed Claude in Chrome: MV3 version 1.0.100, opened using the normal Chrome Extensions toolbar **Claude** action, which correctly revealed its actual side panel (not an unsupported standalone `sidepanel.html` tab). The owner had already signed in. The real panel exposed `Tulis prompt Anda ke Claude` and `Mulai tugas`.

The only Claude account request was this non-mutating QA prompt:

> Pada tab halaman uji lokal ini, sebutkan persis teks judul H1 dan label tombol yang terlihat. Jangan mengklik, mengetik di halaman, membuka tab lain, atau mengubah situs. Jawab: Judul: ... ; Tombol: ...

The fixture was local loopback HTTP with page `<title>Claude Switchboard parity fixture</title>`, visible `<h1>QA-BICO-731</h1>`, and one `<button>Ready</button>`. It contains no account data, credentials or personal content.

## Independent observed results

| Product/test | Result | Outcome |
| --- | --- | --- |
| **Original Claude native side panel, signed in** | `Judul: QA-BICO-731 ; Tombol: Ready, Stop Claude` | **PASS for H1 and real button**, with extra irrelevant `Stop Claude` text. The task truly ran in the original native side panel, not an isolated mock. |
| **Switchboard local `botconnector-fast` before semantic fix** | `Judul: Claude Switchboard parity fixture; Tombol: QA-BICO-731` | **FAIL**: misidentified browser tab `document.title` as the H1 and heading as a button. |
| **Switchboard local `botconnector-fast` after semantic fix**, actual Browser Companion and side panel in visible Chrome for Testing | `Judul: QA-BICO-731; Tombol: Ready` | **PASS**: independent Chrome CDP check confirms exact H1 `QA-BICO-731` and button `Ready`; terminal panel status `Completed.`, 46.21 s, zero action approvals for read-only fixture. |

**Root cause fixed:** `capturePage` returned flat page text and interactive labels, but the preflight projection discarded the labels and carried no semantic heading levels. The model could not distinguish `<h1>` from `document.title` or button text. The fix adds a bounded list of visible HTML heading levels in the *same* native Chrome-granted DOM capture and includes heading labels plus non-sensitive control labels **inside the existing `browserSafety.screenPage` pipeline**. No raw site text bypasses Auto screening; password/payment/file input values remain protected. One DOM snapshot still consumes only one native Allow-once grant.

Regression: `test/test-browser-companion.mjs` asserts H1/control semantics reach safety screening while sensitive input values and URL token parameters do not. `test/test-browser-claude-parity-readonly.mjs` is an opt-in headed Chrome + real local Qwen3 acceptance test.

## P0 native host permission boundary

Chrome's real native host-permission popup was observed with **Izinkan** and **Tolak** controls in the Windows accessibility tree. The dedicated QA browser test succeeded when the native `Izinkan` control was explicitly invoked: the queued `browser_dom_snapshot` completed, Chrome removed the one-action permission, the next action prompted again, and `Deny` failed closed. This flow was proved in a prior session and a new session. **An unattended test which does not approve the Chrome permission can and should time out.** Do not bypass Chrome via `Browser.grantPermissions` or a secret auto-grant mechanism. `test/test-browser-site-once-visible.mjs` remains a human-in-loop Chrome acceptance test; the extra OS-control helper was kept out of released product code.

## P1 automatic visual analysis

Earlier real tests on this branch already PASS: user Send in actual Switchboard panel → agent selects `browser_screenshot` → ephemeral JPEG transmitted only on explicit visual user intent to `gemma4:cloud` → `SATURN 42, blue` from a synthetic canvas image → panel `Completed.`. The image was not written to persistent chat history or emitted in tool result events. Inference is Cloud via Ollama, opt-in, not free on-device vision.

## Remaining breadth limitations

The original Claude panel displayed **`Mendekati batas mingguan`** after the test. To preserve the owner's account allowance, no additional Claude tasks were attempted. Direct original-app comparison of click, Stop, cross-site permissions and vision is still **UNVERIFIED**, despite Switchboard's separate real-browser tests for these features. Successful one-task reading comparison does not certify pixel-identical UI, exact latency parity or all original Claude modes.

Changes are restricted to laptop QA and GitHub. PRs remain draft or unmerged pending owner release permission. No production or Store changes.
