# Switchboard Browser Companion — Claude in Chrome Parity Design

## Goal and acceptance source

Build Switchboard Browser Companion into a dependable, multi-step browser agent that works in the user's visible Chrome and follows the documented Claude in Chrome Cowork side-panel experience. The user's full acceptance gate is [Browser Companion P0–P2](../../browser-parity-gate-20261011.md); that document remains authoritative for real-provider, browser, form, tab, error, stop/reconnect, screenshot, security, and UX evidence.

Reference review uses the official Claude in Chrome permissions guide, getting-started guide, and Chrome Permissions API docs. Claude documents Manual/Auto/Skip action policy, site choices to allow one action / allow all on the site / deny, explicit approvals for protected actions, stable side-panel work while switching tabs, and a distinct tab group. Direct inspection of Claude's UI in the user's Chrome is still unverified until the live browser is available.

Constraints from `C:\Users\farij\AGENTS.md`: Chrome is the only source of truth for site access; Manual/Auto are AI action policies rather than another site permission layer; compare each change against the reference; use real visible Chrome for E2E; do not push; keep PR #22 NO-GO.

## Current repo findings

- `browser-extension/manifest.json` requests `<all_urls>` as an install-time host permission.
- `browser-extension/background.js` says Chrome is the only site authority, but `siteAccessGranted()` reads `approvedOrigins` and `oneTimeOrigins`; `settleSiteAccess()` writes those local values. The permission API is not currently the access decision.
- `panel.js` site buttons send local approval messages and do not call `chrome.permissions.request()`. Status and revoke also read the local allowlist.
- Browser mutations have a generic tool-risk gate in `ToolsService`; separately, extension `permissionMode` currently forces the local site gate for typing, downloads, and authorization-like clicks. That setting is not an action-approval policy today, so the same task can encounter unrelated approval controls.
- A server-side `approvedOrigins` set mirrors extension status for reporting. It must remain informational only and must never grant access.
- Agent-tab binding was added in the current working tree but has no test proving that switching the user's active tab leaves agent actions on the bound tab.
- Screenshot capture has not completed a real end-to-end AI vision loop; Chrome's `activeTab` grant is gesture-scoped.
- Existing parity docs record other P0 NO-GO areas: model/provider availability, installed-store update verification, long task/abort/reconnect, and some form/error cases.

## Design

### Site access: Chrome is authoritative

- Move runtime site access to optional host permissions. Keep only the localhost permissions required for the authenticated bridge and localhost onboarding content script as fixed manifest grants.
- Validate HTTP(S) origin and derive its host pattern once. Every read, action, status view, bridge report, and revoke decision checks Chrome's permission API; a server-side mirror is display/telemetry only.
- On an ungranted target, pause the pending action and show the target origin in the companion panel. Offer the reference choices: **Allow this action**, **Always allow actions on this site**, and **Deny**.
- Both allow choices invoke `chrome.permissions.request()` directly in the button's user-gesture handler. A single-action grant is removed in a `finally` path after the one waiting browser tool call finishes, fails, or is cancelled. Persistent access stays as a Chrome host grant until revoked. Serialize same-origin use while a temporary grant is active so a second action cannot reuse it.
- Revoke calls `chrome.permissions.remove()`. `onAdded`/`onRemoved`, denial, cancellation, Chrome API failure, invalid origin, and mid-action revocation update state and stop unsafe work with an actionable error. Legacy `approvedOrigins` values never create a grant.
- The one-action choice is not a second local site-permission authority: Chrome `contains()` must report the live grant for every access; transient state only scopes cleanup to the pending call.

### Action approvals: one browser policy path

