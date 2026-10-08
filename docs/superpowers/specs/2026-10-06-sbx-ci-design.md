# Design: `sbx ci` — local workflow runner (Fase 2)

Date: 2026-10-06
Status: approved by user (section-by-section), pre-implementation
Scope: new opt-in subsystem — standalone CI module + gated integration

## 1. Goal

Let Switchboard run GitHub-Actions-style workflows **locally**, on the user's
own machine, without pushing anywhere: `sbx ci` in the terminal or the ▶ button
in the web console. This is Fase 2 of the roadmap (deferred from the Fase 1
session).

Explicit non-goals for v1: no matrix, no services, no `uses:`/marketplace
actions, no `if:`/`continue-on-error`, no watch mode, no web cancel button, no
job parallelism, no artifacts/secrets.

## 2. Decisions taken with the user

| Question | Decision |
|---|---|
| Depth of v1 | MVP + `needs` DAG (no matrix/services/watch) |
| YAML parsing | the `yaml` npm package (adds 2nd runtime dep after `cordis`) |
| Approval gate for steps | none — `sbx ci` is explicit user intent; workflows run directly (like CI elsewhere) |
| Architecture | standalone module (no cordis plugin/ctx); integration is thin and config-gated |
| Opt-in model | feature is off unless `ci.enabled` is set; users who don't want it see no routes, no panel, no command |

## 3. Architecture

```
src/ci/                    pure module — no cordis, no ctx, no http
  workflows.ts             discovery + parse + validation  -> Workflow[]
  runner.ts                DAG execution -> RunRecord
  store.ts                 persistence under the data dir (+ prune)
  index.ts                 public surface: listWorkflows, run, listRuns, getRun

Integration points (all check ci.enabled first):
  config    switchboard.config.jsonc -> "ci": { "enabled": true }
  web.ts    /api/ci/* routes registered only when enabled (404 otherwise)
  cli.ts    `sbx ci` prints an enable-hint when disabled
  app.js    PIPELINES section rendered only when /api/state reports ci.enabled
```

The module takes the workspace root as an explicit argument
(`process.cwd()` for the CLI, the host workspace root for the web), so it stays
testable without a host. Our shipped config sets `ci.enabled: true`; an absent
key means off.

## 4. Workflow format (supported subset)

File location: `<workspace-root>/.switchboard/workflows/*.{yml,yaml}`.
Workflow id = file stem; display name = `name:` if present, else the stem.

```yaml
name: CI
on: [push, workflow_dispatch]   # parsed and IGNORED — runs are always manual
env: { NODE_ENV: ci }           # merged workflow -> job -> step
jobs:
  build:
    name: Build
    needs: [lint]               # DAG; unknown id or cycle = setup failure
    env: { FOO: '1' }
    steps:
      - name: Install
        run: npm ci
        working-directory: sub  # optional, relative to workspace root
        env: { X: 'y' }
        timeout-minutes: 5      # optional, default 10
```

Rejected with a clear setup error when present: `uses`, `matrix`, `if`,
`continue-on-error`, `services`, `secrets`. Unknown unrelated keys are
ignored. Malformed YAML, unknown `needs`, or a cycle → run status
`setup-failed`, nothing executes.

## 5. Execution semantics

- Jobs run **sequentially** in topological order; independent jobs keep file
  order (stable). Parallelism is deferred.
- Each step spawns the platform shell the same way `run_command` does
  (PowerShell on Windows, `sh -c` elsewhere), with `cwd = root + working-directory`.
- Step environment: runner vars (`CI=true`, `SWITCHBOARD_CI=1`,
  `SWITCHBOARD_CI_WORKFLOW`, `SWITCHBOARD_CI_RUN_ID`, `SWITCHBOARD_CI_JOB`,
  `SWITCHBOARD_CI_STEP`) under `workflow.env` → `job.env` → `step.env`.
- Failure: non-zero exit or timeout marks the step `failed`; remaining steps
  in that job become `skipped`; jobs that (transitively) `needs` a failed job
  become `skipped`; independent jobs continue. Run status = `success` only if
  no job failed or was skipped-due-to-failure.
- Timeout: default 10 minutes per step (`timeout-minutes` overrides); the
  shell process is killed and the step is marked failed with a log note.
