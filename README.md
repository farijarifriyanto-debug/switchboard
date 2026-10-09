# Switchboard

An agent harness for **BotConnector**, where **everything is a plugin**.

Switchboard is an independent, MIT-licensed implementation of the "everything is a
plugin" harness idea, built on [Cordis](https://github.com/cordiverse/cordis)
(the same composability framework used by DeepSeek Harness). It is **not**
affiliated with or endorsed by DeepSeek and contains none of its runtime code. The console
stylesheet adapts DeepSeek Harness design tokens (also MIT): see `THIRD_PARTY_NOTICES.md`
for the required notice.

```
        ┌─────────────────────────────────────────────┐
        │  Cordis context (plugin host)               │
        ├─────────────────────────────────────────────┤
        │  services   llm · sessions · tools · agent  │
        │  plugins    tools-fs · tools-shell · tools-web
        │             metrics · agent-loop · <yours>  │
        └─────────────────────────────────────────────┘
```

## Why it is fast to tune

The harness ships with **latency telemetry built in**. Every model call emits
`llm/metrics`, and the `metrics` plugin aggregates p50/p95 TTFT per model, so
provider choices can be driven by measurements instead of guesses:

```
$ sbx run "..."          # prints ttft / total / tok/s per turn on stderr
$ sbx metrics            # per-model p50/p95 table for the session
```

### Reasoning channels

Providers differ on how they expose chain-of-thought. Switchboard normalises all three
shapes:

- a dedicated `reasoning_content` delta field (DeepSeek/Qwen style),
- inline `<think>` / `<thinking>` / `<reasoning>` blocks inside `content`
  (gpt-oss, ling, and other GPT-OSS-style models), and
- mixed streams, where the open/close tags themselves arrive split across
  chunks.

Inline blocks are split out with a small streaming state machine (it keeps a
tail buffer so a tag straddling two chunks is still detected), so `content` only
ever holds the answer and the conversation history never leaks chain-of-thought.
`sbx run` renders the reasoning channel dimmed above the answer.

## Install

```sh
npm install -g @botconnector/switchboard   # once published; provides the `sbx` command
```

From source:

```sh
git clone https://github.com/farijarifriyanto-debug/switchboard.git
cd switchboard
npm ci
npm run build
```

Requirements: Node.js >= 20.11.

## Safety defaults

Switchboard gives a model a shell and your files, so it asks before it acts:

- **Approval is `risky` by default.** `run_command`, `write_file` and every MCP tool
  that does not declare `readOnlyHint` wait for your decision. In `sbx chat` you
  answer on the terminal (`y`, `N`, or `a` = always for this session); in the web
  console you use the approval panel. `sbx run` and piped input have nobody to ask,
  so gated calls are refused with a hint. Opt out with `--yes` / `--approval off`,
  or `"approval": { "mode": "off" }` in the config. `--approval all` gates every tool.
- **Approval is not a sandbox.** Shell commands run as you, on your machine. File
  tools stay inside the workspace (symlinks included) but `run_command` does not.
- **`web_fetch` refuses private addresses** (loopback, LAN, link-local, cloud metadata),
  re-checks every redirect and caps the body it reads. `tools.web.allowPrivateNetwork`
  turns that off.
- **The console is local.** `sbx web` binds to 127.0.0.1, checks Host/Origin and
  requires JSON on every write. `--host <addr>` on any other interface makes
  Switchboard mint an access token (or use `web.token` / `SWITCHBOARD_WEB_TOKEN`):
  open the printed URL once and a `HttpOnly; SameSite=Strict` cookie takes over.
  Use HTTPS in front of it if it leaves your machine.
- **Web search leaves the machine.** `web_search` sends your query to Keenable (or to
  BotConnector when configured), not to the model provider.

### Try the console without an API key

After building, run `node scripts/preview-console.mjs` and open the printed local
URL. This is an isolated visual demo with simulated streaming responses, an
in-memory session store, and a temporary workspace. It does not call an AI
provider or read your credentials. Press Ctrl+C to close it and remove its
temporary workspace.

