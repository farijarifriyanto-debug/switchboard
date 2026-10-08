/**
 * Prompt/context accounting.
 *
 * The harness sends the whole session on every turn, so long conversations must
 * be trimmed before they overflow the model's context window. Estimates here
 * are deliberately cheap (characters / 4) — they are a guard rail, not a
 * tokenizer.
 */
import type { AgentMessage } from './types.js'

export interface TrimOptions {
  /** Soft ceiling for total prompt tokens. */
  maxPromptTokens: number
  /** Always keep the last N messages, whatever the budget says. */
  keepRecent?: number
}

export interface TrimResult {
  messages: AgentMessage[]
  /** How many messages were removed. */
  dropped: number
  estimatedTokens: number
}

/** Rough token estimate: ~4 characters per token, plus per-message overhead. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Rough token estimate for a whole conversation (tool calls included). */
export function estimateMessages(messages: AgentMessage[]): number {
  let total = 0
  for (const m of messages) {
    total += 4 + estimateTokens(m.content ?? '')
    for (const call of m.tool_calls ?? []) {
      total += 8 + estimateTokens(call.function.name) + estimateTokens(call.function.arguments)
    }
  }
  return total
}

/**
 * Drops the oldest messages until the conversation fits the budget.
 *
 * System messages are never dropped (they carry the persona and pinned
 * instructions), nor is anything inside `keepRecent`. Trimming never leaves a
 * `tool` result orphaned from the assistant call it answers.
 */
export function trimMessages(messages: AgentMessage[], options: TrimOptions): TrimResult {
  const budget = Math.max(0, options.maxPromptTokens)
  const keepRecent = Math.max(0, options.keepRecent ?? 2)

  if (estimateMessages(messages) <= budget) {
    return { messages, dropped: 0, estimatedTokens: estimateMessages(messages) }
  }

  const systems = messages.filter((m) => m.role === 'system')
  const rest = messages.filter((m) => m.role !== 'system')

  // Walk backwards, keeping as much recent history as fits.
  let keepFrom = rest.length
  let used = estimateMessages(systems)
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const size = estimateMessages([rest[i]])
    const forced = rest.length - i <= keepRecent
    if (!forced && used + size > budget) break
    used += size
    keepFrom = i
  }

  // Never start the kept slice on a `tool` message: its assistant call would be
  // gone and most providers reject an orphaned tool result.
  while (keepFrom < rest.length && rest[keepFrom].role === 'tool') keepFrom += 1

  const kept = [...systems, ...rest.slice(keepFrom)]
  return {
    messages: kept,
    dropped: messages.length - kept.length,
    estimatedTokens: estimateMessages(kept),
  }
}
