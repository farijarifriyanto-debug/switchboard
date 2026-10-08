# Design: `on: schedule` + riwayat CI (Fase 3)

Date: 2026-10-07
Status: approved by user (section-by-section), pre-implementation
Scope: additive extension of the Fase 2 CI subsystem — scheduler in-process
  + history/retention/pagination/filter on the existing run store

## 1. Goal

Let Switchboard run CI workflows on a local cron schedule while `sbx web` is
up, and make the run history usable at scale (retention beyond 50 runs,
pagination, filtering, trigger badges, log download). This is Fase 3 of the
roadmap.

Explicit non-goals for v1: artifacts files per run, a separate scheduler
daemon/CLI, OS-level scheduler integration (Windows Task Scheduler / cron),
6-field or nickname cron (`@daily`), run notifications, a web cancel button.

## 2. Decisions taken with the user

| Question | Decision |
|---|---|
| Fase 3 direction | A: scheduler + riwayat (over UX/session polish, over MCP/subagents) |
| Scheduler runtime | in-process inside `sbx web` (30 s tick); alive only while the server runs |
| Schedule source | `on: schedule` in the workflow YAML (GitHub-Actions style) |
| History scope | retention + pagination + filter + log viewer polish; NO artifact files |
| Missed/overlap policy | catch-up at most 1× per tick + skip while previous run is still running |
| Enable gate | rides on `ci.enabled` — no separate flag |
| Architecture | pure module `src/ci/schedule.ts`, hand-rolled 5-field cron parser; no new dependency; stays inside the standalone (non-cordis) CI module |

## 3. Schedule format

Workflow file gains meaning for the `on:` field Fase 2 parsed and ignored:

```yaml
name: Nightly
on:
  schedule: "0 3 * * *"      # string form
  # or GitHub form:
  # schedule:
  #   - cron: "0 3 * * *"
```

- Both shapes are accepted: a bare string, or an array of `{ cron: "..." }`
  objects. Multiple entries are allowed; the workflow fires if ANY entry is
  due, and a tick produces at most ONE run per workflow (never duplicates).
- Cron is standard 5-field (`minute hour dom month dow`). Supported syntax:
  `*`, `*/n`, lists `a,b,c`, ranges `a-b`. Rejected with a clear validation
  error: nicknames (`@daily`), 6-field seconds, `?`, `L`, `#`.
- Invalid cron ⇒ the workflow still appears in listings but carries a
  schedule error (`sbx ci --list`, console) and never runs on a schedule.
  It never takes down the subsystem (same fail-safe spirit as rejected keys
  in Fase 2).
- Workflows without `on.schedule` are never scheduled — manual runs only,
  exactly as today. Other `on:` values (`push`, `workflow_dispatch`, …)
  stay ignored.

## 4. Scheduler runtime

Location: evaluation logic in `src/ci/schedule.ts` (pure, no cordis, no
timers); the tick loop lives in the web integration (`src/plugins/web.ts`)
and only exists while `ci.enabled` is true.

**Tick loop**

- `setInterval` every **30 s** while the web server is up; disposed with the
  plugin. Each tick calls `evaluateSchedules(workflows, now, state)`.
- Per workflow: compute `nextRun` after `state.lastFired`; if `now >= nextRun`
  the workflow is due.

**Catch-up 1× + skip overlap**

- A due workflow produces **at most one run per tick**, no matter how many
  scheduled times were missed (catch-up collapses: `lastFired` jumps to the
  most recent missed slot, not one run per missed slot).
- If the workflow's previous run is still `running`, the tick **skips the
  run but still advances `lastFired`** — so a long run does not trigger an
  immediate catch-up fire the moment it finishes.
- After a long sleep: the first tick after startup fires at most one
  catch-up run per scheduled workflow.

**State file:** `~/.switchboard/ci/<sha1(root).slice(0,12)>/schedule-state.json`

```jsonc
{ "version": 1,
  "workflows": { "nightly": { "lastFired": "2026-10-07T03:00:00.000Z" } } }
```

- Written atomically (tmp file + rename); only the scheduler writes it.
- Missing/corrupt/empty state ⇒ safe default: for a workflow never seen
  before, `lastFired` initializes to **now** (first fire = the next normal
  slot). No flood of catch-up runs after deleting the state file.

**Concurrency:** the scheduler calls the same `run()` path as CLI and web
triggers; the overlap check reads the store's last run for that workflow.
No new locking.

**Run record:** `trigger` gains `'schedule'` (currently `'cli' | 'web'`) so
history can show what fired the run.

## 5. History: retention, pagination, filter

