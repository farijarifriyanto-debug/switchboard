# Changelog

## Unreleased

- `sbx run --json`: JSON Lines events plus a final `result` line on stdout, exit code 1 on failure.
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
