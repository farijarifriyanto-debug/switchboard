# Browser Companion — Claude in Chrome functional parity gate

Status: **NO-GO**. Chrome Web Store published 0.4.2 while this audit was underway. Do not submit another version until every critical gate below passes. Do not unpublish the existing item without an explicit rollback decision.

## Scope

“Parity” means a user can give an instruction in the Chrome side panel and the existing connected AI model can complete a legitimate multi-step task in the visible browser, with explicit permission and confirmations, accurate outcomes, recovery, and a verifiable result. It is **not** visual similarity, identical private APIs, bypassing Chrome permissions, or claiming every third-party feature.

## Mandatory acceptance (P0)

1. **Real AI**: authenticated model accepts a new side-panel request and chooses appropriate tools; no mock, no cached replay. Model name and request/session ID logged without secrets.
2. **Browser actual**: developer-mode unpacked build in normal visible Chrome, plus post-store-update test in installed Chrome. Never use headless-only results as final proof.
3. **User-scoped consent**: first use of an unknown HTTPS origin prompts human to approve the *target origin* with native Chrome permissions (no duplicate Switchboard site consent); allow resumes exactly one pending action; deny, timeout and revocation keep the tab unchanged; restricted mode blocks writes.
4. **Read / act / verify**: open botconnector.id, wait for load, confirm correct URL/title/h1 from DOM; click safe navigation; return and verify the new destination. Verify actual page changes, not just tool invocation or an `ok` marker.
5. **Forms**: type and clear native input, textarea, and contenteditable; select options; use real site-like app events; press Enter where appropriate. Sensitive password, financial, and file inputs remain blocked, with a genuine error surfaced to AI.
6. **Multi-tab**: list and select several tabs, preserve a stable target across panel open/close, do not accidentally act on internal extension tab, confirm each tab ID/URL before action.
7. **Errors**: invalid CSS selector, blocked input, missing tab, denied permission, offline bridge, 401 provider, failed navigation and script injection must never be marked successful; be recoverable without false evidence.
8. **Agent workflow**: user task with >=5 independent steps, one intentional partial failure, a retry, and a user-visible final answer grounded in browser observations. No unexpected payment, login, sending, or destructive action.
9. **Stop & recovery**: user Stop cancels backend and no subsequent browser writes; Chrome panel close/reopen and bridge reconnect do not duplicate actions or lose permission state.
10. **Screenshots and vision**: browser-authorized screen capture works under Chrome's own user gesture/permission requirements and is verified end-to-end with vision-capable AI; impossible requests show a specific user action rather than a false success. No blanket host grants.
11. **Security/privacy**: reject forged origin/token, guard against page prompt injection, protect credential/payment fields and local browser files, audit actions; no sensitive user content in logs.
12. **Latency & UX**: clear state Waiting for permission / Running tool / Recovering / Completed / Failed, actionable feedback, evidence links, obvious model and current tab, accessible controls.

## Findings from the 0.4.2 audit

| Area | Evidence | Gate |
| --- | --- | --- |
| Pairing/WebSocket, DOM, click, scroll, select, extract, wait | PASS in visible Chrome for Testing with unpacked extension | Partial PASS |
| Browser side-panel rendering and streamed fixture answer | PASS using simulated backend stream | Partial PASS |
| Per-site permission request and navigation | PASS in one visible Chrome native-permission run, but later rerun timed out awaiting the prompt | Retest |
| Browser injected action error | 0.4.2 falsely returned `ok:true,result:null` on blocked password field | **NO-GO**; corrected in development branch and real-browser retest |
| Rich text editor | Original editor typing path incorrectly used HTML input setter; basic `contenteditable` works with development patch | Retest on complex editors |
| Screenshot/vision | Screenshot tool says Chrome activeTab user gesture is required; never demonstrated full vision loop | **NO-GO** |
| Provider AI | `sbx doctor` on test checkout returns HTTP 401 / missing `BOTCONNECTOR_API_KEY` | **NO-GO** |
| Install from live Chrome Web Store | v0.4.2 marked `Published - public` in publisher dashboard; not yet tested after actual automatic Chrome profile update | **NO-GO** |
| Real multi-tab long task and abort/reconnect | Not fully proven | **NO-GO** |

## Release conditions

- Version bump and store submission **must be withheld** until all mandatory gates have timestamped evidence from real Chrome and the chosen AI provider. Tests that mock Chrome or the model remain useful unit tests but do not count as end-to-end acceptance.
- Candidate PR must pass typecheck, build, Chrome/Edge packaging, CI on Node 20/22, security regressions, and direct on-machine browser tests.
- QA evidence includes test command, extension version/hash, Chrome build/profile, actual model ID, sanitized tool trace, screenshots for key stages and confirmation that no original Chrome profile data was altered.
- Once all pass, use a **new monotonic extension version** and update the existing Web Store listing (never a duplicate). Set auto-publish only for a fully verified release.
