# Changelog

## Unreleased (Switchboard Tasks / BYOK shortcut; not published)

- Browser Companion opens the existing local Settings → Models provider/API-key form directly. Credentials continue to use Switchboard's write-only local store; no API key is accepted or kept by the extension.
- Add a read-only extract-data prompt shortcut. Preserve the current chat-first panel, native Chrome site permissions, and Manual/Auto/Skip semantics.
- Make workflow recording opt-in for successful agent click, scroll, and navigation actions, without recording typed values or sensitive URL query strings. Safely import/export bounded JSON, cancel replay after the in-flight action, and never retry uncertain clicks. High-risk selectors and actual click labels are screened (after Chrome site permission); replay clicks require an explicit operator review. Replay refuses to take over an unbound personal tab.
- Add repeatable task UX tests and opt-in visible-Chrome acceptance. None of these changes are included in the published 0.4.6.

## 0.4.6

- Stop losing data or the host: a cancelled tool batch now answers every `tool_call` id, an unreadable `automations.json` is never overwritten and one bad schedule cannot exit the process, CI run records are written atomically and privately, and a session larger than the reader limit keeps its newest turns plus a searchable archive instead of vanishing.
- Browser safety: "allow for this session" now applies to the granted tool in that session (screenshots, downloads and page quarantine still ask every time), pre-auth pairing bodies are capped at 64 KB, a quarantined page withholds its title and selectors, and a download is attributed only to the approved tab and origin.
- Report failures instead of faking success: provider timeouts say `request timed out after Ns`, a stream cut before its terminal marker is rejected, an empty model answer fails the run instead of storing a canned sentence, and a workflow with an older running run no longer starts a second copy.
- Chat accepts the four ~5 MB images it documents (body cap raised, oversize mapped to 413).
- Console: status chips and counts meet 4.5:1 in light and dark, the delete button meets the 24×24 target, and the Run trace pane has empty and error states.

## 0.4.5

- Harden local trust boundaries: project-local CI is disabled by default behind an explicit per-project trust decision, runs only a base environment plus `ci.envAllowlist`, and executes steps in the configured sandbox.
- Make the paired browser companion token browser-scoped: it cannot start shell-capable chats, settle non-browser approvals, or change the action mode through extension status updates.
- Require browser selectors to exist in the current snapshot; screenshots and downloads always require explicit approval; pairing uses mutual HMAC challenge-response with AES-GCM token delivery; trace session keys reject path traversal.
- Let the side panel discover the console origin advertised by the paired server (`webOrigin`), so `sbx web --port <n>` keeps Ask, approvals and Stop working without a hardcoded 7777; loopback `http:` origins only, with a visible fallback for older servers.
- Enable CDP focus emulation (`Emulation.setFocusEmulationEnabled`) inside `withDebugger` so `browser_click` and `browser_key` reliably deliver trusted mouse and key events in Chrome and Microsoft Edge even when the bound agent tab is in the background or the browser window is unfocused/occluded on Windows.
- Refuse shell/credential-capable presets in unattended automations unless `allowUnattended: true`; verify documentation and extension manifest versions against `package.json` in tests.

## 0.4.4

- Fix Windows portable startup by resolving the same pinned BotConnector Local Core from either the npm vendor path or the portable sibling local-core folder, without duplicating model managers.
- Add portable smoke checks for Core CLI and model recommendations.


## 0.4.3

- Improve browser Auto safety checks with compact local-model verdicts and fail-closed prompt-injection quarantine; preserve Chrome site permissions.
- Add hardware-informed AI Lokal model recommendations using the original BotConnector Local Core catalog and hardware probes.
- Separate installed GGUF from running GGUF; add explicit Plug/Unplug and launch of original Local Core download/runtime manager without automatic downloads.
- Fix Settings panel navigation clipping on desktop and mobile; suppress inappropriate Browser Companion onboarding banner.
- Add npmjs stable release checks, one-click manual update and opt-in automatic update every six hours, with no forced restart and no silent updates of Windows portable installations.

