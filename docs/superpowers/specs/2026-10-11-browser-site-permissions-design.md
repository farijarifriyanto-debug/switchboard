# Browser Site Permissions Design

## Goal

Make Switchboard Browser Companion site access predictable and less repetitive, with parity to the documented Claude in Chrome permission model where it fits Chrome's extension API. The user approved this direction: Chrome host permissions are the sole source of truth for site access; remove Switchboard's persistent and one-time site allowlists; keep tool/action approval governed by Manual/Auto policy.

## Current findings

- `manifest.json` declares `<all_urls>` as a required host permission, so Chrome grants broad site access at installation.
- `background.js` nevertheless decides site access from `approvedOrigins` and `oneTimeOrigins`; the Chrome permission API is not actually used as the source of truth.
- The panel's site buttons only send local approval messages. `allowSiteFromClick()` does not call `chrome.permissions.request()` despite its comments.
- Panel status and revoke also use `approvedOrigins`, so displayed status can differ from Chrome's actual host grant.
- `permissionMode` currently forces more site prompts for typing, downloads, and authorization-like clicks. This conflates site access with action approval.
- A separate Switchboard tool approval system already controls tool calls. It remains responsible for action approval; it must not be duplicated as another site grant.

## Reference and constraints

The acceptance reference is the official Claude in Chrome permission guide and Chrome's official optional-host-permission API documentation. Claude documents Manual/Auto/Skip action policies and site choices to allow one action, always allow a site, or deny. Chrome requires `permissions.request()` to be called from a user gesture. The implementation will use Chrome's native host permission state for site access and will not copy proprietary code or assets.

The repository's global instructions require a single source of truth for website permissions in Chrome; Manual/Auto are action policies, not a second site-authorization gate. The original Claude UI in the user's Chrome has not been directly inspected, so UI-level parity remains to be confirmed during real Chrome comparison.

## Approaches considered

1. **Optional per-origin Chrome permissions (recommended).** Declare site hosts as optional, request a host grant from an explicit panel click, use `permissions.contains()` for every access/status check, and use `permissions.remove()` for revoke. Remove local persistent and one-call grants. This matches Chrome's permission model and the repository's single-source rule.
2. **Keep required `<all_urls>` and remove only the local allowlist.** This eliminates repeated site prompts, but requests broad site access at install and gives the user no per-site Chrome control. It is simpler but conflicts with least-privilege expectations and the reference's site-level choices.
3. **Keep the local Switchboard allowlist alongside Chrome grants.** This can imitate one-time and persistent buttons in the UI, but preserves two sources of truth and the current mismatch. Rejected.

## Design

### Site permission state

- Move `<all_urls>` from `host_permissions` to `optional_host_permissions`; keep localhost origins needed for the local bridge and onboarding content script as required permissions.
- Add one helper that converts a validated HTTP(S) origin to a host pattern and checks it with `chrome.permissions.contains()`.
- All access checks, current-site status, granted-origin synchronization, and revoke controls read Chrome permission state. No authorization decision may read `approvedOrigins` or an in-memory one-time grant.
- On an ungranted site, browser work waits and the side panel identifies the origin and offers a user-gesture button that calls `chrome.permissions.request()` directly. A successful Chrome grant resumes pending work. Denial or cancellation rejects the pending work with a clear message.
- Replace local “allow once” with the native site grant flow. A site grant persists until the user revokes it through the companion or Chrome's site/extension settings. This avoids a local temporary state that Chrome cannot display or revoke consistently.
- Revoke calls `chrome.permissions.remove()` for the origin. Chrome `onAdded`/`onRemoved` events refresh state and status; losing a grant during a pending operation stops that operation safely.
- Legacy `approvedOrigins` data is ignored and may be cleared as stale metadata; it never restores a Chrome grant.

### Action approvals and modes

- Remove site-gating behavior based on `permissionMode`, including forced site prompts for typing, downloads, and authorization-like clicks. The site grant is checked once per origin through Chrome.
- Keep existing Switchboard tool/action approval behavior and Manual/Auto/Skip policy. Sensitive actions retain their existing explicit approval or block rules. Changing a site grant must not silently approve a tool action, and approving an action must not create a site grant.
- Remove or correct panel copy that describes local site approval or an “allow this action” site grant. Keep an explicit deny control for rejecting a pending site request.

### State synchronization and errors

- `syncBrowserState()` reports only Chrome-granted origins, derived from the active origin and any existing host-permission enumeration; it does not merge local approval metadata.
- Active-tab changes may update status context, but do not change the permission decision for the agent's bound tab.
- Restricted URLs, malformed origins, unavailable permission APIs, user denial, Chrome cancellation, and mid-operation revocation return concise errors and do not execute browser actions.
- Bridge calls already approved by Switchboard continue to bypass any duplicate site prompt only when Chrome confirms the required host permission. They may not bypass the native grant check.

## Files and interfaces

- `browser-extension/manifest.json`: optional host permission declaration.
- `browser-extension/background.js`: Chrome-based access helper, native permission request/revoke message handling, permission-change listeners, and site/action separation.
- `browser-extension/panel.js` and `panel.html`: native grant button, Chrome-backed status/revoke, and corrected site-request copy.
- `test/test-browser-native-permission.mjs`: mock Chrome Permissions API and cover request, persistent grant, revoke, denial, and separation from action approvals.

Existing `src/plugins/web.ts` model-selection changes and agent-tab binding are unrelated and must be preserved. Real Chrome tests must cover granting, denial, revoke, reconnect, browser action execution, and switching the user's active tab while an agent tab remains bound.

## Acceptance criteria

1. No site authorization path depends on `approvedOrigins` or `oneTimeOrigins`.
2. A site is accessible only when Chrome reports the matching optional host permission.
3. The extension asks through one Chrome-native per-origin permission request initiated by a user gesture; a persistent grant removes repeated site prompts until revoked.
4. Site permission and tool/action approval are independent: neither grants the other.
5. Revoking in Switchboard or Chrome removes access immediately for subsequent actions, and pending actions fail clearly.
6. VM tests verify the permission API contract; the final acceptance test uses the user's real Chrome extension and checks that changing the active user tab does not redirect the agent.
7. Compare the implemented flow to official Claude in Chrome docs and the real UI where available using the repository's required feature matrix. Any unverified UI detail remains marked unverified; no unapproved diff is reported as a pass.

## Explicit non-goals

- Changing Switchboard's web tool approval defaults or provider/model settings.
- Changing agent-tab binding, navigation, or form interaction except where permission checks are required for safe execution.
- Pushing, publishing, or changing PR #22 status.
