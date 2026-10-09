# Recovery, MCP, and Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover background jobs without replaying started work, expose useful MCP data, and search persisted memory.

**Architecture:** Persist background metadata with the parent transcript and use strict serialized session checkpoints. Keep string tool calls compatible while adding an optional structured result path. Read unloaded sessions from disk without adding them to the live registry.

**Tech Stack:** TypeScript, Node 20/22, Cordis, MCP SDK, existing Node assertion scripts.

**Spec:** ../specs/2026-10-09-recovery-mcp-memory-design.md

## Global Constraints

- Execute recovery, MCP, and memory in that order; preserve old sessions and plugin string interfaces.
- Never automatically replay a running worker or interrupted parent wake.
- Recovery starts only in long-running hosts after approval surfaces are ready.
- No embeddings, vector database, attachment storage, OAuth, or config HMR in this change.
- Test with local stubs; do not publish, merge, or call a live model provider.

## Review Focus

- A write failure must prevent background dispatch and retain dirty state for retry.
- A stale/live owner must not allow a second process to execute the same queue.
- Completion delivery and restart must not duplicate parent messages.
- Unsupported MCP capabilities and name collisions must leave the host usable.
- Deleted/oversized/malformed session files and restricted presets must not leak memory.

### Task 1: Durable checkpoints and background recovery

**Files:** `src/services/session.ts`, new `src/services/background-jobs.ts`, new `src/services/recovery-lock.ts`, `src/plugins/subagent.ts`, `src/index.ts`, `scripts/test-recovery.mjs`, test process fixture, README and CHANGELOG.

**Interfaces:** SessionService adds `checkpoint(id): Promise<void>` and detached `readStored(id): Promise<SessionData | undefined>`. Background metadata is optional and versioned on SessionData. SubagentService adds `recover(): Promise<void>`; host boot invokes it only when web or channels are enabled and ready. Preserve `jobs/job/state/flush`.

- [ ] Write process-restart assertions for queued/running/undelivered/delivered jobs, busy parent, cancelled jobs, hydration limits, read-only boot, checkpoint errors and competing hosts.
- [ ] Build and run `node scripts/test-recovery.mjs`; observe recovery assertions fail before implementation.
- [ ] Add serialized strict checkpoints, validated optional job metadata, an exclusive process/host ownership lock, and recovery transitions. Use a single parent checkpoint for transcript plus delivery receipt. Preserve active approvals and enforce existing budgets.
- [ ] Run typecheck/build, recovery, subagent, budget and session-related tests; then the full suite.
- [ ] Update docs and commit the independently working recovery change.

### Task 2: Structured MCP results and resource/prompt bridge

**Files:** `src/services/tools.ts`, `src/mcp/render.ts`, `src/plugins/mcp.ts`, MCP fixtures, new `scripts/test-mcp-extended.mjs`, README and CHANGELOG.

**Interfaces:** Add `ToolResult { content: string; structuredContent?: unknown; isError?: boolean }` and `ToolsService.callResult(name,args,ctx): Promise<ToolResult>`; `call()` still returns rendered text. Expose capability-dependent namespaced resource/prompt operations through the same registry, approvals and presets.

- [ ] Write assertions for structured-only results, text+structured, isError, resources/templates/prompts, pagination, missing capabilities, cancellation, reconnect and name collisions.
- [ ] Run the new MCP script; confirm the expected missing behavior.
- [ ] Implement bounded structured rendering, optional rich results and capability-dependent bridge operations; do not inject fetched prompt templates as system instructions.
- [ ] Run MCP, extended MCP, approvals, presets, adapter tests and full suite.
- [ ] Document supported bridges and remaining binary/OAuth/HMR limits; commit.

### Task 3: Search notebook and unloaded sessions

**Files:** new `src/services/search.ts`, `src/services/recall.ts`, `src/services/memory.ts`, `src/services/session.ts`, recall/memory test scripts, README and CHANGELOG.

**Interfaces:** Add `search_memory(query,scope,limit)` read-only tool when memory is enabled. `search_sessions` and `read_session` use live sessions first and detached persisted sessions second. Default all-term matching remains compatible; optional any-term mode is explicit.

- [ ] Write tests for notebook scopes/edits/disabled state, unloaded sessions and archives, live/disk deduplication, Unicode, rankings and limits, malformed/oversized files, and preset restrictions.
- [ ] Run tests and confirm failures for missing disk/notebook search.
- [ ] Implement deterministic normalized token matching, bounded detached reads, source-aware snippets and live precedence. Do not hydrate search results into the active registry.
- [ ] Run recall, memory, presets, typecheck/build and full suite.
- [ ] Update docs/scripts and commit; request a fresh whole-branch review and fix material findings with regression tests.