- Cancellation: CLI SIGINT/Ctrl+C → run `cancelled`. The web v1 has no cancel
  button (the timeout is the safety net).
- Logs: stdout+stderr combined per step, capped at 256 KB (truncated with a
  marker). CLI streams live; the web UI reads from the store.
- Records are written after **every step**, so a crash still leaves a partial
  record. A record still `running` on disk when it has not been written for
  longer than the maximum step timeout is reported by readers as `failed`.

## 6. Run store

`~/.switchboard/ci/<sha1(workspaceRoot).slice(0,12)>/runs/<runId>.json`

```jsonc
{
  "id": "run-…", "workflow": "ci", "name": "CI", "root": "…",
  "status": "running|success|failed|setup-failed|cancelled",
  "trigger": "cli|web", "startedAt": "…", "endedAt": "…",
  "jobs": [{ "id": "build", "name": "Build", "status": "…",
             "steps": [{ "name": "Install", "run": "npm ci",
                         "status": "…", "exitCode": 0,
                         "startedAt": "…", "endedAt": "…", "log": "…" }]}]
}
```

Prune: keep the newest 50 runs per workspace. Concurrent runs are allowed
(no locking); each gets its own id.

## 7. CLI

```
sbx ci               # run every discovered workflow, one run each, sequentially
sbx ci <name>        # run a single workflow
sbx ci --list        # list workflows + last run status
```

Live per-step output, final summary (✓/✗ per job), exit code 1 if any run
failed. `<name>` matches the workflow id (file stem) or its display name;
unknown → error listing available ones. Each workflow is an independent run:
one `setup-failed` workflow does not stop the others in `sbx ci`.
Disabled → hint: add `"ci": { "enabled": true }` to
switchboard.config.jsonc.

## 8. Web API (404 when disabled)

```
GET  /api/ci/workflows       [{ id, name, file, jobs, lastRun }]
GET  /api/ci/runs?limit=20   [ { id, workflow, name, status, trigger, startedAt, endedAt, jobs } ]  # jobs = summaries, logs omitted
POST /api/ci/runs {workflow} { id }            # async start, UI polls
GET  /api/ci/runs/:id        full record incl. per-step logs
GET  /api/state              + ci: { enabled: boolean }
```

## 9. Web panel

New PIPELINES section in the sidebar of the Switchboard Control console,
following the existing visual identity (mono/amber tokens, `ci-` id prefix):

- workflow list + ▶ run button per workflow;
- recent runs with status badge (`success`, `failed`, `running`, `setup-failed`,
  `cancelled`) and duration; expanding a run reveals jobs → steps → log `<pre>`;
- the section is not rendered at all when `state.ci.enabled` is false;
- while any run is `running`, poll `/api/ci/runs` every 2 s; stop polling when
  nothing is running.

## 10. Testing (TDD — RED first, chain grows to 10)

- `scripts/test-ci.mjs` — pure module against tmpdir fixtures: valid/invalid
  parse (unknown `needs`, cycle, rejected `uses:`), topological order via an
  execution-order spy, failure propagation (independent job continues,
  dependents skipped), env merge precedence, timeout kill, log cap, store
  persist + prune, `setup-failed` never executes steps.
- `scripts/test-web.mjs` — CI routes: list, POST run of a real `echo`
  workflow, GET detail, `state.ci` flag; and a second host with CI disabled
  asserting 404.
- CLI behaviour is covered by the module tests + a `--list` smoke assertion
  where cheap; no full TTY test.
- `package.json`: chain gains `node scripts/test-ci.mjs`.

## 11. Files touched

New: `src/ci/{workflows,runner,store,index}.ts`, `scripts/test-ci.mjs`.
Modified: `src/config.ts` (`ci.enabled` type), `src/cli.ts` (case `ci`),
`src/index.ts` (pass `ci` into the web plugin), `src/plugins/web.ts` (gated
routes + state field), `web/app.js` + `web/app.css` (panel), `scripts/test-web.mjs`,
`package.json` (dep `yaml`, test chain), `switchboard.config.jsonc` (enabled block),
`README.md`, `AGENTS.md` mirror.

## 12. Future (explicitly out of v1)

Watch mode (`--watch`), web cancel button, `if:`/`continue-on-error`, job
parallelism, artifacts, an agent-facing `run_workflow` tool, GitHub remote
trigger parity (`on:` semantics).
