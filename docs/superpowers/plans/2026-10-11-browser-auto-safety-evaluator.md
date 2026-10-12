# Browser Auto Safety Evaluator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Switchboard's static Auto action whitelist with fail-closed, per-action safety evaluation and implement Claude in Chrome's documented Manual/Auto/Skip action modes.

**Architecture:** Add a browser safety service that uses the session's selected provider/model through `ctx.llm.generate()` and returns strict `continue`, `require_approval`, or `block` decisions. Make tool preflight asynchronous and structured so the agent's waiting state, approval UI, hard blocks, and tool execution all use one decision; screen browser-read output before it is appended to the agent conversation. Keep Chrome `permissions` as the sole site-access authority.

**Tech Stack:** TypeScript, Cordis services/plugins, existing LLM/provider/session/approval services, Chrome MV3 extension, Node VM tests, real Chrome + configured provider for acceptance.

**Spec:** `docs/superpowers/specs/2026-10-11-switchboard-claude-chrome-parity-design.md`

**Scope:** This plan implements the outstanding Auto/Skip safety-policy gap. The native site-permission and agent-tab work already in the branch remains governed by `docs/browser-parity-gate-20261011.md`; it still requires real Chrome verification and is not declared complete by this evaluator plan.

## Global Constraints

- Chrome host permissions are the only site-access decision; action mode never grants site access.
- Manual requests approval for each browser action; a saved per-session tool grant cannot silently turn Manual into Auto. Auto screens page content and each action; Skip disables automatic screening but retains Chrome site permission, mode-independent explicit-approval rules, and prohibited-action rules.
- Evaluator errors, uncertainty, malformed output, timeout, cancellation, and provider failure never silently allow an action.
- Match Claude's documented action classes: permission changes, authorization grants, and potentially sensitive input require explicit approval regardless of mode; Auto screens high-risk actions such as downloads; prohibited actions remain blocked regardless of mode.
- Do not persist/log page content or typed values; use bounded untrusted context and the configured provider/model for the active session.
- Real visible-Chrome and real-provider evidence is required; local commits are allowed after verification, but do not push, release, merge, or change PR #22 status.

## Review Focus

- Evaluator result and execution target can become stale if tab, origin, page, arguments, or mode changes; bind a prepared decision to the exact call and recheck before mutation.
- The model may return invalid JSON, refuse, time out, be cancelled, or return provider errors; each case must fail closed and keep UI state truthful.
- Page content can contain prompt injection or deceptive form labels; test that it stays explicitly untrusted and cannot change user intent or safety policy.
- Proposed typed text is sensitive; send only exact action context ephemerally to the configured provider and assert it is absent from logs/traces.
- Approval state can diverge from actual tool execution due the current separate `agent.ts` precheck; test one decision drives both UI state and the actual gate.

---

### Task 1: Structured browser safety evaluator

**Files:**
- Create: `src/services/browser-safety.ts`
- Modify: `src/index.ts` to register/export `BrowserSafetyService` after `LLMService` and before browser tools are loaded
- Test: `test/test-browser-safety.mjs`

**Interfaces:**
- Produces `BrowserSafetyService.evaluateAction(input, signal): Promise<BrowserSafetyDecision>` where the decision is `{ verdict: 'continue' | 'require_approval' | 'block'; reason: string }`.
- Produces `BrowserSafetyService.screenPage(input, signal): Promise<{ content: string; verdict: 'clean' | 'quarantined' | 'require_approval'; reason?: string }>`.
- Both methods call `ctx.llm.generate({ model, provider, messages, maxTokens, signal, sessionId })`; validate a strict JSON schema locally. Resolve model/provider from the active session before config defaults.

- [x] **Step 1: Write failing evaluator contract tests**

Test `continue`, `require_approval`, and `block`; malformed schema, refusal, provider error/401, timeout, abort, missing origin/context, and page-injection quarantine. Assert no inputs/page text/typed values are logged.

- [x] **Step 2: Run `node test/test-browser-safety.mjs` and confirm expected failures**

- [x] **Step 3: Implement `BrowserSafetyService`**

Use bounded inputs and distinct trusted-intent/untrusted-page fields. Fail closed to `require_approval` for evaluator uncertainty/error. Keep hard-block classification outside model override. Never persist evaluator payloads or raw response text.

- [x] **Step 4: Run `node test/test-browser-safety.mjs` and confirm all contract cases pass**

### Task 2: Async prepared tool policy and truthful approval state

**Files:**
- Modify: `src/services/tools.ts`
- Modify: `src/plugins/agent.ts`
- Modify: `src/services/approval.ts` only if structured block/approval reason needs a display field
- Test: `test/test-browser-action-fail-closed.mjs`
- Test: `test/test-browser-companion.mjs`

**Interfaces:**
- Change `ToolSpec.requiresApproval` into an async-capable structured policy (or add a distinct async `preflight`) returning `continue | require_approval | block` with a short reason.
- Add `ToolsService.prepare(name, args, ctx): Promise<PreparedToolCall>` and `ToolsService.callPrepared(prepared): Promise<ToolResult>`; `PreparedToolCall` contains `{ name, args, context, policy: { verdict, reason }, fingerprint }`. Bind it to tool name, serialized args, session, and policy result. `callResult()` remains compatible by calling prepare then callPrepared.
- Add `userIntent`, active `model`, and `provider` to internal `ToolContext`, populated from the current agent turn/session, never from browser page content.

