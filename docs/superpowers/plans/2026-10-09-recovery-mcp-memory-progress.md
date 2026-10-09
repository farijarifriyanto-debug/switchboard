# SDD ledger — plan: docs/superpowers/plans/2026-10-09-recovery-mcp-memory.md

Spec approved by the user; user explicitly requested continuation. Execute inline without another approval cycle for the already authorized implementation.

Pre-flight: Task 1 provides checkpoint/readStored used by Task 3; the types are shared and compatible. Task 2's callResult is additive and call remains string-returning, preserving subagent/agent integrations.

Ruling: Work on a feature branch in the dedicated cloned checkout rather than creating another worktree — this checkout contains only this task's work; no user development branch is modified.

Task 1: complete — typecheck/build, full existing npm test suite, test-recovery and test-worker-workspace passed. Red: queue recovery timed out; worker-root regression returned wrong workspace. Green: hard-crash queue/results/receipts/owner/write-failure cases and workspace isolation passed.
Ruling: Correct the existing kill-tree test to treat Linux zombies as dead — baseline failed while /proc showed Z processes, which cannot execute or hold pipes. This changes the test only, retaining the real live-process assertion.
Verification limit: real bubblewrap passed; Docker integration skipped because node:24-alpine was not installed.

Task 2: complete — typecheck/build and npm test passed, including extended MCP over stdio and HTTP, capability absence/collision, pagination, structured-only and error results, binary omission, prompt validation, cancellation and policy checks. Red: structured-only rendering was '(empty result)'.
Ruling: Resource/prompt lists are fetched fresh instead of cached — list_changed notifications cannot leave cached metadata stale; no extra notification-backed cache is necessary.

Task 3: complete — typecheck/build and full npm test passed, including notebook scope/edit/delete/disabled behavior, unloaded disk history and archives, Unicode normalization, malformed/oversized/symlink files, live-over-disk precedence and preset restrictions. Red: unloaded ledger session was not found. Search remains local and adds no dependencies/provider calls.

Integration: snapshot the effective worker model/provider/step limit and route worker approvals through the authorized parent chat. Regression tests first failed for the missing model and missing worker prompt, then passed.

Independent final review: six Important findings, no verified Critical findings or retained Minor findings. CodeRabbit CLI unavailable, so a fresh independent reviewer performed manual review and reproduced each finding. One material fix pass addressed all six:
1. Publish the full queued background batch with one parent checkpoint; rejected batches cannot leave a queued prefix.
2. Put pre-wake checkpoint inside cleanup protection; failures release the token and preserve a retryable wake.
3. Atomically publish complete lock metadata and reclaim dead guards under owner-aware guards; never remove a live or unknown owner.
4. Hydrate all workers of active recovery parents, including foreground workers, so worker/token/cost budgets survive the hydration cap.
5. Apply notebook search exclusions to system prompt projection for restricted presets.
6. Await Telegram/Discord chat-map readiness before recovering jobs and emitting worker approval requests.
All six regressions failed on the previous behavior and passed after fixes. No review findings deferred.

Final verification: typecheck/build and the full suite passed on Node 24.19.0. The new recovery/workspace/MCP/memory/approval/review/channel-readiness suites and typecheck also passed on Node 20.20.2 and Node 22.23.3. Node 20 skips Discord readiness because the channel requires Node 22's WebSocket. Real bubblewrap passed; Docker isolation remained skipped because node:24-alpine is unavailable. Real remote providers and external channels were not exercised; local stubs cover both MCP transports and both channels on Node 22/24.

Material rulings are recorded above: dedicated checkout feature branch, Linux zombie test correction, fresh MCP metadata reads. No new dependencies or external embedding provider. Implementation is committed locally for review; integration into master or GitHub is a separate choice.