For real tasks, use `sbx web` with your configured provider. The console includes
a setup guide, example prompts, and light/dark themes using BotConnector's
original Bico mascot. On mobile, open the sidebar with the menu button to access
your chats, project files, plugins, and activity. The chat details menu reveals
model capabilities and context usage.

## Configure

Copy/keep `switchboard.config.jsonc` (JSON with comments). The API key is read from the
`BOTCONNECTOR_API_KEY` environment variable, so keep secrets out of the file:

```jsonc
{
  "llm": {
    "baseURL": "https://api.botconnector.id/v1",
    "defaultModel": "agnes-3.0-flash"
  },
  "agent": { "maxSteps": 8, "temperature": 0.2 },
  "tools": {
    "fs":    { "root": "." },
    "shell": { "timeoutMs": 30000 },
    "web":   { "maxChars": 20000 }
  },
  "plugins": ["./plugins/echo-tool.mjs"]
}
```

Any OpenAI-compatible endpoint works — BotConnector Cloud is just the default.
Ollama, vLLM, OpenRouter, LM Studio, and so on are one `baseURL` away.

On Windows, `sbx.cmd` is a convenience runner that picks the key up from
`%USERPROFILE%\.bccli\integrations\bc-cloud.key` if the env var is unset.

`AGENTS.md` in the workspace root (and optionally `~/.switchboard/AGENTS.md`)
is appended to the system prompt automatically — the shared project-context
convention (Claude Code / OpenClaw / Hermes). Oversized files are truncated;
missing files are ignored.

## Sandbox

Approval asks before a command runs; a sandbox limits what it can do once it runs. Turn it on for
`run_command`:

```jsonc
"tools": { "shell": { "sandbox": { "mode": "bwrap" } } }   // Linux, no daemon (apt install bubblewrap)
"tools": { "shell": { "sandbox": { "mode": "docker", "image": "node:24-alpine" } } }   // docker pull it first
```

or `sbx chat --sandbox bwrap`. Inside: the project is mounted at `/workspace` (writable, or
`"workspace": "ro"`), the rest of your machine is not visible (no home directory, no SSH keys, no
`~/.switchboard/credentials.json`), your environment is **not** passed (API keys stay out unless you
list them in `passEnv`), and there is no network unless `"network": true`. Extra read-only folders
(a toolchain outside `/usr`) go in `readOnly`. Docker mode also drops all capabilities, forbids
privilege escalation and limits memory/CPUs/processes. If the sandbox cannot start, the command is
refused: it never falls back to running on the host. Windows and macOS have no bubblewrap; use docker (the shell inside a minimal image is `sh`, often with no `bash`).

Limits: this is process isolation, not a security boundary against a determined attacker (bubblewrap
shares the host kernel; a docker daemon is a powerful thing to hand out), and the file tools
(`read_file`, `write_file`) still run on the host, confined to the workspace. `test-sandbox.mjs` checks
the isolation against the real tools where they are installed (CI installs both).

## Presets

A preset is a saved way of running the agent: a system prompt, a model/provider, a step
budget and tool access. Three ship built in: `default`, `reviewer` (read-only: read/list/search)
and `researcher` (web + read-only project access). Pick one with `sbx chat --preset reviewer`
(`sbx presets` lists them) or from the selector in the console composer; a session keeps its
preset. Your own presets live in `~/.switchboard/presets.json` and are managed through
`GET/POST/PUT/DELETE /api/presets`:

```jsonc
{ "id": "terse", "name": "Terse", "system": "Answer in one sentence.",
  "maxSteps": 4, "tools": { "allow": ["read_file", "list_dir"], "deny": ["run_command"] } }
```

`allow` hides every tool not listed (including MCP/plugin tools loaded later); `deny` hides the
listed ones and wins over `allow`. Explicit per-run options (`--model`, API fields) override the
preset. A preset narrows what the model can see; it does not replace the approval gate.

## Skills

A skill is a folder with a `SKILL.md`: YAML frontmatter (`name`, `description`) and a markdown
body. Put them in `<workspace>/.switchboard/skills/<name>/` or `~/.switchboard/skills/<name>/`
(project wins on a name clash).

