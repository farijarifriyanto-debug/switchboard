# Settings + Models Design — Switchboard Stage 1

Date: 2026-10-08. Base: HEAD `6040fab` + uncommitted console work (preserved, not reverted).
References: the DeepSeek Harness provider guide (<https://deepseek-harness.github.io/deepseek-harness/en/guide/providers>) for the settings model this stage follows.
(DeepSeek Harness behavior — patterns re-implemented, not copied), Hermes Agent / OpenClaw docs for
memory/skills/automation (ROADMAP ONLY — out of scope here).

**Scope rule (user):** stage 1 = Settings + Models, fully working, verified in the browser.
Skills, compaction, memory, automation are later stages and must not expand this implementation.

## 1. Current state (from source)

- Single provider: `config.llm` (`src/config.ts:8-23`) → `LLMService` (`src/services/llm.ts`),
  OpenAI Chat Completions only (`stream()` posts `/chat/completions`), key from
  `settings.apiKey || BOTCONNECTOR_API_KEY || OPENAI_API_KEY` (`llm.ts:157-161`).
- Sessions store `model?: string` only (`src/services/session.ts:23`); no provider identity.
  Agent resolves `options.model ?? session.model` (`src/plugins/agent.ts:182`) and calls
  `ctx.llm.stream` (`agent.ts:485-493`).
- Console (`src/plugins/web.ts`): flat `GET /api/state` (live `listModels()`), `POST /api/chat`
  (SSE), NO auth/origin/host guard on any route — protection today is only the loopback bind
  (`web.ts:104`), the static path-traversal check (`web.ts:496`), and the CI POST
  content-type check (`web.ts:294`). **Audit result: settings/credential mutations need a guard before they exist.**
- UI (`web/index.html`, `web/app.js`): flat model `<select>`s (`#model-picker`, `#model-mini`),
  `renderModelPicker` (`app.js:573`), no settings surface; getting-started dialog still points
  users at editing `switchboard.config.jsonc`.
- `approval.mode` is a public runtime field (`src/services/approval.ts:40`) read per gate
  call (`approval.ts:60`) — hot-apply works once a setter exists.

## 2. Goals (acceptance)

1. Settings panel: **General, Models, Plugins & MCP, Agent** tabs; unsupported areas show an
   explicit status line, never a dead button.
2. Provider registry: stable IDs, add/edit/delete, display name, Base URL, protocol; sessions
   store `{provider, model}` identity.
3. Credential store separate from config; API key write-only (UI ever sees only
   `{configured, source}`); precedence env > local > config explained in UI.
4. Model discovery (per protocol) + manual model entry; fields: display name, context window,
   output limit, input capabilities (vision/tools/reasoning).
5. Cross-provider composer picker + default provider/model; deleting an in-use provider gives a
   clear recovery (409 → force with detach list → undo).
6. Real adapters: OpenAI Chat Completions, OpenAI Responses, Anthropic Messages — each with
   tests for streaming, tool calls, cancellation, error. UI offers only these three.
7. Settings changes apply to the NEXT request; in-flight runs untouched; atomic server-side
   storage + validation.
8. Access/origin guard on settings + credential endpoints (audit first — §6).
9. Keep DSH-like layout, Bico mascot, cyan accents, light/dark, accessibility, mobile.
10. Consistent English UI copy; every error message states how to recover.

## 3. Data model

Config addition (`src/config.ts`):

```ts
settings?: { dir?: string }   // storage dir for settings files; default "~/.switchboard"
```

Files (created lazily; atomic write = tmp + rename, pattern `session.ts:202-214`):

- `<dir>/providers.json` — non-secret registry, mode default:
  `{ version: 1, defaultProvider?: string, defaultModel?: string, providers: ProviderEntry[] }`
- `<dir>/credentials.json` — **mode 0600** (chmod after write, best-effort on Windows):
  `{ version: 1, credentials: { [providerId]: { apiKey: string, updatedAt: number } } }`

```ts
type Protocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages'

interface ProviderModel {
  id: string                 // endpoint model id, required, ≤200 chars
  displayName?: string       // display name
  context?: number           // context window tokens (>0)
  maxOutput?: number         // output limit tokens (>0)
  inputs?: { vision?: boolean; tools?: boolean; reasoning?: boolean }
  manual?: boolean           // true = typed by hand (no catalog at endpoint)
}

interface ProviderEntry {
  id: string                 // stable slug /^[a-z0-9][a-z0-9-]{0,39}$/, IMMUTABLE after create
  displayName: string        // 1..80 chars
  baseURL: string            // http(s) URL, no trailing slash required
  protocol: Protocol
  headers?: Record<string, string>
  apiKeyEnv?: string         // NAME of an env var; the value is never stored in this file
  models: ProviderModel[]    // persisted catalog (what the picker shows)
  source?: 'config'          // virtual legacy provider derived from config.llm
  createdAt: number
  updatedAt: number
}
```

**Bootstrap / backward compat:** when `providers.json` is absent, `list()` exposes one virtual
provider `id: 'default'` built from `config.llm` (`source: 'config'`, models resolved live from
its endpoint as today, enriched by `contextCatalogUrl`). Writing any provider mutation
materializes the file with the user's providers; the virtual `default` stays available
(read-only fields in the UI — "configured in switchboard.config.jsonc") so existing installs
behave identically. Existing behavior of `sbx info/doctor/models` (`cli.ts:352-423`, reads
`ctx.llm.settings`) is unchanged.

**Session identity:** `SessionData += provider?: string` (`session.ts`). Create/chat/subagent
child (`subagent.ts:297-303`) carry it; `state.sessions` exposes it. Resolution order per run:
`options.provider ?? session.provider ?? registry.defaultProvider ?? 'default'`.

## 4. Credential store (write-only)

`src/services/credentials.ts` — `ctx.credentials`:

- `describe(id) → { configured: boolean, source: 'env'|'local'|'config'|null, envName?: string, updatedAt?: number }`
  — **never contains the secret**; this is the only shape any API returns.
- `resolve(id) → string | undefined` (server-side only), precedence per provider:
  1. `env[provider.apiKeyEnv]` (if set and non-empty) → source `env`
  2. local `credentials.json` entry → source `local`
  3. **default provider only:** `config.llm.apiKey` → `config`, then
     `BOTCONNECTOR_API_KEY` / `OPENAI_API_KEY` → `env` (today's fallbacks, unchanged)
- `set(id, apiKey)` (trim, 1..8192 chars) / `remove(id)` — atomic, mode 0600.
- Discovery may take a **one-shot draft key** (request-scoped, never written to disk —
  same contract as DSH's "the harness never stores it").

UI copy explains: "Environment variables take precedence over the local credential store
(`~/.switchboard/credentials.json`, file mode 600). Keys are write-only: the console only ever
receives 'configured' status."

## 5. Adapters + discovery (`src/llm/adapters.ts`, `src/llm/discovery.ts`)

Shared contract:

```ts
interface ProviderProfile {            // snapshot taken at request START (hot-apply, §7)
  id, displayName, baseURL, protocol, headers, apiKey?, extraBody?, contextCatalogUrl?
}
buildRequest(profile, opts): { url, headers, body }      // opts = model/messages/tools/temp/maxTokens
parseStream(res, profile): AsyncGenerator<LLMEvent>      // same event shape as today
listModels(profile, signal): Promise<DiscoveredModel[]>  // discovery
```

- **openai-chat** — today's `llm.ts` logic moved behind the interface (body, SSE `data:` lines,
  `reasoning_content`, inline `<think>` splitter, `tool_calls` accumulation, usage incl.
  `prompt_tokens_details`).
- **openai-responses** — `POST {base}/responses`, `stream: true`. Messages converted:
  system → `instructions`; assistant tool calls → `{type:'function_call', call_id, name, arguments}`;
  tool results → `{type:'function_call_output', call_id, output}`; attachments → `input_image`.
  Parses `response.output_text.delta`, `response.reasoning_summary_text.delta`,
  `response.output_item.added`/`response.function_call_arguments.delta` (tool accumulation),
  `response.completed` (usage `input_tokens`/`output_tokens`, finish from
  `incomplete_details.reason`), `response.failed`/error → adapter error. Discovery `GET {base}/models`.
- **anthropic-messages** — `POST {base}/v1/messages` (baseURL normalization: no double `v1`),
  headers `x-api-key` + `anthropic-version: 2023-06-01`. Messages converted: system → `system`;
  assistant tool calls → `tool_use` blocks; tool results → `tool_result` blocks in a user
  message; consecutive same-role messages merged (Anthropic requires alternation); attachments →
  `image` base64 blocks; `max_tokens` required (default 4096 when unset). Parses SSE
  `content_block_delta` (`text_delta`, `thinking_delta`, `input_json_delta` accumulation),
  `message_delta` (stop_reason + `output_tokens`), `error` events. Finish map:
  `tool_use→tool_calls`, `end_turn|stop_sequence→stop`, `max_tokens→length`. Discovery `GET {base}/v1/models`.
- **Errors:** every adapter failure becomes an `Error` whose message carries HTTP status +
  provider id + recovery hint, e.g. `provider "openai": HTTP 401 — check the API key in
  Settings → Models, then retry.` Cancellation = existing abort path (`llm.ts:226`, `498-501`)
  must work identically for all three (abort → generator ends as cancellation, agent treats it
  as non-failure at `agent.ts:499-501`).
- UI protocol choices = exactly these three (tested). No others offered.

## 6. Settings API + guard (audit)

New routes (all under `/api/settings/…`, JSON only), plus `GET/PUT /api/settings`:

| Route | Purpose |
|---|---|
| `GET /api/settings` | general (approval.mode, storage paths, key precedence, endpoint), providers (NO secrets, credential `describe` only), default `{provider, model}`, agent block (non-secret), mcp status, `supported: {...}` flags for status-only tabs |
| `GET/POST /api/settings/providers`, `PUT/DELETE /api/settings/providers/:id` | CRUD; `?force=1` for in-use delete |
| `GET/PUT /api/settings/providers/:id/models` | catalog read / validated replace (atomic) |
| `GET/PUT/DELETE /api/settings/providers/:id/credential` | status / set / clear — value accepted on write only |
| `POST /api/settings/discover` | draft discovery `{baseURL, protocol, apiKey?}` — one-shot key, never persisted |
| `GET/PUT /api/settings/default` | default provider+model (validated against registry + catalog) |
| `GET/PUT /api/settings/general` | approval.mode (`off|risky|all`) via new `ApprovalService.setMode()` |

**Guard (applies to every `/api/settings/*` request):**
1. `Host` header hostname must be loopback (`127.0.0.1`, `localhost`, `::1`) → else `403`
   (DNS-rebinding defense; console already assumes loopback).
2. If `Origin` is present it must equal `http://<Host>` → else `403` with recovery hint.
3. Mutations (POST/PUT/DELETE) must send `content-type: application/json` → else `415`
   (blocks CORS-safelisted `text/plain` CSRF, same rule as CI `web.ts:294`).
Validation failures → `400 {error, hint}`; unknown provider → `404 {error, hint}`.

**Delete-in-use recovery:** `DELETE` first runs usage detection (sessions with
`provider === id`). In use + no force → `409 {error, inUse: {sessions: [{id, title}]}, hint}`.
With `?force=1`: sessions' `provider` field is cleared (they fall back to default
`{provider, model}`) and the response returns `{deleted: ProviderEntry, detachedSessions, fallback}`
— the UI shows the affected sessions + fallback, then offers **Undo** (re-POST the returned entry
with its original id).

## 7. Hot-apply (next request, not in-flight)

- Registry keeps in-memory state; every mutation = validate → atomic file write → update memory.
- `LLMService.stream()` resolves a `ProviderProfile` snapshot **once, at request start**
  (DSH `prepareCall` pattern): retries and the whole stream use that snapshot; a settings save
  during the run cannot change endpoint/credentials mid-flight.
- `GenerateOptions += provider?: string`; agent passes
  `options.provider ?? session.provider ?? default` (`agent.ts:182` area) into `ctx.llm.stream`.
- `/api/chat` accepts `provider`, persists `session.provider` when explicitly chosen (like
  `session.model` today at `web.ts:435`).
- `approval.setMode()` is read per gate call → next approval sees it; pending gates keep their
  current queue.

## 8. `/api/state` + chat with multiple providers

- If `providers.json` exists: `models` = union of persisted catalogs, each item
  `{id, provider, providerName, displayName, context, maxOutput, inputs: {vision, tools, reasoning}}`;
  virtual `default` keeps live-fetch fallback (existing `listModels()` + `contextCatalogUrl`).
  With no file: exactly today's shape (legacy path — current console code keeps working).
- `default: {provider, model}` and `providers: [{id, displayName, protocol, credential: {configured, source}}]` added.
- Chat validation (vision/tools checks at `web.ts:425-431`) prefers catalog capabilities,
  falls back to live BotConnector fields (today's logic).
- Composer/header pickers render `<optgroup label="provider display name">` with option values
  `providerId::modelId` (legacy ids without `::` map to the default provider).

## 9. UI

- `web/settings.js` — pure helpers (classic script, badge.js pattern, unit-tested):
  provider form validation messages, `groupModelsByProvider`, credential source labels,
  delete-recovery copy builder, discovery-result diff (new/dup/manual), option value encode/parse.
- `web/index.html` — **Settings** button in the rail footer + `<dialog id="settings-dialog">`
  with tab nav (General | Models | Plugins & MCP | Agent). Skeleton only; app.js renders content.
- `web/settings.css` — new file (zero collision with the console session's `app.css`/`brand.css`
  edits); DSH-like neutral surfaces, cyan primary (`#33C9DC`), Bico mark in dialog header,
  focus-visible rings, ≥44px touch targets, works at 390px (stacked forms), light + dark via
  existing theme tokens.
- `web/app.js` — settings controller (load `GET /api/settings`, render tabs):
  - **General:** approval mode select (real PUT), storage paths, key precedence explainer,
    console endpoint, status-only rows (language: English only; account: not available) with
    plain status text — no buttons.
  - **Models:** default provider+model pickers; provider cards (name, base URL, protocol badge,
    credential chip `configured via env/local/not configured`, model count) with Edit/Delete;
    add/edit form (display name, Base URL, protocol select [3 tested], API key password field
    with "leave blank to keep existing", optional env var name, **Fetch models** draft probe);
    per-provider model list: search, rows (id, display name, context, max output, vision/tools/
    reasoning toggles, remove), manual **Add model** row, **Fetch models** merge (candidates only —
    user saves), Save writes catalog atomically.
  - **Plugins & MCP:** real plugin/tool lists (`/api/plugins`) + real MCP server states
    (`state.mcp`); note: "Servers are configured in switchboard.config.jsonc" — read-only, no add button.
  - **Agent:** real current values (system source, maxSteps, temperature, maxTokens,
    maxPromptTokens, keepRecent, approval mode) + explicit "Agent presets are stage 2 — not
    editable here yet" status. No fake controls.
- Delete flow: in-use → confirm dialog listing sessions + fallback → force delete → notice with
  **Undo**. Credential field never renders a stored value (only `configured` chip + clear button).
- Getting-started dialog step 1 updated to point at Settings → Models (targeted edit preserving
  the console session's content).
- All copy English; errors carry the recovery step ("…then retry", "…in Settings → Models").

## 10. Testing strategy (stubs + temp dirs only; never real credentials)

1. `scripts/test-providers.mjs` — registry CRUD, slug stability/immutability, validation errors,
   atomic persistence (temp dir), in-use detach helper, credential precedence matrix, write-only
   guarantee (every describe/serialize path lacks `apiKey`), mode 0600.
2. `scripts/test-adapters.mjs` — three stub HTTP servers; per protocol: streaming text +
   reasoning, single/multi tool calls, usage + finish mapping, abort mid-stream (server observes
   close; generator ends as cancellation), HTTP 401/400/500 error text with recovery hint,
   discovery (correct URL, auth header shape: Bearer vs `x-api-key`).
3. `scripts/test-settings-api.mjs` — boots `createHost` (temp settings dir, port 0, stub
   providers): guard matrix (bad Host→403, cross Origin→403, text/plain→415), CRUD roundtrip,
   credential GET/PUT/DELETE semantics, draft discovery key not persisted, default validation,
   delete 409→force detach+fallback, approval setMode, **hot-apply chat**: slow provider A run
   in flight → save switch to B → in-flight finishes on A, next request hits B, `session.provider` persisted.
4. `scripts/test-settings-ui.mjs` — `web/settings.js` helpers (badge.js loading pattern).
5. Existing 15 suites must stay green (`npm test`) — no edits to the console session's
   uncommitted test files; my tests are new files (wired into `package.json` scripts).
6. Browser E2E (agent-browser): add provider → save → discover + manual model → select →
   chat (local stub LLM) → edit → delete (in-use recovery + undo) → reload persistence;
   plus: 400/401 error copy, key redaction (DOM never contains the key), mobile 390×844,
   dark/light screenshots. Screenshots under `.shots/` (ignored).

## 11. Explicit non-goals (stage ≥ 2)

Skills, compaction, memory recall, automation/reminders, channels, browser/sandbox execution,
editable agent presets, MCP server CRUD, reasoning-effort pickers, OAuth, desktop/SDK.
bccli features count only if integrated here with source + tests — none are assumed.
