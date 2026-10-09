# SDD ledger — plan: docs/superpowers/plans/2026-10-09-recovery-mcp-memory.md

Spec approved by the user; user explicitly requested continuation. Execute inline without another approval cycle for the already authorized implementation.

Pre-flight: Task 1 provides checkpoint/readStored used by Task 3; the types are shared and compatible. Task 2's callResult is additive and call remains string-returning, preserving subagent/agent integrations.

Ruling: Work on a feature branch in the dedicated cloned checkout rather than creating another worktree — this checkout contains only this task's work; no user development branch is modified.

Task 1: complete — typecheck/build, full existing npm test suite, test-recovery and test-worker-workspace passed. Red: queue recovery timed out; worker-root regression returned wrong workspace. Green: hard-crash queue/results/receipts/owner/write-failure cases and workspace isolation passed.
Ruling: Correct the existing kill-tree test to treat Linux zombies as dead — baseline failed while /proc showed Z processes, which cannot execute or hold pipes. This changes the test only, retaining the real live-process assertion.
Verification limit: real bubblewrap passed; Docker integration skipped because node:24-alpine was not installed.

Task 2: complete — typecheck/build and npm test passed, including extended MCP over stdio and HTTP, capability absence/collision, pagination, structured-only and error results, binary omission, prompt validation, cancellation and policy checks. Red: structured-only rendering was '(empty result)'.
Ruling: Resource/prompt lists are fetched fresh instead of cached — list_changed notifications cannot leave cached metadata stale; no extra notification-backed cache is necessary.
