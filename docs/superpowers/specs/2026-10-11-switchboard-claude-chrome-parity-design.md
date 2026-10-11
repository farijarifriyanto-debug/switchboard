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
- **Manual** asks before each browser action. When an ungranted site's one-action Chrome grant is the user's explicit choice for the pending action, it can satisfy that action's ordinary Manual approval; it does not waive protected-action confirmation.
- **Auto** is the side-panel default. Routine read/navigation/form actions proceed without an approval interruption after site access is granted. A browser preflight classifies protected actions using page metadata without reading or logging field values; potentially sensitive input, downloads, authorization/permission changes, and other high-impact actions pause for explicit approval.
- **Skip** bypasses routine approval prompts, but hard safety blocks and protected-action confirmation remain as required by the repository's safety policy. It never bypasses Chrome site permission.
- The modes are stored in the extension and synchronized to the local companion service. They affect browser-action policy only and do not change approval policy for shell, file, or other tools. Approval records identify the actual browser tool/action and target origin, without full private URLs or typed content.
- Persistent site access never approves an action by itself. An action approval never creates a site grant.

### Agent tab and browser behavior

- Keep a stable agent-owned tab (or explicit set of agent tabs) independent of Chrome's active user tab. Tools without `tabId` use the bound agent target; `browser_tab_select` changes the agent target intentionally. Agent tabs remain identifiable in a Switchboard tab group, and no tool steals focus except an explicit user-visible navigation/open policy.
- A first navigation with no target creates and binds a Switchboard tab. Wait for the target document to finish loading before reporting success or allowing the next read. Errors must never return success with a null result.
- Preserve semantic DOM snapshots, safe click/type/select/scroll/wait/extract, native form events, and accurate post-action verification. Support native inputs, textarea, and contenteditable; block credential/payment fields and prohibited actions with truthful errors.
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
