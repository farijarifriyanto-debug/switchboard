# Changelog

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
- Provider settings with write-only credentials, multi-provider chat, hot-apply (from 0.1.x work).

### Packaging
- Published name is `@botconnector/switchboard` (the unscoped name belongs to someone else on npm).

### Known gaps
- No overflow recovery when a provider rejects a prompt as too long (compaction runs before that).
- Automations and presets have an API/CLI but no editor in the console.
- Telegram: text only, private chats only, tested against a fake Bot API.
- The sandbox is process isolation (shared kernel), not a hard security boundary.
