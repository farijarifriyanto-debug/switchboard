# Switchboard Browser Companion — Cloud AI E2E acceptance

Date: 2026-10-29. Branch: `feat/switchboard-tasks-api-key-20261029`.
Published Chrome extension remains 0.4.6. All browser work below used a disposable
Chrome for Testing profile and HTTP pages on loopback, **not production websites**.

## Provider and tool-call evidence

- Existing user-owned environment credentials were read transiently by the
  test process; never printed, copied to Chrome storage, or committed.
- Groq `openai/gpt-oss-20b`: first 120-token function-call smoke PASS (HTTP 200,
  `ping` tool call, 529 ms); multi-step E2E blocked by genuine Groq 429 TPM
  limit (8,000 TPM, third agent request exceeded remaining quota). Not a
  Switchboard browser failure.
- OpenRouter `inclusionai/ling-3.1-flash`: function-call smoke PASS (HTTP 200,
  `ping`); browser agent returned Completed without a verifiable final count.
  **Not accepted** as real Chrome E2E.
- OpenRouter `qwen/qwen3.8-flash`: function-call smoke PASS (HTTP 200, `ping`).
  Full Browser Companion cloud E2E **PASS** twice: first run ~59.5 seconds,
  five tool steps and three scoped approvals; second run via the
  `npm run test:tasks:cloud` wrapper ~67.8 seconds, six tool steps and four
  scoped approvals. Both independently observed the target `Clicks: 1` /
  `data-n=1`, with an AI final answer explicitly stating count 1.
- The test only approved a snapshot reference `@e1` after independent
  read-only CDP evaluation verified that it belonged to the exact
  `#counter` button on the bounded QA tab. No general or persistent Chrome
  site permission was widened for this selector.
- After the AI response, switching to the second QA tab preserved the agent's
  bound tab. Disconnect/reconnect of the paired WebSocket did **not** duplicate
  the click. The final DOM counter was still 1.

## UX follow-up: task receipt

The Browser Companion now adds an explicit outcome footer for tool-reported
success, failures, cancellation, step limit, and answers produced without a
recorded browser tool. This footer is intentionally **not** an independent
assertion that the AI's statements are true; it distinguishes recorded tool
status from model prose. Unit and real Chrome UI fixtures cover these states.
It is additive to the existing chat-first panel; no extra provider key field
or model manager was introduced.

## Security and costs

- The browser extension never receives the provider's API key. The isolated
  test backend reads it directly from the existing process environment.
- No actual card, login, customer site, production billing operation,
  download, or browser account profile was touched.
- Cloud provider calls can consume the user's existing provider allowance.
  Actual invoice amounts were not retrieved; do not claim that the E2E was
  free. The harness limits agent steps to 7 and per-response max tokens to 768
  but cannot impose an absolute external account spending cap.
- The cloud test is explicit opt-in: `SBX_TEST_CLOUD=1`. The wrapper requires
  `SBX_CLOUD_BASE_URL` (HTTPS), `SBX_CLOUD_MODEL`, and
  `SBX_CLOUD_API_KEY`. It reuses the existing real-Chrome agent test,
  rather than duplicating a second E2E implementation.

## Acceptance status and remaining release gates

Cloud model calling, real browser execution and DOM readback, scoped native
approvals, session binding, reconnect, and no-duplicate-action: **PASS**
on the bounded Chrome fixture.

Original Claude-in-Chrome live side-by-side comparison, current owner's
installed browser/profile workflow, provider BYOK UI with a non-production
test credential, Chrome Store privacy/permission disclosures, and explicit
merge/publish authorization: **not yet complete**. Keep unpublished.

Verified evidence: captured terminal output from the QA run; no secrets
were included. This document is not a provider uptime guarantee.
