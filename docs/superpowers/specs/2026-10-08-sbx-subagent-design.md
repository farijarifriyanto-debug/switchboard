# Design: Subagent delegation — worker tool, parallel fan-out, background jobs (v1)

Date: 2026-10-08
Status: approved by user (design sections 1-5 + approach A); revised 2026-10-08
  after code verification (worker prompt storage, anti-recursion dispatch,
  inject/wake state machine, job status lifecycle, validation, cancellation);
  2nd revision same day per user: hard per-session run mutex in the loop,
  empty-flush stop, explicit wake-rearm triggers, unload lifecycle;
  3rd revision same day per user: `.return()` full cleanup contract
  (mutex + terminal status + single run-end event) and contention policy
  (the winning run processes the already-injected batch — no deferred wake,
  no marker) — exactly ONE open decision (§14: abandoned-run watchdog,
  kept open for v1)
Scope: new subsystem — subagent delegation for Switchboard; second sub-project
  of the 5-item roadmap (MCP done; order: subagent → model adapter → plugin
  manager; sandbox deferred by user)

## 1. Goal

Let the parent model hand off self-contained sub-tasks to an isolated worker
agent that runs its own loop in its own context and returns a compact final
report — keeping the parent's context window slim while offloading work.

All three capabilities ship together (user: "1 2 3 semua di kerjakan"):

- **Worker tool** — `task` spawns a child agent (own session, own loop).
- **Parallel fan-out** — one call carries a batch of tasks run concurrently
  (blocking batch: parent waits for all, receives all summaries together).
- **Background jobs** — batch started with `background: true` returns job IDs
  immediately; results are auto-injected into the parent session and the
  parent is woken (auto-run).

## 2. Decisions taken with the user

| Question | Decision |
|---|---|
| Roadmap order | subagent → model adapter → plugin manager (sandbox skipped for now) |
| Feature shape | all three: worker tool + parallel fan-out + background jobs |
| Child tool access | all parent tools except `task` itself (anti-recursion; no allowlist v1) |
| Visibility | every subagent is a real persisted session (`kind: 'subagent'`, `parentSessionId`) |
| Parallel semantics | blocking batch — parent waits for the whole batch, results returned together |
| Background result delivery | auto-inject (not pull/polling) — over the recommendation for event + `jobs` tool polling |
| Auto-inject timing | **inject + wake** (auto-run on completion) — over the recommendation for inject-without-wake; guardrails below |
| Implementation | Approach A — reuse the existing agent loop via new optional `stream()` options + thin orchestrator plugin (over a copied loop, over a separate process) |
| User-run ↔ auto-wake exclusion (2nd revision) | hard **per-session run mutex in the agent loop** — a second concurrent run on the same session fails fast; orchestrator-side `busy` deferral remains the scheduling layer (supersedes the previously open question) |

## 3. Config schema

```jsonc
"subagent": {
  "enabled": true,        // false → tool `task` is not registered
  "maxParallel": 3,       // concurrency wave size for a batch
  "maxSteps": 8,          // default step budget per child
  "autoResume": true      // false → results still inject, but never auto-run
}
```

- **Gate:** unlike `mcp`, the feature is ON by default — a missing `subagent`
  block means the defaults above. `enabled: false` is the only off switch.
- Validation at config load (pola `validateMcpServers`): `enabled` and
  `autoResume` must be booleans; `maxParallel` and `maxSteps` must be numbers
  satisfying `Number.isInteger(v) && Number.isFinite(v) && v >= 1` (rejects
  `2.5`, `NaN`, `Infinity`, `0`, negatives) — a violation throws an error
  naming the key; unknown fields inside the block warn, not fail.
- The tool name is exactly `task`; it is registered by the orchestrator
  plugin only when `enabled`.

## 4. `task` tool contract

Input:

```jsonc
{
  "tasks": [                          // required, 1..N entries
    {
      "description": "what to do",    // required
      "context": "optional briefing", // appended to the child prompt
      "model": "override-model",      // optional, child-only
      "maxSteps": 4                   // optional, child-only
    }
  ],
  "background": false                 // optional, default false
}
```

