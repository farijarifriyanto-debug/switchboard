# Trust and Release-Gate Remediation Plan

> **For agentic workers:** Implement task-by-task with the test written first. Keep the existing Claude in Chrome parity gate; this plan hardens security and documentation, it does not redesign the browser UX.

**Goal:** Close the six P0/P1 gaps from the 2026-10-18 audit: reconcile local git with the published 0.4.4 line, make local CI opt-in and sandboxed, scope the browser companion token, remove the trace traversal, fail closed on unattended shell automations, and make release docs consistent.

**Base:** `origin/master` at `c636b00` (v0.4.4). Local 0.1.0 is archived as `archive/local-0.1.0-20261018` and tag `local-0.1.0-archive-20261018`; only this security branch continues.

**Source version:** `0.4.5` (unpublished). Chrome Web Store remains `0.4.4` until an owner-authorized release.

## Global Constraints

- Do not merge unrelated histories, force-push release tags, publish npm, or submit a Web Store update.
- Keep Chrome host permission as the only site-access gate; modes govern agent-action approval, not site access.
- Fail closed on missing/invalid auth, unsafe trace keys, unsandboxed workflow execution when a sandbox is configured, and unattended shell/credential presets.
- Every behavior change gets a regression test. Run `npm run typecheck`, `npm run build`, and the full `npm test` before reporting.
- Real Chrome/provider E2E is still required for browser UX claims; this plan only claims the automated security checks it actually runs.

---

### Task 1: Git reconciliation and isolated worktree

**Files:** repository metadata only.

- [x] Archive local `0.1.0` (`84c17d9`) as `archive/local-0.1.0-20261018` and `local-0.1.0-archive-20261018`.
- [x] Create worktree `switchboard-fix-20261018` on `fix/trust-release-gates-20261018` from `origin/master`.
- [x] After verification, reset the main checkout `master` to `origin/master`, fast-forward it to the feature branch, and remove the temporary worktree.
- [x] Inspect local-only commits/files and port only genuinely unique work; do not merge histories. Audit result: the only local-only files are seven dated historical plan/review docs; every feature area already exists in `origin/master`, so nothing functional needed porting.

### Task 2: Trace path traversal

**Files:** Modify `src/services/trace.ts`; create `scripts/test-trace.mjs`; add the test to `npm test`.

- [x] Write a failing regression: `list('../../escape')` returns no entries, `flush()` after recording an unsafe session id writes no file outside the trace directory, and a valid session id still persists/hydrates.
- [x] Add a single `safeTraceKey` guard used by `list`, `hydrate/loadKey`, and `flush`. Accept only `[A-Za-z0-9._-]{1,128}` and reject `.`/`..`/`..` segments.
- [x] Re-run the focused test.

### Task 3: Local CI trust, environment, and sandbox

**Files:** Modify `src/config.ts`, `src/ci/runner.ts`, `src/ci/index.ts`, `src/cli.ts`, `src/plugins/web.ts`, `src/services/sandbox.ts`, `switchboard.config.jsonc`; create `src/ci/trust.ts`; update `scripts/test-ci.mjs`, `scripts/test-sandbox.mjs`.

- [x] Add failing tests: CI is disabled by default; an enabled but untrusted root refuses to run (no TTY path); a parent secret is absent from a step unless `ci.envAllowlist` names it; `buildSandboxCommand` receives the step workdir/env.
- [x] Add `ci.trust`, `ci.envAllowlist`, and `ci.sandbox` config. Default `ci.enabled` is false; the shipped config sets it to false.
- [x] Add `src/ci/trust.ts` with a per-root trust file (`~/.switchboard/ci-trust.json`, mode 0600) and `ci.trust: true` override.
- [x] CLI: listing is allowed; execution prompts once on a TTY and records trust; non-TTY refuses with instructions.
- [x] Web: only expose/run CI when enabled and trusted; pass env allowlist and sandbox options to manual and scheduled runs.
- [x] Runner: replace `...process.env` with a documented base allowlist plus configured names; keep explicit workflow/job/step env precedence; run each step through `buildSandboxCommand` when configured; kill the container on timeout/cancel; fail closed if the sandbox probe fails.
- [x] Sandbox builder: accept `workdir` and explicit `env`; no parent environment leak.
- [x] Re-run focused tests.

### Task 4: Unattended automation preset guard

**Files:** Modify `src/services/automations.ts`, `README.md`, `scripts/test-automations.mjs`.

- [x] Add failing tests: creating/updating an automation with `preset: 'default'` or a shell/credential/MCP-capable preset is rejected without `allowUnattended: true`; the same automation is accepted with the flag; existing unsafe items fail closed at run time.
- [x] Persist `allowUnattended` and enforce it in create/update and in `execute` (so old JSON cannot bypass).
- [x] Keep `reviewer` and `browser` presets allowed; document the exception and the flag.

### Task 5: Browser companion auth, mode, selector, screenshots, pairing

**Files:** Modify `src/plugins/browser-companion.ts`, `src/plugins/web.ts`, `browser-extension/background.js`, `browser-extension/panel.js`, `browser-extension/panel.html` if needed; update `test/test-browser-companion.mjs`, `test/test-browser-background-ws.mjs`, `test/test-browser-security.mjs`, `test/test-browser-panel-chat-auth.mjs`, `test/test-browser-native-pair.mjs`, `scripts/test-web-companion-startup.mjs`; create `test/helpers/pair-client.mjs`.