## 0.4.2

- Bundle the original, pinned BotConnector Local Core in the same @botconnector/switchboard npm installation and Windows portable bundle, with no second model manager and no automatic GGUF downloads.
- Add `sbx local` and `sbx local status` to access the upstream model manager and runtime checks; retain the established `sbx web` entry point.
- Integrate explicitly selected local models into the existing Settings > Models panel, with loopback-only inference and fail-closed safeguards against Cloud fallback.
- Verify Windows native GGUF text inference and initial vision OCR, npm global installation, portable fresh-profile smoke, and Node 20/22 GitHub CI. Model-specific vision accuracy and full browser-agent GGUF parity remain experimental.
- Improve local Core CLI process shutdown and provide npm tarball acceptance tests.

## 0.4.1

- Add an official pinned MCP plugin catalog for Semgrep and OpenSandbox to the existing Switchboard Plugins & MCP panel. Installing, reconnecting, and removal reuse the standard MCP bridge and approval policy.
- Keep manually configured MCP servers authoritative. Explicit local install is required; remote websites cannot silently install tools.
- Prepare a Windows portable bundle including Node and uv/uvx, with checksums and upstream licensing; first-run access uses the existing Switchboard local console.
- Provide local-console handoff through ?plugin=semgrep or ?plugin=opensandbox; hosted OpenSandbox per-user provisioning remains subject to security and capacity gates.

## 0.4.0

- New Chrome/Edge Manifest V3 Browser Companion for Switchboard CLI and Web UI. The agent prompt stays in Switchboard; the extension only executes approved browser actions and returns results.
- Browser tool bridge stays connected in the background after its panel is closed, with authenticated loopback WebSocket, heartbeat, automatic reconnect, and short-lived one-use pairing codes.
- Add 13 browser tools, approved-origin controls, audit logs, password/payment field protection, and browser-specific approval details showing the intended action, last-reported site, and target selector before consent.
- Browser Companion starts automatically from both `sbx chat --preset browser` and `sbx web`. Real-model end-to-end verification with Chrome and Edge on Windows, including Web UI and CLI, is documented under `docs/browser-companion`.
- Package separate Chrome/Edge extension ZIPs with SHA-256 checksums in the GitHub Release. These are development-style unpacked extensions; Chrome Web Store and Edge Add-ons publication are not included.


## 0.3.2

- Documentation only: README status no longer carries the hand-tested list; the package README says the install works.

## 0.3.1

- Channel pairing (`channels.telegram|discord.pairing`): unknown senders get a one-time code, `sbx channels pairing|approve|revoke`.
- `sbx run --json`: JSON Lines events plus a final `result` line on stdout, exit code 1 on failure.
- `/changes` and `/undo [n|force]`: per-session before-images of `write_file`, restore newest first, never overwrite
  a file you edited afterwards (CLI, console composer, `/api/sessions/:id/changes|undo`).
- Fallback chain (`llm.fallbacks`, `llm.fallbackCooldownMs`): a call that fails before any output moves to the next
  provider/model, failing targets cool down, every switch is traced (`llm/fallback`).
- Console: "Browse" button next to "Switch root" lists subfolders (`GET /api/dirs`, fenced like
  the rest of `/api`, hides dotfolders and `node_modules`, drive list on Windows) so a
  workspace can be picked without typing the path.
- Publish GitHub releases and built package/checksum assets independently of npm
  credentials. Skip optional npm publication with a notice when NPM_TOKEN is
  missing, and allow rerunning an existing tag without duplicating releases.

## 0.3.0

- Add read-only `search_memory` for project/global notebook notes with scoped
  snippets, Unicode matching, relevance ranking and configurable all/any matches.
- Search/read unloaded persisted sessions without hydrating them. Live sessions
  override disk copies; malformed, oversized and symlink session files are skipped.

- Preserve MCP structured results via `tools.callResult`; structured-only data
  renders as bounded JSON. Debug logs no longer include structured values.