- [x] **Step 1: Add failing tests for preflight/execution single-decision behavior**

Assert that Manual asks for a fresh decision even when the session has a tool grant, Auto `continue` runs once without approval, `require_approval` sets `waiting_approval` and requests exactly one decision, `block` never requests approval and never executes, Skip disables Auto-only screening while mode-independent explicit-approval actions remain gated and prohibited actions remain blocked, and direct `callResult()` cannot bypass preflight.

- [x] **Step 2: Run focused tests and confirm the current agent/tool double-check or missing-state behavior fails**

- [x] **Step 3: Implement prepared calls and update `agent.ts`**

The agent must prepare before emitting `tool_running`, set `waiting_approval` only for the same prepared decision that reaches `ApprovalService.request()`, then execute that exact prepared call. Invalidate/re-evaluate if inputs or target are changed.

- [x] **Step 4: Run `node test/test-browser-action-fail-closed.mjs` and `node test/test-browser-companion.mjs`**

### Task 3: Browser action context and content screening

**Files:**
- Modify: `src/plugins/browser-companion.ts`
- Modify: `src/services/tools.ts` if the prepared-call hook needs a post-execution sanitizer
- Test: `test/test-browser-companion.mjs`
- Test: `test/test-browser-security.mjs`

**Interfaces:**
- Browser tool preflight calls `BrowserSafetyService.evaluateAction()` with current user intent, bound tab ID, current target origin, bounded page snapshot, exact proposed tool/arguments, and `AbortSignal`.
- Browser read results pass through `BrowserSafetyService.screenPage()` before becoming tool messages visible to the primary agent. Quarantined instructions remain labeled untrusted; uncertain classification pauses before the agent uses the content.

- [x] **Step 1: Add failing tests for injected page text and stale browser context**

Cover malicious page instructions, deceptive labels, missing Chrome permission, changed tab/origin, and cancellation. Assert no content read before native Chrome site grant and no mutation after a stale decision.

- [x] **Step 2: Run `node test/test-browser-companion.mjs` and `node test/test-browser-security.mjs` to verify failure**

- [x] **Step 3: Implement context collection and pre-execution revalidation**

Collect only bounded visible/semantic page content after Chrome host permission succeeds; exclude cookies, storage, hidden values, unrelated fields, and full private URLs. Revalidate the agent-bound tab/origin immediately before mutation.

- [x] **Step 4: Run focused contracts and confirm page output is screened before conversation append**

### Task 4: Manual / Auto / Skip extension experience

**Files:**
- Modify: `browser-extension/panel.html`
- Modify: `browser-extension/panel.js`
- Modify: `src/plugins/browser-companion.ts`
- Test: `test/test-browser-panel-chat-stream.mjs`
- Test: `test/test-browser-companion.mjs`

**Interfaces:**
- Persist and synchronize exactly three action modes: `manual`, `auto`, `skip` (migrate old `ask_every_time` to Manual and `auto_safe` to Auto).
- Auto is the side-panel default for a new install. Skip has clear inline copy that automatic checks are skipped while Chrome site permission, mode-independent explicit-approval actions, and prohibited-action restrictions still apply.

- [x] **Step 1: Add failing migration and UI-state assertions**

Assert new install defaults to Auto, old mode values migrate without becoming site grants, selecting Skip persists/synchronizes with the documented explanation, mode-independent explicit-approval actions remain gated, Auto-only screenings do not apply in Skip, prohibited actions remain blocked, and changing action mode never mutates Chrome host permissions.

- [x] **Step 2: Run focused panel/companion tests and confirm failures**

- [x] **Step 3: Implement mode UI and mode-to-policy synchronization**

Remove the static Auto tool-name whitelist. Keep Manual approval and Auto evaluator policy in one browser-action gate; keep Skip only as the documented screening bypass.

- [x] **Step 4: Run `node test/test-browser-panel-chat-stream.mjs` and `node test/test-browser-companion.mjs`**

### Task 5: Full regression and visible-Chrome/provider comparison

**Files:**
- Modify: `docs/browser-parity-gate-20261011.md`
- Test: existing `test/test-browser-*.mjs` contracts plus real Chrome/provider flow

- [x] **Step 1: Run browser VM suite, typecheck, build, and packaging checks**

Run the focused tests from Tasks 1–4, `npm run typecheck`, `npm run build`, and the extension package validation. Record exact results; VM tests are not E2E proof.

- [ ] **Step 2: Run real provider + visible Chrome scenarios**

With extension reloaded and bridge connected, compare the same benign multi-step form task, prompt-injection page, sensitive-field attempt, evaluator timeout/401, approval accept/reject, Skip, cancellation, and user tab switching against Claude in Chrome. Verify actual page state and ensure rejected/blocked actions do not mutate it.

- [ ] **Step 3: Update the feature matrix with evidence and disposition**

Keep each untested UI/proprietary behavior `BELUM TERVERIFIKASI`; mark `DIFF` until directly compared and corrected. Keep release gate NO-GO while any mandatory evidence is absent. Local commits may contain verified changes; do not push or release.