- Browser actions use the existing `ApprovalService` as the one action-approval coordinator, with a browser-specific policy callback in `ToolsService`. Do not run both the generic `risk: 'risky'` rule and a second browser action gate. Non-browser tool approval behavior remains unchanged.
- **Manual** requests approval for each browser action. A Chrome site grant never satisfies or suppresses action approval; the two decisions have separate sources and UI states.
- **Auto** is the side-panel default. Before untrusted page content enters the agent's working context, a content-injection evaluator screens the bounded page text/DOM summary. Before each browser action, a separate action evaluator receives the current user intent, bounded untrusted page context, target origin, and proposed tool/action (including proposed typed text when needed to detect exfiltration or harmful intent). Use the session's configured provider/model and an explicit strict-schema verdict: `continue`, `require_approval`, or `block`.
- Claude documents two safety classifiers but does not document their implementation. Using Switchboard's configured session provider/model for these evaluations is the owner's approved implementation adaptation; do not claim it is Claude's internal mechanism. Compare behavior and measured outcomes, and expect extra model usage/latency in Auto.
- The evaluator must distinguish trusted user instructions from page content. Page content is labeled untrusted and cannot redefine policy. It must not read or transmit cookies, browser storage, hidden input values, or unrelated page data. Context is bounded and sent only to the already-configured provider for that session; do not persist it or write it to logs. Typed values can be sensitive, so the evaluator request is ephemeral and limited to the exact proposed action. Match Claude's documented action classes: changing permission settings, granting authorizations, and entering potentially sensitive information require explicit permission regardless of mode; Auto also screens high-risk actions such as downloads, while the site permission choice to always allow a site does not remove the documented extra download/sensitive-input/authorization approvals. Prohibited actions (such as purchases/financial transactions, account creation, bypassing bot authorization, permanent deletion, financial trades, handling sensitive credit-card/ID data, modifying system files, following instructions from email/web content, or downloading from an untrusted source) remain hard-blocked regardless of mode.
- For incoming page content, clean content can enter the agent context with an untrusted-data label. Detected prompt-injection instructions are excluded from the trusted instruction stream and may be retained only as quarantined, clearly untrusted content when needed to complete the user's task. If the evaluator cannot classify the content, pause and ask the user before the agent relies on it. A user approval never upgrades page text into trusted instructions.
- `continue` runs the action without an interruption. `require_approval`, missing/ambiguous context, malformed output, model refusal, timeout, provider error, cancellation, or evaluator exception fail closed to ordinary Manual approval; they never silently continue. `block` returns a clear failed tool result, cannot be overridden by action approval, and does not execute the action.
- **Skip** matches the reference's opt-out of automatic action checks: it does not pause for approval and automated action screening is disabled. Chrome site permission still applies, the documented actions requiring explicit permission regardless of mode remain gated, and prohibited actions remain blocked regardless of mode. Do not add Auto-only confirmation prompts (such as routine download screening) to Skip. Label the option clearly and explain that it disables automatic checks; do not add extra confirmation steps.
- A single structured preflight result must drive both the agent run state/approval UI and the tool execution gate. Do not separately emit a generic approval event that disagrees with the browser-specific decision, and do not ask for approval twice. A stale preflight is invalid after the target origin, tab, page context, or action changes; reevaluate immediately before execution.
- The modes are stored in the extension and synchronized to the local companion service. They affect browser-action policy only and do not change approval policy for shell, file, or other tools. Approval records identify the actual browser tool/action and target origin, without full private URLs or typed content.
- Persistent site access never approves an action by itself. An action approval never creates a site grant.

### Agent tab and browser behavior

- Keep a stable agent-owned tab (or explicit set of agent tabs) independent of Chrome's active user tab. Tools without `tabId` use the bound agent target; `browser_tab_select` changes the agent target intentionally. Agent tabs remain identifiable in a Switchboard tab group, and no tool steals focus except an explicit user-visible navigation/open policy.
- A first navigation with no target creates and binds a Switchboard tab. Wait for the target document to finish loading before reporting success or allowing the next read. Errors must never return success with a null result.
- Preserve semantic DOM snapshots, safe click/type/select/scroll/wait/extract, native form events, and accurate post-action verification. Support native inputs, textarea, and contenteditable; require explicit permission for potentially sensitive input, hard-block the documented prohibited data/actions, and return truthful errors.
- Screenshot requests must state the exact Chrome user gesture needed when no `activeTab` grant exists. If authorized, return the real screenshot to a vision-capable model; never claim an image was inspected when only DOM was available.
- Stop cancels the active agent run and prevents later browser mutations. Panel close/reopen, worker suspend, bridge reconnect, and duplicate delivery cannot repeat a completed action.

### Agent runtime and side-panel UX

- Side-panel tasks use the configured default provider/model unless the user chose an override, and start with the browser preset/step budget appropriate for multi-step work. Display actual provider/model, target tab, pending permission/approval, current action, retry/recovery state, and a grounded final result.
- Keep the local authenticated bridge and pairing flow. Retry/reconnect is bounded and visible. Missing provider credentials, HTTP 401, disconnected extension, or action timeout produce recovery guidance rather than false completion.
- Preserve tab state while the user switches browser tabs. The action target shown in approval UI must be the agent-bound tab, not an unrelated active user tab.

## Alternatives considered