- Bridge MCP Resources, resource templates, and prompt templates as namespaced
  tools with pagination, cancellation, capability checks, and existing policies.

- Persist background jobs, result delivery receipts and interrupted-wake state
  with parent sessions. Long-running hosts recover queued jobs without repeating
  started work or delivering results twice; normal shutdown preserves queues.
- Serialize strict session checkpoints and refuse dispatch on persistence errors.
  An exclusive recovery owner prevents competing hosts from dispatching jobs.
- Workers use their saved project workspace for filesystem/shell tools.
- Snapshot queued workers' effective model/provider and step budget; route worker
  approval requests to their parent Telegram/Discord chat after restart.
- Publish background batches atomically, release failed wake initialization,
  reclaim dead recovery guards, and include older foreground workers in budgets.
  Wait for channel chat maps before recovery; restricted presets receive no
  notebook prompt projection.
- Process-tree tests distinguish killed Linux zombies from executing processes
  in containers whose PID 1 does not reap orphaned grandchildren.

## 0.2.0

First release prepared for other people to run. Everything below is on `master`; each item was
tested against recording stub model endpoints and, where noted, real tools.

### Safety
- Tool approval defaults to `risky` (was `off`); MCP tools without `readOnlyHint` are gated; the CLI
  asks on the terminal and refuses when nobody can answer; `--yes` / `--approval` opt out.
- Every `/api` route of the console is fenced (loopback Host, same-origin Origin, JSON writes only);
  non-loopback binds require an access token (cookie handshake, Bearer).
- `web_fetch` refuses private/loopback/metadata addresses, re-checks redirects, caps what it reads.
- File tools are confined to the workspace including through symlinks.
- Timeouts and Stop kill the whole process tree, not just the shell.
- Optional sandbox for `run_command`: bubblewrap or docker (no network, no host env, no home).
  Checked against the real tools on Linux.

### Capabilities
- **Presets**: saved system prompt / model / step budget / tool access (with `*` prefix patterns);
  built-ins `default`, `reviewer`, `browser`, `researcher`; `--preset`, console selector, `/api/presets`.
- **Skills**: `SKILL.md` folders, `load_skill`, `/name task`.
- **Compaction**: old history becomes a model-written summary, originals archived; `/compact`.
- **Session recall**: `search_sessions`, `read_session`.
- **Automations**: cron-scheduled agent runs delivered to the console or Telegram, unattended and
  refused anything that needs approval.
- **Telegram channel**: private chats from allow-listed users, approvals as inline buttons.
- **Browser**: Playwright MCP through the MCP bridge; verified against real Chromium in CI.
- **Subagent budgets**: `maxWorkers`, `maxTokens`, `maxCostUsd` per session and `maxWorkerTokens` per worker.
- **Tokens and cost**: per-session token totals (per model) and an estimated cost in the console, Telegram `/status` and chat `/usage`.
- **Memory**: `MEMORY.md` notes (project + global) read into every prompt as background facts; written only through the gated `remember` tool.
- **Skills from others**: Agent Skills format; `sbx skills install <folder|https git URL>` with a full preview and confirmation; `allowed-tools` is ignored.
- **Skill drafts**: `propose_skill` writes an inert draft; `sbx skills drafts|accept|reject` is the review.
- **Discord channel**: DMs from allow-listed user ids, approvals as buttons, resumes after a dropped connection; shares a new core with Telegram (Node 22+).
- Provider settings with write-only credentials, multi-provider chat, hot-apply (from 0.1.x work).

### Packaging
- Published name is `@botconnector/switchboard` (the unscoped name belongs to someone else on npm).

### Known gaps
- No overflow recovery when a provider rejects a prompt as too long (compaction runs before that).
- Automations and presets have an API/CLI but no editor in the console.
- Telegram: text only, private chats only; tried by hand against the real Bot API in one chat.
- Drafts, memory and skill installs have a CLI but no console screen yet.
- The sandbox is process isolation (shared kernel), not a hard security boundary.