```markdown
---
name: deploy
description: Ship the app safely. Use when the user asks to release or deploy.
---
1. Run the tests. 2. Tag the release. 3. ...
```

Only the name and description go into the system prompt; the model loads the full text with the
`load_skill` tool (and any file shipped next to it with `load_skill {name, file}`), or you run one
yourself with `/deploy to staging`. `sbx skills` lists what was found. Skills are plain
instructions read from disk: treat one from a project you did not write like the rest of that
project. `"skills": { "enabled": false }` turns the feature off.

## Compaction

Long conversations are summarized, not just cut. When the prompt passes 80% of
`agent.maxPromptTokens`, everything older than the last few messages is replaced by one summary
(goal, decisions, files and commands, problems, open tasks, facts to keep) written by the model; the
originals move to `session.archived`. Tool calls stay paired with their results. Run it yourself
with `/compact [what to pay attention to]` in `sbx chat` or the console, or
`POST /api/sessions/:id/compact`. If the summary request fails, the old trimming still protects the
prompt and automatic compaction pauses for that session for two minutes.
`"compaction": { "enabled": false, "triggerRatio": 0.8, "keepRecent": 6 }` tunes it. A summary is
model-written: check it before relying on a detail from before the cut.

## Session recall

`search_sessions` finds words in earlier conversations (live messages and the originals that
compaction archived; the current transcript is skipped) and `read_session` pages through one by id.
That makes saved sessions usable as memory: "what did we decide about the billing ledger last
week?". Both are read-only, but they expose your past conversations to the model, so the built-in
`reviewer` and `researcher` presets leave them out, and so should any preset you build for
untrusted input.

## Telegram channel

Talk to the agent from your phone. This is remote control of a machine with a shell, so it is
strict by default:

```jsonc
"channels": { "telegram": { "enabled": true, "allowFrom": [123456789], "preset": "default" } }
```

```sh
export TELEGRAM_BOT_TOKEN=...   # from @BotFather; never put it in the config file
sbx channels
```

- Only **private chats** from the listed Telegram user ids are served; everything else is dropped
  without a reply. An empty `allowFrom` refuses to start. Long polling only: no inbound port.
- Tool approvals arrive as ✅ Allow / ❌ Deny / ♾ Always buttons in the same chat, and only an allowed
  user's tap counts. With `approval.mode: "off"` it refuses to start unless you also set
  `allowUnattended: true`.
- Commands: `/new`, `/stop`, `/compact [focus]`, `/preset [id]`, `/status`, `/help`. Skills work as
  `/name task`. Text only for now (no photos/files). The chat keeps its conversation across restarts.
- Your messages and the agent's answers pass through Telegram's servers. Use the `reviewer` or
  `researcher` preset if the bot should never touch files or run commands.

## Automations

Scheduled agent runs: a cron schedule, a prompt, a preset, and where the answer goes.

```sh
sbx automations add "0 9 * * 1-5" "Summarize what changed in this repo since yesterday" \
  --name morning --preset reviewer --telegram 123456789
sbx automations            # list, with next run and last status
sbx automations run morning
```

Also `GET/POST/PUT/DELETE /api/automations`, `POST /api/automations/:id/run`, `GET .../runs`.

- The schedule only ticks while a long-running command is up: `sbx web` or `sbx channels`.
  A slot that passed while nothing was running is recorded as `missed` and skipped, never replayed.
- Runs are **unattended**: any tool that would ask for approval is refused on the spot, so an
  automation can do exactly what its preset allows without asking. The default preset is `reviewer`
  (read-only). Each run uses a fresh session that is deleted afterwards; the answer is kept in the run
  history (last 20).
- At most 20 automations, no more often than every 5 minutes, one run at a time, 10 minute limit.
  After 5 failures in a row an automation switches itself off (a failure is delivered too).
- `--telegram <id>` needs the Telegram channel running and the id on its `allowFrom`.

## Browser