- [x] Add failing tests for: empty companion token never authorizes; companion token cannot read the full `/api/state`, cannot start non-browser chat, and cannot settle non-browser approvals; mutating browser tools reject arbitrary CSS not present in the snapshot; screenshots require approval in every mode; mode changes are server-authoritative; pairing requires mutual challenge-response and never returns the token in plaintext.
- [x] Token: trim/reject empty configured tokens; compare with `secretsMatch`; require a non-empty paired token on every companion fence.
- [x] Scope: companion `/api/state` returns only browser state/approvals/browser sessions; `/api/chat` forces/validates the `browser` preset and a browser session; run cancel and approval decisions are restricted to browser sessions/tools.
- [x] Mode: server owns mode. Extension reports state without mode; changes go through an authenticated `/api/browser-companion/mode`; the panel reflects the server value.
- [x] Selector: mutating tools require an element `ref` or the exact selector emitted by `browser_dom_snapshot`; a selector not present in the snapshot is blocked. Update tool descriptions.
- [x] Screenshot: add to the always-confirm set with a clear reason.
- [x] Pairing: `POST /pair/challenge` issues a nonce + HMAC server proof; `POST /pair` verifies the client HMAC, consumes the code once, and returns the code-derived AES-GCM-encrypted token. Token pairing returns no token body. Legacy plaintext pairing is rejected.
- [x] Extension: implement WebCrypto HMAC/AES-GCM helpers, use them for code and native-host token pairing, and store only the decrypted token/mode.
- [x] Re-run focused browser tests.

### Task 6: Documentation single source

**Files:** Create `docs/release-status.md`; create `scripts/test-docs-consistency.mjs`; update `README.md`, `browser-extension/README.md`, `browser-extension/STORE-SUBMISSION.md`, `browser-extension/RELEASE-0.4.4.md`, `AGENTS.md`, `src/config.ts` comment, `src/services/presets.ts`, `switchboard.config.jsonc`, `package.json`/lock and `browser-extension/manifest.json` version to `0.4.5`.

- [x] Add a failing consistency test: package and manifest versions match; release-status source line matches them; current docs contain no stale `0.4.2`/`0.4.3`/`13 browser`/`no authentication` claims; extension README lists every manifest permission; README and extension README use the current browser tool count.
- [x] Write `docs/release-status.md` as the single status table: npm source/unpublished, Chrome Web Store published version, Edge unverified, date verified.
- [x] Rewrite the README browser section for the shipped Browser Companion (not Playwright MCP), its 17 tools, Chrome-only site permission, modes, screenshots/downloads, and auth.
- [x] Fix the web console auth text, CI trust/env/sandbox docs, automation flag, preset description, AGENTS release gate, and extension docs.
- [x] Add `test:docs` to the `npm test` chain.

### Task 7: Verification and reconciliation

- [x] `npm run typecheck`
- [x] `npm run build`
- [x] `npm test` (Windows; note skipped real Chrome/sandbox probes honestly)
- [x] Focused real-browser checks if the environment permits; otherwise mark browser E2E `BELUM TERVERIFIKASI`.
- [x] Reset main `master` to `origin/master`, fast-forward to the feature branch, remove the temporary worktree, and leave both archive refs intact.
- [x] Report PASS/FAIL per item, commands and evidence, and the remaining release gate.

---

## Verification log (2026-10-18, Windows)

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm test` (full Windows chain) | exit 0 — `recovery: OK`, `trace: OK`, `docs: OK` |
| `node test/test-browser-panel-terminal-visible.mjs` (Chrome for Testing 155.0.8059.79, simulated provider) | PASS |
| `node test/test-browser-panel-real-ai-e2e.mjs` (same Chrome, real model `botconnector-fast:latest`) | PASS — real click, `Clicks: 1`, 2 approvals, `Completed.` |

- Local-only audit: comparing trees, the only files unique to local 0.1.0 are seven dated
  historical plan/review docs; every feature area is present in the published line, so nothing
  functional needed porting. Archive refs `archive/local-0.1.0-20261018` and
  `local-0.1.0-archive-20261018` keep the old line.
- Two pre-existing Windows flakes blocked a green suite and were fixed: session checkpoints retry
  an atomic rename that Windows can reject with `EPERM` while a reader has the file open
  (`src/services/session.ts`; 20/20 recovery runs after the fix), and `test-ci` now awaits its
  persistence observations instead of sleeping 100 ms (20/20).
- Limits: the real-model browser test previously needed an isolated copy of the extension because
  the panel hardcoded 7777. Fixed on 2026-10-18: the paired server advertises its console origin
  and the panel follows it (`docs/superpowers/plans/2026-10-18-panel-web-origin-discovery.md`);
  the E2E now runs the unmodified extension against a dynamic port. Store-installed 0.4.5, Edge, a
  real HTTPS site-grant prompt, and every historical Claude in Chrome parity scenario remain
  unverified.
- Release gate stays closed: no npm publish, no Web Store submission, no push was made; local
  `master` was moved to `ac64823` and the temporary worktree removed.
