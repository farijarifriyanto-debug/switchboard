# Switchboard Tasks & direct API-key entry — QA and reference matrix

Date: 2026-10-29. Base: origin/master 85f03c6 (published 0.4.6).
Development worktree: feat/switchboard-tasks-api-key-20261029.
Status: **development only**. No merge, push, npm publish, Chrome Store update or production deploy.

## Reference-first

See `docs/claude-in-chrome-reference-20261011.md` and
`docs/browser-parity-gate-20261011.md`. The original Claude in Chrome
was not exercised side-by-side for this new branch. Existing chat and
permissions are retained; no new site allowlist or new agent approval mode.

The owner explicitly requested user-entered API keys. Switchboard now
accepts keys through a masked field in the Browser Companion, requires
independent one-use consent from the authenticated local Web Console, and
reuses the backend's credential store. This is not a proprietary Claude feature.

## Function / behavior / evidence / status / next step

| Function | Reference / expected behavior | Switchboard change | Evidence | Assessment | Next |
|---|---|---|---|---|---|
| Chat panel | Chat-first, permission inline, Stop visible | Kept existing main panel; added read-only extract-data prompt | `node test/test-browser-tasks-ux.mjs`, existing panel tests | ADAPTASI SETARA in source, live Claude comparison UNVERIFIED | Compare against installed reference on owner laptop before release |
| Own API key | Owner explicitly requests direct side-panel BYOK | Side panel has provider, model and masked API key input; separate one-use authenticated Web Console consent; backend write-only credential store | Real Chrome form + fake-key consent/save + no extension storage, and server security tests; see `2026-10-29-switchboard-sidepanel-byok.md` | **PASS bounded real Chrome** | Verify with a real user-selected provider credential before publishing |
| Workflow recording | Workflow recording available in classic side panel; browser safety must hold | Only explicit agent actions; saves click/scroll/navigate; does not capture typing/password, unknown actions or query strings | `node test/test-browser-tasks-ux.mjs`; real Chrome opt-in test observes a recorded click | PASS for bounded fixture; original application comparison UNVERIFIED | Exercise full workflow in user-visible Chrome |
| Workflow import/export | Imported steps must be reviewable and not execute arbitrary actions | Validates format, size and safe action fields; old stored typed values cannot be exported | Contract + visible Chrome refusal for legacy typed-value export | PASS bounded fixtures | Visual QA of file selection and failure states |
| Workflow replay | Browser state / native permissions must remain authoritative | Replays only limited safe actions; click retry disabled; high-risk selectors and actual button labels are screened after Chrome permission; operator confirms click batch; refuses unbound personal tabs | Real Chrome fixture: Clicks: 1 then Clicks: 2, exactly one replay; contract tests for fail and cancel | PASS limited fixture; original comparison UNVERIFIED | Test deny/revoke, high-risk button labels, and browser Auto mode before release |
| Stop replay | Stop must prevent subsequent steps | Cancel flag tested; cannot undo already in-flight action | Contract test with blocked first action | PASS contract, Chrome UI Stop UNVERIFIED | Real Chrome visible Stop mid-workflow |
| Real AI Cloud | End-to-end must use a real cloud provider and real browser | OpenRouter Qwen 3.8 Flash via isolated backend + Chrome | Five tool steps, three scoped approvals, actual DOM "Clicks: 1", reconnect without duplication; see `2026-10-29-switchboard-cloud-qa.md` | **PASS bounded Cloud E2E** | Live owner-profile and release review still required |

## Commands / evidence

- `npm run typecheck`, `npm run build`, targeted browser bridge/panel/security tests PASS.
- `npm run test:tasks` tests import, recording privacy, cancellation,
  risky-action rejection, non-idempotent click retry, and API-key handoff contract.
- `SBX_TEST_CHROME_PATH=<Chrome for Testing binary> npm run test:tasks:chrome`
  uses an isolated disposable Chrome profile and local HTTP fixture. Real Chrome
  DOM was observed independently: `Clicks: 1` after recorded agent click and
  `Clicks: 2` after one replay. A separate "Pay now" control with a neutral
  selector was rejected without mutating its DOM state. The extension paired
  with a real isolated Switchboard host, opened local `/?settings=models`, and verified the actual
  Models dialog. It rejected a legacy workflow containing typed values.
  The test independently authenticated the Web Console first, with a
  short-lived HttpOnly cookie in the disposable Chrome profile. The
  Browser Companion token was never used for provider credential access.
  No production account, personal API key, model spend or provider was used.

## Code review — two separate axes

**Repository standards:** Existing Chrome-native host permissions, paired
browser token scope, console CSRF/Host fences, and the local write-only
credential API remain the authorities. No second model manager, password
field or provider secret storage is added to the extension. Workflow replay
fails closed for unbound personal tabs and identifiable risky click targets.
The branch follows the existing chat-first surface.

**Requested behavior:** The initial direct API-key shortcut opened Web Console Models. Subsequent
work added a Provider / Model ID / API key form directly in the Chrome side
panel (BotConnector Cloud / OpenRouter / Groq), using a one-time, separately authenticated
Web Console approval. Companion bearer never authorizes generic settings.
The credential is stored by the backend and the extension clears the input. The initial workflow
record/import/replay/Stop and extract-data shortcut are implemented and
tested on bounded fixtures. An additive task-result footer now distinguishes
tool-reported success, failure, cancellation, step limit, and answers without
recorded tool activity; this is **not independent verification of model claims**.
Real AI Cloud browser execution PASS with Qwen 3.8 Flash on bounded fixtures.
Full source-linked Verified Results/CSV, model presence labels, and in-flight
Chrome Stop remain **not implemented/verified**; do not describe as shipped.

The full `npm test` suite exited 0 on the earlier patch of this branch.
After final security refinements, task-specific contracts, settings API/UI,
browser security, TypeScript build, documentation checks and the visible
Chrome acceptance were rerun successfully.

## Release gate

Do not merge/push/deploy/publish by inference. This branch has now passed a
bounded real AI Cloud Chrome E2E; final full-suite regression, owner-profile
acceptance, security/Chrome Store disclosure review and explicit release
authorization are still separate gates. Published 0.4.6 is unchanged.