**Store**

- `KEEP = 50` hardcode → config `ci.keepRuns` (default **200** when absent,
  floored at 10). Prune logic unchanged (drop oldest first).
- `listRuns` grows a query: `{ limit, offset, workflow, status }` →
  `{ runs, total, limit, offset }`. `workflow`/`status` are exact,
  case-sensitive; `limit` capped at 100; `offset` clamped to `total`.

**Web API (changes existing endpoint)**

```
GET /api/ci/runs?limit=20&offset=0&workflow=<id>&status=failed
  → { runs: [...], total, limit, offset }     # was: a bare array
GET /api/ci/runs/:id                          # unchanged (full logs)
```

The response-shape change touches the only consumer (the CI panel in
`web/app.js`) plus `scripts/test-web.mjs`; both are updated in the same
task.

**Console panel**

- "Recent runs" becomes a **history view**: workflow dropdown filter, status
  filter (all/failed/success), `Sebelumnya`/`Berikutnya` pagination with the
  total count shown.
- Each row shows a small `trigger` badge (`cli` / `web` / `schedule`) next
  to the status badge.
- Per-step log expansion is kept as-is; add an **"Unduh log"** button that
  downloads the run's logs as `.txt` via `Blob` (data already in the record;
  no new endpoint).
- Polling every 2 s while a run is `running` is unchanged; in idle the
  history loads on demand (page/filter changes).

**CLI**

- `sbx ci --list` gains two columns: **schedule** (cron expression or `-`)
  and **next** (next fire time, local) — computed with the same parser.

## 6. Config

```jsonc
// switchboard.config.jsonc
"ci": { "enabled": true, "keepRuns": 200 }   // keepRuns optional
```

- `ci.keepRuns`: integer ≥ 10; absent ⇒ 200; invalid ⇒ ignored with the
  default (config is best-effort, consistent with existing merge behavior).
- No `ci.schedule` flag — scheduling is implied by `ci.enabled` plus an
  `on.schedule` in a workflow.

## 7. Testing (TDD — RED first, chain grows 10 → 11)

`scripts/test-ci.mjs` (pure module, tmpdir fixtures, fake `now`):

- schedule parsing: string form, GitHub array form, missing `on`,
  non-schedule `on` ignored;
- cron parser: `*`, `*/n`, lists, ranges, month/dow bounds; rejected
  nicknames/6-field/`?`/`L`/`#` → validation error, workflow listed with
  error, never scheduled;
- evaluation: due/not-due against fake `now`, multi-entry workflow fires
  once per tick, catch-up collapses missed slots to one run, overlap skip
  advances `lastFired`, fresh-state default `lastFired = now` (no flood),
  corrupt state file recovers;
- store: `keepRuns` prune bound, `listRuns` limit/offset/total, workflow &
  status filters;
- run record carries `trigger: 'schedule'`.

`scripts/test-web.mjs` (host-level):

- `GET /api/ci/runs` returns the `{ runs, total, limit, offset }` envelope;
  query filters narrow results; `limit` capped;
- scheduler loop starts when `ci.enabled` and stops when disabled (tick
  evaluated with a fake `now` — no 30 s wall-clock wait);
- existing CI route/state assertions updated for the envelope.

`package.json`: the `test` chain gains a dedicated
`node scripts/test-schedule.mjs` (schedule parsing + evaluation + state),
growing from 10 to 11 chains. Store-query tests stay in `test-ci.mjs`
where the store suite already lives. The full chain must pass.

## 8. Files touched

New: `src/ci/schedule.ts`.
Modified: `src/ci/workflows.ts` (parse `on.schedule`), `src/ci/store.ts`
(`keepRuns`, `listRuns` query), `src/ci/index.ts` (exports), `src/ci/types.ts`
(`ScheduleDef`, `trigger: 'schedule'`), `src/config.ts` (`ci.keepRuns`),
`src/plugins/web.ts` (tick loop + query params), `src/cli.ts` (schedule
columns in `--list`), `web/app.js` + `web/app.css` (history view, badges,
download), `scripts/test-ci.mjs`, `scripts/test-web.mjs`, `README.md`,
`AGENTS.md` mirror, `switchboard.config.jsonc`.

Untouched by design: auth/PKCE, chat/session/tools, agent loop, LLM stack.

## 9. Future (explicitly out of v1)

Artifact files per run, separate `sbx schedule` daemon/CLI, OS scheduler
integration (the `on: schedule` source was chosen to stay compatible with a
future OS bridge), nickname/6-field cron, notification on run failure,
web cancel button, `on: push` git-hook triggers.