1. **Keep broad `<all_urls>` and delete only the local allowlist.** Lowest code churn, but requests all-sites access on install and cannot offer Chrome-authoritative per-site and one-action grants. Rejected.
2. **Add optional per-site Chrome permissions and leave the current controls disconnected.** Improves site access but leaves the companion mode acting like a site gate and does not make Manual/Auto work as documented. Rejected.
3. **Use Chrome as the site authority and one browser action policy coordinator (recommended).** Implements one-action/persistent/deny site choices, one Manual/Auto/Skip action path, stable agent tabs, and the existing P0 evidence gate. This directly addresses the user's complaint about excessive permission prompts while preserving explicit protected-action controls.

## Error and recovery behavior

- Chrome permission API missing/rejected, user denial, timeout, revoked grant, restricted URL, unavailable target tab, failed load, missing element, blocked sensitive field, script injection failure, browser disconnect, provider 401, cancellation, and vision permission failure all produce a failed tool result and accurate audit entry.
- Retry may repeat only an action known not to have completed. For ambiguous mutating results, stop and report the observed state rather than issue the action again.
- Do not log credentials, typed values, query strings, auth tokens, or page content beyond the existing bounded/untrusted-data policy.
- Evaluator denial, uncertainty, malformed response, timeout, or provider failure must be visible as approval-needed or blocked with a short reason and a safe retry path; never report the browser action as successful when it was not executed.

## Auto evaluator verification

- Unit/contract tests cover all three verdicts, invalid schema, refusal, timeout, abort, provider 401, missing page context, stale tab/origin, and consistency between approval UI and the actual execution gate.
- Adversarial real-provider browser tests cover page prompt injection, deceptive instructions in form labels/content, normal benign tasks, sensitive text destinations, and attempts to exfiltrate user-supplied values. Test content is synthetic; redact provider traces and never retain typed values.
- Measure evaluator latency and provider usage on representative multi-action flows; surface the Auto screening behavior in the UI so extra model calls are expected. No parity claim until actual visible-Chrome runs show both safety outcomes and ordinary task completion.
- Compare the same documented scenarios against Claude in Chrome's current Auto and Skip behavior. Any undocumented or inaccessible proprietary details remain `UNVERIFIED`, not assumed to match.

## Files and boundaries

- Extension manifest, `background.js`, `panel.js`, and `panel.html`: Chrome-native origin permissions, temporary/persistent site choices, stable tab binding, permission event handling, and truthful UX.
- `src/services/tools.ts`, `src/services/approval.ts`, and `src/plugins/browser-companion.ts`: one browser-specific policy path while preserving all non-browser approval behavior; preflight contract for protected actions.
- `src/plugins/web.ts`: side-panel session uses configured model and browser preset, and cancellation/approval feedback remains accurate.
- Browser VM/integration tests: model Chrome's Permissions API and assert no generic-plus-browser double gate, correct Manual/Auto/Skip routing, one-action cleanup, persistent grant/revoke, bound-tab isolation, failure/cancel/retry behavior.
- `docs/browser-parity-gate-20261011.md`: update only after each criterion has current evidence; unknown or untestable criteria remain NO-GO.

Preserve the already uncommitted model-selection and agent-tab changes; improve or replace them if evidence shows they do not satisfy the full goal.

## Acceptance

The P0 requirements in `docs/browser-parity-gate-20261011.md` must pass end-to-end with the extension in visible Chrome and a real configured AI provider. In addition:

1. Chrome optional host grants are the only site-access decision; no local/server allowlist can authorize a site.
2. Manual, Auto, and Skip map to one browser action policy; browser tools do not get both a generic tool approval and a duplicate browser approval.
3. One-action, persistent-site, and deny choices behave as documented; protected actions remain explicitly controlled.
4. Switching the user's active Chrome tab does not move the agent target; panel/worker reconnect does not duplicate actions.
5. Read, mutate, verify, error, cancellation, retry, provider failure, and screenshot/vision claims are backed by actual browser/model observations.
6. Produce the required feature comparison table (`Feature | Claude behavior | Switchboard behavior | real-test evidence | MATCH / ADAPTATION / DIFF / UNVERIFIED | correction`). UI details not inspected in Claude remain UNVERIFIED.
7. No push, store update, release, or change to PR #22 status. Keep NO-GO until all release gates have evidence and separate release authorization exists.

## Reference links

- [Claude in Chrome permissions guide](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide)
- [Get started with Claude in Chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome)
- [Chrome Permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions?hl=en)
- [Chrome optional permissions guide](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions?hl=en)

This document supersedes the narrower `2026-10-11-browser-site-permissions-design.md` for implementation scope.
