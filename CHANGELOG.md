# Changelog

## Unreleased

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
