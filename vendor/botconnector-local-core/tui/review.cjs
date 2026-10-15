'use strict';

// Read-only review payload preparation. This module owns only deterministic
// payload sizing; model dispatch remains in agent/loop.cjs's shared turn path.

const REVIEW_CONTEXT_FRACTION = 0.55;

function estimateTokens(text) {
  return Math.ceil(String(text == null ? '' : text).length / 4);
}

function buildReviewPrompt(files) {
  const evidence = (files || []).map((f) => `FILE ${f.path}\n${f.patch}`).join('\n\n');
  const prompt = `Review the actual Git changes below. Prioritize correctness/regressions, security, data-loss risk, missing tests, and material performance issues. Report only actionable findings with file paths and concise reasoning. Do not propose edits or claim that files were changed.\n\n${evidence}`;
  return { prompt, evidence, fileCount: (files || []).length, chars: prompt.length, estimatedTokens: estimateTokens(prompt) };
}

function guardPayload(payload, contextTokens) {
  const context = Math.max(512, Number(contextTokens) || 4096);
  const plannedContextAllowance = Math.max(512, Math.floor(context * REVIEW_CONTEXT_FRACTION));
  if (payload.estimatedTokens > plannedContextAllowance) {
    return {
      ok: false,
      plannedContextAllowance,
      reason: `NARROW_SCOPE_REQUIRED: review is ${payload.estimatedTokens} estimated tokens but the active model allows about ${plannedContextAllowance} for this request. Review a smaller staged or file scope.`,
    };
  }
  return { ok: true, plannedContextAllowance };
}

module.exports = { REVIEW_CONTEXT_FRACTION, estimateTokens, buildReviewPrompt, guardPayload };