One call = one batch (array-of-tasks shape keeps parallelism inside the tool,
so the parent loop's sequential tool execution stays untouched).

Child prompt = worker system prompt + `description` (+ `context`) + the
instruction: report results concisely as a single final message.

**Worker system prompt — how it is applied and stored (verified against
`src/services/session.ts` + `src/plugins/agent.ts`):**

- `SessionData` has no `system` field; `sessions.create({ system })` stores it
  as the session's first `role: 'system'` message, and `stream()` **overwrites
  the system message of every run** from its base prompt. Therefore the worker
  prompt must be supplied by the caller on **every** child run, not only at
  creation:
  - The orchestrator passes `options.system = WORKER_SYSTEM_PROMPT` on each
    `ctx.agent.stream(...)` call for a child (including a resumed child
    session). `sessions.create({ system: WORKER_SYSTEM_PROMPT, … })` stores it
    so the session reads correctly even before the first run and after
    `hydrate()`.
- `options.system` replaces only the raw base (the closure's `config.system`
  role). The standard wrappers apply on top exactly as for the parent:
  `PLATFORM_HINT` (if absent), `withAgentsMd` (project + global), and the
  per-turn `withDateContext` + `withMcpInstructions` — children keep working
  dates, project instructions and MCP server instructions.
- Content of `WORKER_SYSTEM_PROMPT` (pinned constant in
  `plugins/subagent.ts`): identifies the child as a delegated Switchboard
  worker with full tool access, states that only `description`/`context`
  define the task, forbids spawning further tasks (no `task` tool is
  available), and requires a single concise final report (no preamble).

Output, blocking (default) — JSON text:

```json
[{ "description": "…", "status": "ok", "result": "summary…" },
 { "description": "…", "status": "failed", "error": "…" }]
```

All results are returned after the entire batch completes; one failed task
never cancels the others.

Output, `background: true` — immediately, without waiting:

```json
[{ "jobId": "j-7f3a", "sessionId": "s-…", "description": "…" }]
```

**Argument validation (all before any session or job is created — a batch is
all-or-nothing):** evaluated in order, first violation returns the visible
`Error: …` result (repo convention; `execute()` never throws, no child is
spawned for a partially-valid batch):

- `tasks` must be an array with length ≥ 1;
- each entry must be a plain object;
- `description`: string, non-empty after trim;
- `context`: if present, string; `model`: if present, non-empty string;
- `maxSteps`: if present, `Number.isInteger && Number.isFinite && >= 1`;
- `background`: if present, exactly boolean (`"true"` is rejected);
- unknown entry fields warn (pola config-unknown-field) but do not fail.

## 5. Parallel batch mechanics

- Promise pool of `maxParallel` (5 tasks, maxParallel 2 → waves 2+2+1); each
  child is an `ctx.agent.stream(...)` generator driven concurrently inside
  `Promise.all` per wave. Every child generator is consumed inside
  `try { for await … } finally { … }` — completion/failure bookkeeping and
  status writes run even when the wave rejects or the batch is aborted.
  Background batches use the same pool: jobs enter `running` as their wave
  starts (`queued` until then).
- Anti-recursion is enforced in **two layers** (verified against
  `src/services/tools.ts` and `src/plugins/agent.ts`):
  1. **Hidden:** `ctx.tools.defs()` is filtered by `excludeTools` inside
     `streamTurn`, so `task` never appears in the child's `tools[]`;
  2. **Rejected:** a hallucinated/forced call must not execute. `ToolContext`
     gains `deny?: string[]`; the loop forwards `options.excludeTools` in
     every `ctx.tools.call` ToolContext, and `ToolsService.call()` returns
     `Error: tool "<name>" is not available to this agent` when
     `ctx.deny?.includes(name)` — checked **before** the approval gate, with
     no side effects (no approval prompt, no registration change, no new
     child). The model receives a normal tool result it can react to.
- Concurrency safety: children share the global tool registry; approval gates
  key on the child's `sessionId`, so concurrent children never share approval
  state.
- **AbortSignal linking (blocking and background):** each child/job gets its
  own `AbortController`; at spawn time it is linked to the run's
  `ToolContext.signal` (the parent run's controller). Consequences:
  - Stop during that same parent run aborts the link → all children of the
    batch stop; queued background jobs transition to `failed` ("aborted
    before start"), running ones to `failed` ("aborted");
  - when the parent run **ends normally**, its controller is never aborted,
    so already-started background jobs keep running detached (the link is
    inert from then on — background jobs are NOT bound to any later run; a
    Stop on a subsequent parent run uses a fresh controller and does not
    touch older jobs).

## 6. Child session model

- Child = real session via `ctx.sessions.create(...)`, titled from
  `description`, with new optional persisted metadata:
  `{ kind: 'subagent', parentSessionId, jobId? }` (jobId set only for
  background tasks). Metadata rides the JSONL store and is exposed through
  `list()`/`GET /api/state` as new optional fields (existing consumers
  unaffected).
- The child inherits the parent's workspace root, provider and default model
  (per-task `model`/`maxSteps` override via stream options).
- `sbx sessions` and the console trace show child sessions like any other;
  no dedicated panel or CLI in v1.

## 7. Background jobs: registry, inject/wake state machine

### 7.1 Job registry (in-memory, `plugins/subagent.ts`)

```
jobId → { sessionId, parentSessionId, status, result?, error?,
          startedAt?, finishedAt? }
status: 'queued' | 'running' | 'done' | 'failed'
```

Transitions and timestamps (verified against pool + loop behavior):

| Transition | When | `startedAt` | `finishedAt` |
|---|---|---|---|
| → `queued` | background `task` returns; job registered, wave not yet started | unset | unset |
| `queued` → `running` | the job's pool wave starts its `stream()` | set (now) | unset |
| `running` → `done` | child yields a final answer with `stopReason: 'answer'` | kept | set (now) |
| `running` → `failed` | child LLM error, approval timeout, `stopReason: 'step_limit'`, or abort while running | kept | set (now) |
| `queued` → `failed` | parent run aborted before the wave started (or plugin unload) | **stays unset** | set (now) |

Not persisted across restarts — the child session itself is permanent, so a
finished result remains readable from it (documented limitation). Terminal
jobs are never re-run.

### 7.2 Per-parent state machine

State kept per parent `sessionId` in the orchestrator:

```
pending: Array<Injection>     // FIFO of not-yet-delivered results
busy: boolean                 // a run is in progress on this session
wakeToken?: symbol            // an auto-wake this orchestrator started owns the session
wakeBlocked: boolean          // set after a wake failure; cleared only by an explicit re-arm trigger (below)
flushScheduled: boolean       // setImmediate dedupe
```

Plus one orchestrator-wide flag, `disposed` (§7.3), checked first by every
flush and every async continuation.

**Busy tracking** uses the loop's `run/event` lifecycle (verified in
`src/plugins/agent.ts` + `src/events.ts`):

- `turn_started` (emitted synchronously at run start, before the first model
  call) → `busy = true`;
- `turn_completed` | `cancelled` | `error` (the ways a run can end —
  including the cleanup-emitted `cancelled` from the generator `finally`,
  §8) → `busy = false`, then wake release + flush.

Note: `agent/done` is emitted ONLY for a clean final answer; cancelled and
failed runs emit only `run/event`. Flush is therefore triggered by
`turn_completed`/`cancelled`/`error` (with `agent/done` as an idempotent
secondary trigger — both fire on clean ends; `flushScheduled` dedupes).

**Flush** (scheduled via `setImmediate` — one event-loop turn, so completions
that arrive in the same turn are merged into a single flush):

1. If `disposed` (§7.3) → return.
2. If `pending` is empty → return **immediately, before any other check**.
   A flush with nothing to deliver can never reach the wake step, so the
   `wake`'s `finally` → `scheduleFlush()` chain terminates as soon as no new
   result arrived — no wake ever starts on an empty queue, and a completed
   wake cannot cascade into another wake. (Nothing except a job completion
   pushes into `pending`, so an empty queue means nothing new happened.)
3. If `busy` → return (queue waits for the next run end).
4. If `wakeToken` set → return (the wake's own end-of-run will flush).
5. Splice **all** pending injections, append them in order to the parent
   session, `role: 'user'`, content `[job <jobId> selesai] status: ok|failed\n<result or error>`
   (parent session gone → discard the whole batch, info log). Delivery does
   NOT depend on a healthy wake: results spliced here are in the session even
   if no wake ever runs afterwards (e.g. while `wakeBlocked`, step 7).
   **Steps 3–5 are ONE synchronous critical section** — no `await` between
   the `busy` check and the splice (JSONL persistence is queued, not
   awaited here) — so no run can start in between: a competing run either
   was already active (caught at step 3) or starts strictly AFTER the
   splice (a run's start sets mutex + `turn_started` in one synchronous
   section). This closes the reverse race as well: a wake that loses the
   contention race (step 8) has by construction already delivered its
   injection before the winner began.
6. If `autoResume: false` → stop (injection delivered, no run started).
7. If `wakeBlocked` (wake-failure policy below) → stop (injection delivered;
   resuming auto-wake requires an explicit re-arm trigger).
8. Acquire `wakeToken = Symbol()` and start the wake:
   `for await` fully consuming
   `ctx.agent.stream('', parentSessionId, { signal: wakeSignal })`
   — `wakeSignal` from the orchestrator-wide wake `AbortController`
   (aborted on unload, §7.3); empty prompt adds no user message; the model
   reads the injected lines.
   - If `stream()` refuses with the per-session mutex error (§8) because a
     user run won the race: this is **contention, not failure** — and the
     wake is NOT rescheduled (decision, 3rd revision). Because steps 3–5
     are synchronous, the batch was fully injected BEFORE the winning run
     started, so the injected lines are part of that run's context: **the
     winning user-run processes the results as part of its own turns, no
     extra wake and no wake-pending marker are needed.** Action: release
     the token and stop. (The generic `finally` below may still call
     `scheduleFlush()`; with an empty queue it is a no-op per step 2 —
     nothing in the design relies on it to deliver a deferred wake.)
     Later job completions push into `pending` and flush normally.
   - Any other throw → wake-failure policy (below).
   In its `finally` (guarded `if (!disposed)`): **release only if
   `wakeToken` still equals this wake's token**, then `scheduleFlush()` —
   combined with step 2, this re-flush is a no-op unless something new
   arrived during the wake (in which case it is injected and possibly
   wakes once — a bounded chain driven by real results, never by empties).

**Guarantees mapped to the requirements:**

- *No mid-run injection — both directions:* injections happen only from
  flush, whose steps 3–5 are one synchronous critical section gated by
  `busy` (`busy` flips together with the mutex at `turn_started`, which the
  loop emits before any await); therefore a flush never injects into an
  already-running run, AND a run never starts between the `busy` check and
  the splice — if a run wins the later contention race at wake start, the
  splice already preceded it (§7.2 step 8).
- *Queue always drained after a run ends:* every run ending emits one of
  `turn_completed`/`cancelled`/`error` → handler releases wake (if ours) and
  schedules flush — including the cleanup-emitted `cancelled` produced by
  the generator `finally` when a caller closes a live run with `.return()`
  (§8), so pending injections are processed even after an abandoned
  `.return()` close (§10 test 13(c)).
- *Completions during an active wake are not lost:* they append to `pending`
  (`wakeToken` set blocks immediate flush) and are drained by the wake's
  `finally` → `scheduleFlush()`.
- *Several completions merge into one wake:* completions arriving before the
  scheduled flush executes (same event-loop turn) share one snapshot and one
  wake; completions arriving later (during the wake) form the next batch.
- *User runs and auto-wake never overlap — TWO layers:* (a) orchestrator
  side — flush refuses to inject/wake while `busy`, and never holds more
  than one `wakeToken` per session; (b) **hard, loop-level** — the
  per-session run mutex in `stream()` (§8) refuses any second run on an
  active session, so even a race that slips past the `busy` check (a user
  run starting between flush's step 3 and the wake's `stream()` entry) ends
  as contention refusal (the winner processes the already-injected batch,
  §7.2 step 8), never as two interleaved runs. The requirement is
  met by the loop mutex, not by the flag alone.
- *No empty wakes:* flush stops at step 2 when nothing is pending, so a
  wake's `finally` → `scheduleFlush()` never spawns a follow-up wake unless
  a real job result arrived meanwhile.
- *`autoResume: false` still injects:* steps 1–5 always run; only the wake
  (steps 6–8) is skipped — a run is never started by the orchestrator.

**Known edge (see §14):** if a run's generator is abandoned by its caller
before any end event (dropped mid-iteration without `.return()`), both
`busy` and the loop's run mutex stay held — the queue for that session
starves, mirroring the same pre-existing situation where `session.status`
also stays `working`. The orchestrator does not add a watchdog in v1.

**Wake failure — injection stays safe, auto-wake needs an explicit re-arm
trigger:** a wake that throws any error other than mutex contention (session
deleted mid-flight, LLM error at turn 1) logs, marks the parent session
`failed` via the normal run epilogue, releases its token in `finally`, and
sets `wakeBlocked = true` for that parent. While `wakeBlocked`:

- pending results are NOT lost: the next flush still delivers them
  (step 5) — injection never depends on a working wake;
- no auto-wake starts (step 7), including from the failed wake's own
  `finally` → `scheduleFlush()` (pending is drained by injection, so the
  next flush empties the queue and stops at step 2 anyway);
- `wakeBlocked` is cleared ONLY by an explicit trigger: (i) a **new job
  completion** for this parent, or (ii) the **end of a user-initiated
  (non-wake) run**. Only after such a trigger may the next flush start a
  wake again. Consequence (documented): if every pending result was already
  injected while blocked and no new job ever completes, restoration of the
  trigger does not fire an immediate wake — auto-resume is re-armed for the
  next completion; results already sit in the session for the user's next
  run to process. Automatic retry immediately after failure is
  deliberately NOT a trigger (prevents a wake-failure loop).

**Guardrail consequence (accepted by user):** with `autoResume: true` the
model can start a turn on its own after a job completes. `autoResume: false`
is the escape hatch; approval mode still applies to anything the woken turn
tries to do (a wake can sit in `waiting_approval` like any run — `busy`
stays true until it settles).

### 7.3 Disposal — plugin unload / host shutdown

Cleanup runs in the orchestrator's `ctx.effect` disposal (so both hot-reload
and `sbx web` shutdown hit it). Order matters; `disposed` is set FIRST:

1. `disposed = true` (every async continuation in the orchestrator
   re-checks this flag before any side effect).
2. Abort the orchestrator-wide wake `AbortController` → any active wake run
   receives the abort and ends through the normal `cancelled` end event; its
   `finally` sees `disposed` and performs NO re-arm (no token release dance,
   no `scheduleFlush`).
3. Abort every job `AbortController`: `queued` → `failed` ("aborted before
   start (unload)", `startedAt` stays unset), `running` → `failed`
   ("aborted (unload)").
4. Clear `pending` (undelivered results dropped — documented limitation;
   child sessions remain readable) and reset all per-parent state
   (`busy`, `wakeToken`, `flushScheduled`, `wakeBlocked`).
5. Clear the job registry.
6. **Late-callback guard — ORCHESTRATOR-side only:** any pool bookkeeping,
   job-completion handler, scheduled `setImmediate` flush, or wake re-arm
   belonging to the orchestrator that fires after `disposed` returns
   immediately WITHOUT side effects — no registry write, no `pending`
   append, no `subagent/*` event, no flush, no wake start. A completion
   callback that was already queued when step 3/5 ran therefore cannot
   resurrect a cleared entry or re-populate a cleared queue (it checks
   `disposed` first, not the old entry it captured).

   **Scope clarification:** the guard does NOT suspend the agent loop's own
   cleanup. When the wake (or any run) is aborted by steps 2–3, the loop
   still publishes its normal close — the `cancelled` run-end event, the
   terminal `session.status` transition, trace write, mutex release — and
   that is REQUIRED (it is how the cancelled run ends; without it the run
   would leak as `working`). Those loop-emitted events are merely
   OBSERVED-AND-IGNORED by the disposed orchestrator: its listeners see
   `disposed` and perform no flush, no re-arm, no registry access. Only
   side effects the orchestrator itself would initiate are forbidden after
   disposal.

## 8. Loop changes (`src/plugins/agent.ts`, `src/services/tools.ts`, `src/types.ts`)

`stream(prompt, sessionId?, options)` gains four optional fields — defaults
keep today's behavior byte-identical:

```ts
options: {
  signal?, attachments?,              // unchanged
  system?: string        // raw BASE system for THIS run (see below)
  model?: string         // overrides resolveModel(session.model)
  maxSteps?: number      // overrides the configured loop budget
  excludeTools?: string[] // hidden from tools[] AND denied by the dispatcher
}
```

- `system`: replaces the closure base for this run — used both when creating
  a new session (`sessions.create({ system })`, i.e. persisted as the first
  system message) and in the per-turn system re-assembly (which today always
  overwrites the session's system message from the closure base). Wrappers
  (platform hint, AGENTS.md, date, MCP instructions) still apply on top.
  Omitted → today's closure base (no behavior change for existing callers).
  The orchestrator passes it on **every** child run (§4).
- `excludeTools`: two enforcement points (§5) — filtered in `streamTurn`
  before `defs()` is built, and forwarded as `ctx.deny` in every
  `ctx.tools.call` ToolContext of this run; `ToolsService.call()` rejects
  denied names with `Error: tool "<name>" is not available to this agent`
  before the approval gate. The registry itself is untouched (`task` stays
  visible to the parent and in `sbx tools`).
- **`AgentEvent` final gains an additive optional field**
  (`src/types.ts`): `{ type: 'final'; content: string; steps: number;
  stopReason?: 'answer' | 'step_limit' }`. The step-limit epilogue (loop
  exits at `maxSteps` with no answer) yields `stopReason: 'step_limit'`;
  a real final answer yields `stopReason: 'answer'`. Without this field the
  two finals are indistinguishable by content/steps (a legitimate answer can
  also land on the last allowed step). Existing consumers ignore the new
  field (non-breaking). The orchestrator maps `step_limit` → task/job
  `status: 'failed'` with the note as `error` (no final report ⇒ failure).

**Per-session run mutex — hard mutual exclusion (new in the 2nd revision):**

- The loop keeps a per-session active-run token (`Map<sessionId, runToken>`
  in the agent plugin). `stream()` with a `sessionId` whose run is already
  active **fails fast** with `Error: session "<id>" is already running` —
  before appending any message, before touching `session.status`, before
  emitting any event. A contention refusal is NOT a run failure: it never
  sets the session to `failed` and never emits a run-end event.
- The token is acquired when the run starts and released in the stream
  generator's **`finally`** block — so it is released on clean final, on
  throw, on abort (Stop), and on caller-initiated generator
  `.return()`/`.throw()` (the ECMAScript guarantee: `finally` runs on
  generator closing). The orchestrator likewise drives every generator it
  owns in `try { … } finally { … }` (wake in §7.2, child waves in §5), so
  bookkeeping never depends on normal completion.
- **Generator-cleanup contract — `.return()` is a first-class close (3rd
  revision).** The loop tracks a per-run `endEmitted` flag (set whenever
  the normal epilogue publishes `turn_completed`/`cancelled`/`error`). The
  `finally` block then executes IN ORDER:
  1. release the run mutex;
  2. if `!endEmitted`: set the flag, force `session.status` to the
     terminal `cancelled` unless it is ALREADY terminal
     (`completed`/`failed`/`cancelled`), and publish EXACTLY ONE run-end
     event `cancelled` — same `run/event` shape as an abort.

  Consequence: closing a live generator via `.return()` cleans up ALL
  THREE observable layers in one place — the mutex frees up (a new run may
  start), `session.status` becomes terminal (no stuck `working`), and the
  run-end event flips the orchestrator's `busy` to `false`, so a queued
  pending-injection batch flushes right afterwards (injected + woken per
  `autoResume`) — §10 test 13(c). An already-ended run publishes nothing
  (flag guard): `.return()` after a clean final is a no-op. The emitted
  `cancelled` flows through the ordinary run-end handler in §7.2, so no
  special-case is needed in the orchestrator.
- The mutex is held for the ENTIRE run, including the `waiting_approval`
  pause (the run has not ended until a run-end event fires).
- Consequences: CLI/web starting a second run on a busy session get the
  visible error instead of interleaved runs; a wake that loses the race to
  a user run gets the same error and is treated as contention — its batch
  was already injected, so the winning run processes it with no deferred
  wake and no marker (§7.2 step 8), not as a wake failure; `busy` (§7.2)
  remains the orchestrator's scheduling flag, while the mutex is the
  enforcement — the exclusion requirement is satisfied at the loop level,
  not by the flag alone.
- A generator dropped WITHOUT `.return()` keeps the mutex held — the
  abandoned-run hazard; watchdog deferred (§14).

## 9. Events and surfaces

- New events in `src/events.ts`:
  `subagent/start` `{ sessionId, parentSessionId, tasks }`,
  `subagent/done` `{ sessionId, ok }`.
- Orchestrator exposes an optional `ctx.subagent` service (job listing for
  tests and future surfaces) via `ctx.reflect.provide`.
- No new CLI command, no new web API/panel, no new console UI in v1 —
  child sessions and their runs already surface through `sbx sessions`,
  `/api/state` and the run-event stream (explicit YAGNI, same rule as MCP §9).

## 10. Testing

- New suite `scripts/test-subagent.mjs` (test chain 13 → 14), hermetic
  (stub LLM via the `startStubLlm` pattern from `test-mcp`, no network/API key).
- Coverage (RED → GREEN per plan task), keyed to the six reviewed areas:
  1. **Validation (§3/§4):** config rejects `maxParallel`/`maxSteps` as
     `2.5`/`0`/`NaN`/`Infinity`/string and `enabled`/`autoResume`
     non-boolean, naming the key; tool args reject non-array `tasks`,
     empty batch, non-string/blank `description`, non-string `context`,
     non-string `model`, bad per-task `maxSteps`, string `"true"`
     background — and assert NO child session/job exists afterwards
     (all-or-nothing);
  2. **Loop options (§8):** `excludeTools` hides `task` from the child's
     `tools[]`; `model`/`maxSteps` overrides honored; no options ⇒ old
     behavior byte-identical (regression via existing suites);
  3. **Worker system prompt (§4):** child's system message equals
     `WORKER_SYSTEM_PROMPT` + wrappers at create AND still after a second
     `stream()` on the same child session (closure base must not clobber it);
  4. **Forced `task` invocation by child (§5):** child receives
     `Error: tool "task" is not available to this agent` from the dispatcher
     (no approval prompt, no new session created) even though the registry
     still holds `task`;
  5. blocking single task → child session has `kind: 'subagent'` +
     `parentSessionId`; result returned to parent;
  6. parallel waves: 5 tasks, `maxParallel: 2` → observed concurrency never
     exceeds 2, waves 2+2+1;
  7. mixed batch: one failed task, others still `ok`;
  8. background: job IDs returned immediately; on completion the parent
     session gains the `[job … selesai]` line and a wake run fires
     (`turn_started`/`agent/done` on the parent);
  9. **Inject/wake races (§7.2):** (a) job completes while parent run
     active → injected only after the run-end event
     (`turn_completed`/`cancelled`), never mid-run;
     (b) job completes while a wake is active → drained after that wake's
     `finally`, second wake fires, no injection lost; (c) three jobs
     completing in the same event-loop turn → one flush, one wake;
     (d) `autoResume: false` → injection happens, NO wake ever;
     (e) wake failure → parent `failed`, pending queue not auto-retried,
     host healthy;
  10. **Job status lifecycle (§7.1):** `queued → running → done` with
      `startedAt` set only when the wave starts; `queued → failed`
      ("aborted before start", `startedAt` unset) on parent abort before
      the wave; `running → failed` ("aborted") on abort while running;
      step-limit child → `failed` with the step-limit note as `error`
      (via `stopReason`);
  11. **Cancellation (§5):** parent abort stops all running children of the
      batch; a later parent run's Stop does NOT affect already-detached
      background jobs; plugin unload aborts queued+running jobs and clears
      the registry;
  12. worker-system + wake + status assertions re-checked after
      `sessions.hydrate()` round-trip (metadata + system message survive);
  13. **Per-session run mutex + generator cleanup (§8):** (a) a second
      `stream()` on an already-active session returns
      `Error: session "<id>" is already running` with NO message appended,
      NO `session.status` change, NO event emitted; (b) ending the first run
      normally releases the token (next run succeeds) and publishes its
      normal end event only ONCE (a later `.return()` on the closed
      generator emits nothing — `endEmitted` guard); (c) generator
      `.return()` mid-run cleans ALL THREE layers: token released (next run
      succeeds), `session.status` forced to terminal `cancelled`, exactly
      ONE run-end `cancelled` published (none before) → orchestrator
      `busy` clears AND a pending injection queued meanwhile is then
      flushed (injected + wake per `autoResume`, asserting the queue
      survives `.return()`); (d) Stop/abort releases the token too
      (loop's own `cancelled`, no second event from `finally`); (e) wake
      that loses the race to a user run → contention path: token released,
      parent NOT `failed`, NO rescheduled wake and NO wake-pending marker —
      assert the batch's injected lines are in the session BEFORE the
      winning run's prompt, appear in that run's first-turn context (stub
      captures the request), and no orchestrator-originated
      `turn_started` fires for that batch (the winner's own run is the
      only one); (f) `waiting_approval` still holds the mutex (second
      run refused while approval pending);
  14. **Empty-flush no-op (§7.2):** after a wake completes with nothing new
      arriving, the `finally` → `scheduleFlush()` chain performs ZERO wake
      starts (exactly one `turn_started` per delivered batch); a manual
      `scheduleFlush()` with an empty queue also starts nothing;
  15. **Wake failure re-arm triggers (§7.2):** (a) failed wake → parent
      `failed`, `wakeBlocked` set, pending KEPT; (b) subsequent flushes
      inject pending but start NO wake (including the failure's own
      `finally`); (c) auto-wake resumes ONLY after an explicit trigger —
      (i) a new job completion or (ii) a user-run end — and then fires
      exactly once; no trigger ⇒ no wake, injections still delivered;
      (d) mutex-contention on wake start is NOT `wakeBlocked` (deferral
      only, no `failed` status);
  16. **Unload lifecycle (§7.3):** (a) unload aborts the active wake
      (cancelled end event, no re-arm, no further flush); (b) queued jobs →
      `failed` "aborted before start (unload)" with `startedAt` unset,
      running → `failed` "aborted (unload)"; (c) `pending` and registry
      cleared; (d) a job-completion callback firing AFTER unload writes
      nothing to the registry, appends nothing to `pending`, and causes no
      `turn_started` (late-callback guard, including a callback that
      captured pre-dispose state).
- Live canary (manual gate): `sbx run` against the real BotConnector
  endpoint with 2 parallel blocking tasks + 1 background task; evidence:
  child sessions listed, injected line + auto-run visible in the trace.

## 11. Explicit scope cuts (documented, not silent downgrades)

| Capability | v1 | Rationale |
|---|---|---|
| Tool allowlist/denylist per task | all tools except `task` | user picked the simple option; allowlist deferred |
| Job registry persistence | in-memory only | child session persists; restart loses pending injections only |
| Console panel / CLI for jobs | none | sessions + events already surface everything (YAGNI) |
| Polling `jobs` tool | none (auto-inject chosen) | event stream covers observability |
| Read-only / sandboxed children | unsandboxed like parent | sandbox is a separate roadmap item (user skipped it) |
| Recursive nesting depth > 1 | blocked by design | user chose anti-recursion |
| Cross-process isolation | same process | Approach A/B trade-off acknowledged |

## 12. Files

| File | Change |
|---|---|
| `package.json` | `test:subagent` script + chain (13 → 14) |
| `src/config.ts` | `subagent` block parse/validate (`validateSubagent`) |
| `src/plugins/agent.ts` | optional `stream()` options: system/model/maxSteps/excludeTools; final event `stopReason`; per-session run mutex with `finally`-based release |
| `src/services/session.ts` | optional persisted metadata: kind/parentSessionId/jobId |
| `src/services/tools.ts` | `ToolContext.deny` check in `call()` (before approval gate) |
| `src/types.ts` | `AgentEvent` final gains `stopReason?: 'answer' \| 'step_limit'` |
| `src/plugins/subagent.ts` (new) | `task` tool, validation, promise pool, job registry, inject/wake state machine |
| `src/events.ts` | `subagent/start`, `subagent/done` |
| `src/index.ts` | wire the orchestrator (after agent-loop) |
| `scripts/test-subagent.mjs` (new) | suite #14 |
| `README.md`, `switchboard.config.jsonc` | docs + commented sample (final plan task) |

## 13. Error-handling summary

| Failure | Behavior |
|---|---|
| Invalid `task` args (non-array/empty batch, missing/blank description, wrong types) | visible `Error:` result naming the offending key/index; NO session or job created (all-or-nothing validation) |
| Schema-invalid `subagent` config block (non-integer/non-finite/`<1` maxParallel/maxSteps, non-boolean flags) | host refuses to start naming the key; unknown fields warn |
| Child LLM error / approval timeout / tool crash | that task/job `status: failed` with error; siblings unaffected; host unaffected |
| Child hits `maxSteps` without a final report | `stopReason: 'step_limit'` → task/job `failed`, error = the step-limit note |
| Forced/hallucinated `task` call by a child | dispatcher `Error: tool "task" is not available to this agent` (before approval gate, no side effects) |
| Parent abort (Stop) in the same run | signal fans out: running children aborted, queued jobs → `failed` ("aborted before start"), running jobs → `failed` ("aborted") |
| Parent abort in a LATER run | no effect on older detached background jobs (fresh controller per run) |
| Second `stream()` on an already-running session | loop refuses: `Error: session "<id>" is already running` — no message, no status/event change; if it is a wake → contention: batch already injected (sync critical section) → the winning run processes it from its own context; token released; NO rescheduled wake, NO wake-pending marker; not a failure |
| Caller closes a live run via generator `.return()`/`.throw()` | `finally` (§8): mutex released → status forced to terminal `cancelled` (unless already terminal) → exactly ONE run-end `cancelled` published if none yet → orchestrator `busy` clears, pending injections flush; `.return()` after a clean final = no-op |
| Wake run throws (non-contention) | log + parent `failed`; token released in `finally`; `wakeBlocked` set — pending stays injectable, no auto-wake until an explicit re-arm trigger (new job completion / user-run end); no immediate retry |
| Job completes, parent session deleted | injection discarded (info log); child session kept |
| Plugin unloaded while jobs/wakes run | `disposed` set first: wake controller aborted (no re-arm), job controllers aborted (queued → `failed` "aborted before start (unload)", running → `failed` "aborted (unload)"), pending + registry cleared; late ORCHESTRATOR callbacks no-op (no registry write, no pending append, no wake) — the agent loop still emits the normal close for cancelled runs (end event, status, mutex), observed-and-ignored by the disposed orchestrator |
| `enabled: false` | `task` unregistered; orchestrator inert (jobs impossible) |

## 14. Open decision (kept open for v1 — NO user approval given beyond keeping it deferred; header and this section intentionally agree)

1. **Abandoned-run watchdog.** If a caller drops a run generator mid-flight
   WITHOUT calling `.return()` (no `finally` runs), both `busy` and the
   per-session run mutex (§8) stay held and that parent's injection queue
   stops draining — the same failure already leaves
   `session.status = 'working'` today, so this is a pre-existing hazard the
   orchestrator inherits. Generator cleanup via `finally` covers every
   disciplined closing path (completion, throw, abort, `.return()`); only
   the truly-abandoned case remains. Adding a timeout or a
   `session/status`-based recovery was not part of the approved design;
   v1 documents the edge instead of inventing a recovery mechanism. Status:
   open — not designed, not approved, deliberately deferred past v1 unless
   the user later requests it.

(Note: the user-run ↔ auto-wake mutual-exclusion question previously listed
here is RESOLVED (2nd revision): hard per-session mutex in the loop, §8.)
