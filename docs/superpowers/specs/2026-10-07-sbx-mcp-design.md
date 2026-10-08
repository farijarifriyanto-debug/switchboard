# Design: MCP client bridge (v1)

Date: 2026-10-07
Status: approved by user (design sections + parity audit), pre-implementation
Scope: new subsystem — MCP client for Switchboard; parity with
  `@deepseek-ai/dsh-mcp-client` (DeepSeek Harness) unless explicitly deferred below
Parity source: github.com/deepseek-ai/deepseek-harness `packages/mcp/mcp-client/README.md`
  (fetched 2026-10-07)

## 1. Goal

Connect external MCP servers to Switchboard and expose their tools to the model
as native tools (`mcp__<server>__<tool>`), so any MCP server (memory,
filesystem, GitHub, …) works without writing a Switchboard plugin.

Explicitly in scope because DSH ships them and the user required "minimal sama,
jangan downgrade": both transports (stdio + streamable-http), server-instruction
injection, `tools/list_changed` re-sync, atomic tool generations, full outage/
reconnect semantics, env scrubbing, deterministic pinned naming.

## 2. Decisions taken with the user

| Question | Decision |
|---|---|
| First sub-project of the 5-item roadmap | MCP client (over model adapter, subagent, sandbox, plugin manager) |
| Transport v1 | stdio + streamable-http (upgraded from stdio-only after parity audit) |
| Config source | `switchboard.config.jsonc` block `"mcp"` (own config; no reuse of other tools' config files) |
| Exposure | all discovered tools registered automatically (existing approval gate still applies) |
| Lifecycle | eager at boot, fail-open, DSH semantics (user: "ikuti deepseek harness") |
| Implementation | official `@modelcontextprotocol/sdk` dependency (approach A over hand-rolled JSON-RPC) |
| Parity rule | no functional downgrade vs DSH mcp-client; anything less must be an explicit, documented deviation |

## 3. Config schema

```jsonc
"mcp": {
  "servers": {
    "memory": {                                 // key = serverName
      "transport": "stdio",                     // "stdio" | "streamable-http" (default "stdio")
      "command": "npx",                         // stdio
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": { "MEMORY_FILE_PATH": "${HOME}/.switchboard/memory.json" },
      "cwd": "",
      "url": "http://127.0.0.1:3000/mcp",       // streamable-http (mutually exclusive with command)
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" },
      "toolCallTimeoutMs": 60000,
      "maxInstructionBytes": 32768,
      "failOnStartupError": false,
      "reconnect": {
        "enabled": true, "initialDelayMs": 500,
        "maxDelayMs": 30000, "maxAttempts": 10
      }
    }
  }
}
```

- Validation at config load (union by `transport`): mixed-field configs
  (`command` alongside `url`, …) are a clear load error naming the offending
  key; `serverName` must match `[A-Za-z0-9_-]{1,32}` (map keys are unique by
  construction); unknown fields inside a server entry produce a warning, not a
  failure. No `mcp` block (or empty `servers`) = feature inert, zero overhead.
- `${VAR}` interpolation in `env` values and `headers` values (ambient
  environment; unresolved var = empty string + warning). Secrets stay out of
  the config file.
- Defaults mirror DSH exactly: `toolCallTimeoutMs` 60 000,
  `maxInstructionBytes` 32 768, `failOnStartupError` false, reconnect
  enabled/500/30 000/10.

## 4. Naming contract (pinned — change requires a spec amendment)

- Public name: `mcp__<serverName>__<rawName>`; raw name is the ONLY name sent
  on the wire (`tools/call`), never parsed back from the public name.
- Normalization to the shared function-name contract: `[A-Za-z0-9_-]`, ≤ 64
  chars. When replacement or truncation changes the name, append `-` +
  12-hex-char SHA-256 hash of `(serverName, rawName)` so distinct identities
  never collapse.
- Public names are a pure function of `(serverName, rawName)` — independent of
  connection order, re-syncs, reconnects, or other servers. Two servers
  offering `search` coexist as `mcp__a__search` / `mcp__b__search`.
- The namespace is the configured `serverName`, never the remote
  `serverInfo.name` (untrusted).
- Collision with an existing registry name (local tool or other server) at
  registration time = the whole generation for that server is rejected and the
  previous generation stays (mirrors DSH "full generation or none").
- A server listing the same tool twice ⇒ its tool list is rejected as invalid;
  the previous set stays active.

## 5. Supervisor lifecycle (one per configured server)

A single plugin (`src/plugins/mcp.ts`) loads the whole `mcp` block and runs an
independent supervisor per server (SB config is a map, not one plugin row per
server as in DSH's cordis.yml — internal behavior is per-server identical).

**Boot (eager, parallel):** all servers start concurrently
(`Promise.allSettled`); each: spawn (stdio, probe process handled by SDK) or
HTTP connect → initialize handshake (SDK negotiates 2026-07-28, falls back to
supported legacy) → `listTools()` (SDK owns pagination) → atomic generation
swap → tools registered on `ctx.tools` before the first turn.

**Fail-open:** initial connection/discovery/registration failure is logged
with server context and the server runs "down" (host unaffected).
`failOnStartupError: true` ⇒ the plugin's boot rejects and the host fails to
start. Reconnect failures are never fatal regardless of the flag.

**Atomic generations:** every sync (initial, notification, reconnect) is
serialized through one queue per server. A fetch failure keeps the previous
generation registered; a registration conflict rolls the attempted generation
back entirely. There is never a partial tool set from one server.

**`tools/list_changed`:** handled via the SDK (legacy notification or modern
subscription); each change enqueues a re-sync through the same queue. If the
update fails, the previous tool set keeps working.

**Outage semantics:** when the connection drops, the last known generation
stays registered; calls to those tools fail with a visible
`MCP server '<name>' is down` error until recovery. Reconnect delays double
from `initialDelayMs` (500 ms) up to `maxDelayMs` (30 s). One attempt budget
per outage: after `maxAttempts` (10) consecutive failures the tools are
unregistered and reconnection stops until process restart. A connection that
stays up for ≥ `maxDelayMs` resets the budget. `reconnect.enabled: false`
disables the loop (tools stay listed, calls fail until restart).

**Disposal** (`ctx.effect`): cancel pending reconnects, close transport,
quiesce in-flight requests, unregister the current generation, release the
namespace.

Transport ownership: the supervisor owns the reconnect loop for BOTH
transports (stdio respawn; streamable-http re-establishes the transport when
the SDK reports it closed — resolving DSH's documented open direction in
favor of one code path; per-request failures inside a live HTTP connection
stay with the SDK).

## 6. Server instructions

The `instructions` field from a successful initialize (server-labeled, blank
skipped, total UTF-8 bytes capped by `maxInstructionBytes`, oversize ⇒
connection rejected) is appended to the system prompt as a literal
"MCP servers" section — assembled per turn like the existing date/AGENTS.md
injections (`src/plugins/agent.ts`), so reconnects take effect immediately.
Instructions appear only while the server is connected with a successful
discovery; dispose/budget-exhaustion removes them.

## 7. Execution semantics

- Bridge `execute()` → `client.callTool({ name: rawName, arguments }, { signal, timeout: toolCallTimeoutMs })`
  with the caller's `AbortSignal` (cancel like any local tool).
- Result content blocks are joined in block order as plain text: `text` →
  content; `resource_link` → `<name> (<uri>)`; image/audio/other blocks →
  bounded diagnostic text (e.g. `[image: image/png, 12 KB omitted — attachment bridge deferred]`).
  MCP `isError` ⇒ throw with the server's message → existing `tools.call`
  turns it into a visible `Error: …` result (no fake success).
- `structuredContent` is preserved only for logging, not projected to the
  model (deferred — see §11).
- Everything flows through `ctx.tools.call` ⇒ the existing approval gate,
  retry/error conventions and events cover MCP tools unchanged.

## 8. Environment scrubbing (stdio) & secrets

Child env = ambient env minus names matching `/KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL/i`
and minus `BOTCONNECTOR_*`, then merged with the (interpolated) `config.env`
on top — explicit overrides survive; the SB API key never leaks to children.
HTTP `headers` support the same `${VAR}` interpolation.

## 9. Events, CLI, diagnostics

- New events in `src/events.ts`: `mcp/server:up` / `mcp/server:down`
  (`{ server, reason? }`), `mcp/tool:call` (`{ server, tool, ms, ok }`).
- `sbx tools` marks MCP tools with origin `mcp:<server>`.
- `sbx info` and `sbx doctor` report each configured server's state
  (`up (n tools)` / `down (reason)` / `exhausted`); `doctor` counts a
  failing server as a warning (not an error) unless `failOnStartupError`.
- No dedicated console panel (existing `/api/state` already surfaces the tool
  list the registry reports).

## 10. Testing

- New suite `scripts/test-mcp.mjs` (test chain 11 → 12).
- Fixture `test/fixtures/fake-mcp.mjs`: minimal stdio MCP server (SDK
  server side) exposing `echo` + `failing` tools and a `list_changed`
  bump trigger — hermetic, no network, no API key.
- Fixture `test/fixtures/fake-mcp-http.mjs`: in-process Streamable HTTP MCP
  server on an ephemeral localhost port for the http transport path.
- Unit + integration coverage: config validation (mixed fields, bad
  serverName, defaults), naming determinism (normalization, truncation,
  hash stability), boot registration before first turn, fail-open vs
  `failOnStartupError`, call OK / timeout / `isError`, outage → tools stay
  registered + visible failure, budget exhaustion → unregister, list_changed
  → atomic swap (failure keeps previous), env scrub + `${VAR}` interpolation,
  server-instruction injection + byte cap, dispose kills child (no orphan).
- Live canary (manual gate): `npx @modelcontextprotocol/server-memory`
  configured → `sbx tools` lists `mcp__memory__*` → `sbx run` calls
  `mcp__memory__create_entities` for real.

## 11. Explicit deviations (documented, not silent downgrades)

| DSH behavior | Switchboard v1 | Rationale |
|---|---|---|
| Image results project into model context when attachments enabled | diagnostic text (== DSH attachments-off mode) | needs an attachment store subsystem; separate roadmap item |
| `structuredContent` preserved for programmatic callers | logged only | `ToolSpec.execute` returns `string` today |
| HMR: editing config reloads connection in place | restart `sbx` | SB has no config hot-reload; reconnect still covers server-side restarts |
| MCP Resources & prompt templates | not bridged | DSH also ships these as a separate `mcp-resources` package |
| OAuth flows | headers-based auth only | official DSH client is headers-only too |

## 12. Files

| File | Change |
|---|---|
| `package.json` | dependency `@modelcontextprotocol/sdk`; `test:mcp` script + chain |
| `src/config.ts` | `mcp` block parse/validate (union, defaults, interpolation) |
| `src/plugins/mcp.ts` (new) | supervisors, transports, naming, generations, reconnect, instructions |
| `src/services/tools.ts` | none required (registry already suffices) |
| `src/plugins/agent.ts` | system-prompt assembly gains the MCP-instructions section |
| `src/events.ts` | `mcp/server:*`, `mcp/tool:call` |
| `src/cli.ts` | `sbx tools/info/doctor` mcp fields |
| `src/index.ts` | load the plugin when `mcp.servers` non-empty |
| `scripts/test-mcp.mjs` (new), `test/fixtures/fake-mcp.mjs` (new), `test/fixtures/fake-mcp-http.mjs` (new) | suite + fixtures |

## 13. Error-handling summary

| Failure | Behavior |
|---|---|
| Schema-invalid `mcp` block (mixed transport fields, bad serverName, missing required field) | host refuses to start with an error naming server + key (DSH parity: bad config fails fast); unknown fields only warn |
| Initial connect/discovery fails | log + down + fail-open; `failOnStartupError` ⇒ boot rejects |
| Tool call while down/timeout | visible `Error:` result; model can react |
| Tool call rejected by operator | existing approval text (unchanged) |
| list_changed sync fails | previous generation stays |
| 10 consecutive reconnect failures | unregister + stop; restart required |
| Oversized instructions | connection rejected (parity with DSH) |