Switchboard does not bundle a browser; it drives [Playwright MCP](https://github.com/microsoft/playwright-mcp)
through the MCP bridge. Add the server under the name `browser` (pin the version) and install its browser once:

```jsonc
"mcp": { "servers": { "browser": {
  "transport": "stdio", "command": "npx",
  "args": ["-y", "@playwright/mcp@0.0.83", "--headless", "--isolated", "--browser", "chromium"],
  "toolCallTimeoutMs": 120000
} } }
```

```sh
npx -y @playwright/mcp@0.0.83 install-browser chrome-for-testing
sbx chat --preset browser
```

The built-in `browser` preset hides everything except `mcp__browser__*`, `web_search` and
`load_skill`: no files, no shell. Page content is untrusted input to the model, so keep it that way:
`--isolated` keeps the profile in memory (no logins, cookies or history of yours), approvals stay on
(only the read-only snapshot-style tools skip them), and `--allowed-origins https://example.com`
limits where it may go. `scripts/browser-smoke.mjs` (the *Browser smoke* workflow) checks the
integration against real Chromium: it lists the 25 tools, loads a page and reads its snapshot.
Presets accept a trailing `*` as a prefix pattern (`mcp__browser__*`). Playwright MCP writes page
snapshots into a `.playwright-mcp/` folder in the working directory (already in this repo's `.gitignore`;
add it to yours).

## MCP servers

Any [Model Context Protocol](https://modelcontextprotocol.io) server works as a
Switchboard tool source — no plugin needed. Configure it in the `mcp` block:

```jsonc
"mcp": {
  "servers": {
    "memory": {
      "transport": "stdio",                        // or "streamable-http" + "url"
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": { "MEMORY_FILE_PATH": "${HOME}/.switchboard/memory.json" }
    },
    "remote": {
      "transport": "streamable-http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
    }
  }
}
```

- Tools appear as `mcp__<server>__<tool>` (≤64 chars, `[A-Za-z0-9_-]`) and flow
  through the normal approval gate: under the default `risky` mode a tool without `readOnlyHint` waits for approval.
- Servers connect eagerly at boot and fail open: an unreachable server is
  reported by `sbx info`/`sbx doctor` and retried with exponential backoff
  (500 ms → 30 s, 10 attempts), then its tools are unregistered until restart.
  `failOnStartupError: true` turns a bad server into a boot failure.
- Server `instructions` are injected into the system prompt while connected.
- Child processes get a scrubbed environment (`KEY|PASSWORD|SECRET|TOKEN|
  CREDENTIAL` names and `BOTCONNECTOR_*` are dropped; your `env` entries win).
- Known deviations from the reference DeepSeek Harness client (image results as
  text, `structuredContent` logged only, no config hot-reload, no Resources/
  prompt bridging, headers-only auth) are listed in the design spec.

## Subagent delegation

The `task` tool lets the model hand independent work to isolated worker
sessions — each one a fresh agent with no memory of your conversation:

```jsonc
"subagent": {
  "enabled": true,        // default true (only `enabled: false` turns it off)
  "maxParallel": 3,       // workers in flight per batch (integer >= 1)
  "maxSteps": 8,          // default loop budget per worker (integer >= 1)
  "autoResume": true      // false = results still inject, but never auto-run
}
```

- **Blocking** — the model waits and gets `[{description, status, result|error}]`
  as the tool result.
- **Background** — `background: true` returns `[{jobId, sessionId, description}]`
  immediately. When a job settles, its result is appended to the parent session
  as `[job <jobId> selesai] status: ok|failed\n<result>` and, if the session is
  idle and `autoResume` is on, one wake turn picks it up. Injected while a turn
  is running? The flush waits for the turn to end (never mid-run injection).
- Workers never see `task` (no recursion), get the worker system prompt plus
  your `AGENTS.md`/date context, and inherit the session model unless the task
  overrides it. Background children carry `kind: 'subagent'`,
  `parentSessionId`, `jobId` in their persisted session record.
- Jobs live in memory only: unloading the host (`host.dispose()`) aborts
  in-flight workers, marks queued jobs `aborted before start (unload)` and
  running jobs `aborted (unload)`, clears the registry, and drops pending
  injections.

## Usage

```sh
sbx                          # interactive chat
sbx run "summarize README.md"
sbx chat -m gpt-oss-120b     # override the model
sbx web                      # local operator console at http://127.0.0.1:7777
sbx web --port 8080 --no-open
sbx sessions                 # stored conversations (resume with -r <id>)
sbx chat -r s-muval          # continue a stored session (id or unique prefix)
sbx info                     # config, endpoint, loaded plugins
sbx doctor                   # diagnostics: config, host, endpoint, key, data dir
sbx tools                    # registered tools
sbx models                   # models advertised by the endpoint
sbx metrics                  # latency collected this session
sbx --plugins ./plugins/echo-tool.mjs
```

### Web console

`sbx web` serves a small offline console (no CDN, no build step) plus a JSON/SSE
API over the same plugin host the CLI uses. It binds to loopback only and has no
authentication — it exposes an agent with filesystem and shell tools, so treat
the port as you would a shell.

| Endpoint | Purpose |
|---|---|
| `GET /api/state` | endpoint, model, models, tools, sessions, latency summary |
| `POST /api/sessions` · `GET`/`DELETE /api/sessions/:id` | session CRUD |
| `POST /api/chat` | run a prompt, streamed as SSE (`event: <type>` per agent event) |

Enable it from config instead by setting `"web": { "enabled": true }`.

### Local CI (`sbx ci`)

Switchboard can run GitHub-Actions-style workflows on your own machine — no
push, no remote runner. Opt-in via config:

```jsonc
// switchboard.config.jsonc
"ci": { "enabled": true, "keepRuns": 200 }   // keepRuns optional: history retention (default 200, min 10)
```

Workflows live in `.switchboard/workflows/*.yml`:

```yaml
name: Nightly
on:
  schedule: "0 3 * * *"    # 5-field local cron; fires while `sbx web` is up
jobs:
  build:
    steps:
      - name: Test
        run: npm test
```

```sh
sbx ci                # run every workflow
sbx ci <name>         # run one
sbx ci --list         # list workflows + last run + cron + next fire time
```

Supported: `name`, `on.schedule` (local 5-field cron while `sbx web` runs;
other `on:` values are ignored), `env` (workflow/job/step), `jobs.<id>.needs`
(DAG), `steps[].run/name/env/working-directory/timeout-minutes`. Not supported
in v1: `uses`, `matrix`, `if`, `continue-on-error`, `services`, `secrets`.
Invalid cron keeps the workflow listed with an error but never schedules it.
The console shows the same pipelines under the **CI** tab with a history view
(workflow/status filters, pagination, trigger badges, log download);
API: `GET/POST /api/ci/...`, `GET /api/ci/runs?limit=&offset=&workflow=&status=`
returns `{ runs, total, limit, offset }` (limit capped at 100). Runs are stored
under `~/.switchboard/ci/` (retention: `ci.keepRuns`).

## Writing a plugin

A plugin is a plain object with a name and an `apply(ctx)` function. Cordis
handles lifecycle, dependency injection and cleanup.

```js
export const plugin = {
  name: 'my-plugin',
  inject: ['tools'],

  apply(ctx, config = {}) {
    // 1. add a tool — disposed automatically when the plugin unloads
    ctx.effect(() =>
      ctx.tools.register({
        name: 'now',
        description: 'Return the current time.',
        parameters: { type: 'object', properties: {} },
        execute: () => new Date().toISOString(),
      }),
    )

    // 2. react to harness events
    ctx.on('llm/metrics', (m) => ctx.logger('my-plugin').info('%c %cms', m.model, m.totalMs))
  },
}
```

Enable it via `"plugins": ["./plugins/my-plugin.mjs"]` or `sbx -p ./plugins/my-plugin.mjs`.

### Built-in events

| Event | Payload | Emitted |
|---|---|---|
| `llm/metrics` | `GenerateResult` | after every model call |
| `tools/register` / `tools/unregister` | `name` | tool added/removed |
| `agent/step` | `{step, sessionId, model}` | each loop turn |
| `agent/tool` | `{id, name, args, result, sessionId}` | each tool execution |
| `agent/done` | `{sessionId, steps, content}` | final answer |
| `session/create` / `session/append` | `id` / `{id, role}` | session store |
| `mcp/server:up` / `mcp/server:down` | `{server, reason?}` | MCP server connected / lost |
| `mcp/tool:call` | `{server, tool, ms, ok}` | each MCP tool execution |
| `subagent/start` | `{sessionId, parentSessionId, tasks}` | worker session registered |
| `subagent/done` | `{sessionId, ok}` | worker finished |

### Core services

| Service | Provided by | Purpose |
|---|---|---|
| `ctx.llm` | `src/services/llm.ts` | OpenAI-compatible streaming client |
| `ctx.tools` | `src/services/tools.ts` | tool registry, `defs()`, `call()` |
| `ctx.sessions` | `src/services/session.ts` | conversation store |
| `ctx.agent` | `src/plugins/agent.ts` | the agent loop (`run`, `stream`) |
| `ctx.metrics` | `src/plugins/metrics.ts` | latency aggregation |
| `ctx.web` | `src/plugins/web.ts` | operator console (HTTP + SSE) |
| `ctx.mcp` | `src/plugins/mcp.ts` | MCP supervisors (present only when `mcp` is configured) |
| `ctx.subagent` | `src/plugins/subagent.ts` | job registry + inject/wake state (`state()`, `flush()`) |

Replace any of them by providing a service with the same name from your own
plugin.

## Layout

```
src/
  index.ts            host bootstrap (createHost)
  cli.ts              `sbx` command line
  config.ts           config load/merge + plugin resolution
  context.ts          prompt-size estimation and trimming
  types.ts            shared types
  events.ts           event-bus contract
  services/           llm · tools · sessions · agent interface
  plugins/            agent-loop · tools-fs · tools-shell · tools-web · metrics · web
plugins/              user plugins (example: echo-tool.mjs)
web/                  operator console served by `sbx web` (index.html · app.css · app.js)
```

## Development

```sh
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm run smoke       # offline, hermetic checks (no network, no API key needed)
npm run test:web    # stub-provider SSE round trip through /api/chat
npm run test:retry  # backoff policy against a stub endpoint
npm run test:ctx    # context trimming rules
npm run test:split  # mock-SSE regression for inline-think splitting
npm run test:subagent # task tool, waves, background jobs, inject/wake
npm run debug:live -- gpt-oss-120b   # live probe; needs BOTCONNECTOR_API_KEY
```

`debug:live` prints `content`/`reasoning` as base64 on purpose: raw terminal
output containing think tags may itself be parsed by the caller's UI.

## Status

Early (0.x). Working today: streaming chat, tool calling, a multi-step agent loop with approvals,
persistent sessions, presets, skills, compaction and session recall, subagent delegation, MCP
servers (including a Playwright browser), a sandbox for `run_command`, scheduled automations, a
Telegram channel, a local web console and `sbx ci`.

What has and has not been tried by a person:

- Tested by hand: the console (Chrome), skills, automations, Telegram against the real Bot API
  (one private chat), the browser preset against real Chromium, and the docker sandbox on Windows
  (Docker Desktop) and Linux.
- Not tested by hand: bubblewrap outside Linux CI, macOS, and any channel other than Telegram.
- The sandbox is isolation, not a security boundary (see above), and Telegram is the only chat
  channel today.

## Credits

- Design tokens adapted from DeepSeek Harness (MIT; full notice in
  `THIRD_PARTY_NOTICES.md`), rebound to the Switchboard Control Room identity.
- CLI and console conventions reviewed against [Hermes Agent](https://github.com/nousresearch/hermes-agent)
  (MIT) and [OpenClaw](https://github.com/openclaw/openclaw) (MIT); adopted
  patterns include project `AGENTS.md` injection, `sbx doctor`, and the context gauge.
- Built on [Cordis](https://github.com/cordiverse/cordis) (MIT).

## License

MIT. Built with Cordis (MIT).

## License

MIT (see `LICENSE`), except the Bico mascot and BotConnector marks (see `NOTICE`). Third-party
notices: `THIRD_PARTY_NOTICES.md`. Security reports: `SECURITY.md`. Contributing: `CONTRIBUTING.md`.
