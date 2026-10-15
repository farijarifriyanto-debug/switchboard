// Context guard — prevents the "4096 runtime eats 12K prompt" failure class.
// Startup: estimate required system/tool context, inspect runtime n_ctx,
// warn + offer restart with suitable context. NEVER silently restarts.
'use strict';

const RESERVED_SYSTEM_TOKENS = 2500;   // system prompt + tool schemas (estimate)
const SAFETY_MARGIN = 512;

function estimateTokens(text) { return Math.ceil(String(text || '').length / 4); }

function guard({ nCtx, plannedUserTokens = 0, toolSchemaTokens = 1500 }) {
  const required = RESERVED_SYSTEM_TOKENS + toolSchemaTokens + plannedUserTokens + SAFETY_MARGIN;
  const usable = nCtx - RESERVED_SYSTEM_TOKENS - SAFETY_MARGIN;
  if (required <= nCtx) return { ok: true, required, nCtx, usable };
  return {
    ok: false,
    required, nCtx, usable,
    warning:
      `Context risk: runtime n_ctx=${nCtx} < estimated need ~${required} tokens. ` +
      `System/tool reserve ~${RESERVED_SYSTEM_TOKENS + toolSchemaTokens}. ` +
      `Refusing to silently continue or restart — choose: (r) restart runtime with larger n_ctx, (c) continue read-only, (a) abort.`,
    offerRestart: true,
  };
}

function meter(usedTokens, nCtx) {
  const pct = Math.round((usedTokens / nCtx) * 100);
  const k = (n) => (n / 1000).toFixed(1) + 'K';
  return `Context ${k(usedTokens)} / ${k(nCtx)} · ${pct}%`;
}

module.exports = { guard, meter, estimateTokens, RESERVED_SYSTEM_TOKENS };
