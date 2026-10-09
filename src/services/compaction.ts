import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { AgentMessage } from '../types.js'
import { estimateMessages } from '../context.js'

/** First line of the message that replaces summarized history. */
export const SUMMARY_MARKER = '[Summary of the earlier conversation]'
/** Originals kept on the session after compaction (searchable, never sent to the model). */
const ARCHIVE_CAP = 2_000
const TRANSCRIPT_CAP = 60_000
/** Below this many estimated tokens a compaction cannot save anything useful. */
const MIN_WORTH_TOKENS = 600

export interface CompactionConfig {
  /** Set false to fall back to dropping old messages when the prompt is too long. */
  enabled?: boolean
  /** Compact when the estimated prompt exceeds this share of `agent.maxPromptTokens`. Default 0.8. */
  triggerRatio?: number
  /** Most recent messages always kept verbatim. Default 6. */
  keepRecent?: number
  /** Output budget for the summary. Default 1500 tokens. */
  summaryTokens?: number
}

export type CompactionResult =
  | { ok: true; summarized: number; before: number; after: number; summary: string }
  | { ok: false; reason: string }

const SUMMARY_PROMPT = [
  'You compress the earlier part of a working conversation between a user and an AI agent so the agent can continue without it.',
  'Write a dense summary in plain markdown with these sections, omitting any that are empty:',
  '## Goal — what the user is trying to achieve, and any constraints or preferences they stated.',
  '## Decisions — what was decided and why.',
  '## Work done — files created or changed (exact paths), commands run and their outcome.',
  '## Problems — errors hit and how they were resolved, or are still open.',
  '## Open tasks — what remains, in order, and the next step.',
  '## Facts to keep — exact identifiers, names, numbers, URLs, and values that later steps will need.',
  'Keep exact strings (paths, ids, commands) verbatim. Do not invent anything that is not in the conversation. If an earlier summary is included, fold it in rather than repeating it. At most ~600 words.',
].join('\n')

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…[+${text.length - max} chars]` : text)

/** Renders messages as a compact transcript for the summarizer. */
export function renderTranscript(messages: AgentMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'tool') lines.push(`tool result: ${clip(m.content ?? '', 700)}`)
    else {
      if (m.content) lines.push(`${m.role}: ${clip(m.content, m.content.startsWith(SUMMARY_MARKER) ? 6_000 : 2_500)}`)
      for (const call of m.tool_calls ?? []) lines.push(`assistant called ${call.function.name}(${clip(call.function.arguments ?? '', 300)})`)
    }
  }
  const text = lines.join('\n')
  // A very long history: keep the head and the tail, the middle is the least useful.
  return text.length > TRANSCRIPT_CAP ? `${text.slice(0, TRANSCRIPT_CAP / 2)}\n…[middle omitted]…\n${text.slice(-TRANSCRIPT_CAP / 2)}` : text
}

/**
 * `ctx.compaction` — replaces old history with a model-written summary
 * (roadmap stage 3b). Unlike trimming, decisions and facts survive; the
 * originals move to `session.archived`.
 */
export class CompactionService extends Service {
  static inject: string[] = []

  readonly enabled: boolean
  readonly triggerRatio: number
  readonly keepRecent: number
  private readonly summaryTokens: number
  /** A failed attempt pauses automatic compaction for that session (it would just fail every step). */
  private readonly failedAt = new Map<string, number>()

  constructor(ctx: Context, config: CompactionConfig = {}) {
    super(ctx, 'compaction')
    this.enabled = config.enabled !== false
    this.triggerRatio = Math.min(0.95, Math.max(0.3, config.triggerRatio ?? 0.8))
    this.keepRecent = Math.max(2, Math.floor(config.keepRecent ?? 6))
    this.summaryTokens = Math.max(300, Math.floor(config.summaryTokens ?? 1_500))
  }

  /** True when the prompt is over the trigger line and there is enough old history to fold. */
  shouldCompact(sessionId: string, messages: AgentMessage[], maxPromptTokens: number): boolean {
    if (!this.enabled) return false
    if (Date.now() - (this.failedAt.get(sessionId) ?? 0) < 120_000) return false
    if (estimateMessages(messages) <= maxPromptTokens * this.triggerRatio) return false
    return this.split(messages) !== null
  }

  /** Index (in the non-system list) where the verbatim tail starts, or null when nothing can be folded. */
  private split(messages: AgentMessage[]): { systems: AgentMessage[]; rest: AgentMessage[]; cut: number } | null {
    const systems = messages.filter((m) => m.role === 'system')
    const rest = messages.filter((m) => m.role !== 'system')
    let cut = rest.length - this.keepRecent
    // The tail must not start on a tool result: keep the assistant call that owns it.
    while (cut > 0 && rest[cut]?.role === 'tool') cut -= 1
    return cut >= 2 ? { systems, rest, cut } : null
  }

  async compact(sessionId: string, options: { focus?: string; model?: string; provider?: string; signal?: AbortSignal } = {}): Promise<CompactionResult> {
    const sessions = this.ctx.get('sessions', false)
    const llm = this.ctx.get('llm', false)
    if (!sessions || !llm) return { ok: false, reason: 'sessions or llm are not available' }
    const session = sessions.get(sessionId)
    if (!session) return { ok: false, reason: `no session "${sessionId}"` }
    const parts = this.split(session.messages)
    if (!parts) return { ok: false, reason: 'the conversation is too short to compact' }
    const { systems, rest, cut } = parts
    const old = rest.slice(0, cut)
    const before = estimateMessages(session.messages)
    // A short history is not worth a model call: the summary would be as long as what it replaces.
    if (before < MIN_WORTH_TOKENS) return { ok: false, reason: `the conversation is only ~${before} tokens; compacting starts to pay off around ${MIN_WORTH_TOKENS}` }

    let summary: string
    try {
      const focus = options.focus?.trim() ? `\n\nThe user asks you to pay particular attention to: ${options.focus.trim().slice(0, 500)}` : ''
      const result = await llm.generate({
        model: llm.resolveModel(options.model ?? session.model),
        provider: options.provider ?? session.provider,
        messages: [
          { role: 'system', content: SUMMARY_PROMPT + focus },
          { role: 'user', content: `Conversation to compress:\n\n${renderTranscript(old)}` },
        ],
        temperature: 0,
        maxTokens: this.summaryTokens,
        signal: options.signal,
      })
      summary = result.content.trim()
    } catch (error) {
      this.failedAt.set(sessionId, Date.now())
      return { ok: false, reason: `the summary request failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (!summary) {
      this.failedAt.set(sessionId, Date.now())
      return { ok: false, reason: 'the model returned an empty summary' }
    }
    this.failedAt.delete(sessionId)

    const summaryMessage: AgentMessage = { role: 'user', content: `${SUMMARY_MARKER}\n${summary}` }
    const next = [...systems, summaryMessage, ...rest.slice(cut)]
    const after = estimateMessages(next)
    // Never trade a short history for a longer summary: leave the conversation as it was.
    if (after >= before * 0.9) return { ok: false, reason: `the summary (~${after} tokens) would not be shorter than the history (~${before}); left unchanged` }
    sessions.replaceMessages(sessionId, next, old)
    return { ok: true, summarized: old.length, before, after, summary }
  }
}

declare module 'cordis' {
  interface Context {
    compaction: CompactionService
  }
}
