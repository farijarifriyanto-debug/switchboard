import type { Context } from 'cordis'
import type { AgentMessage } from '../types.js'
import type { ToolSpec, ToolContext } from './tools.js'

const SNIPPET = 160
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

interface Hit {
  sessionId: string
  title: string
  role: string
  where: 'live' | 'archived'
  index: number
  snippet: string
  updatedAt: number
  score: number
}

/** All words must appear (case-insensitive); returns a score and the text window around the first hit. */
export function matchText(text: string, words: string[]): { score: number; snippet: string } | null {
  const lower = text.toLowerCase()
  let first = -1
  let score = 0
  for (const word of words) {
    const at = lower.indexOf(word)
    if (at === -1) return null
    if (first === -1 || at < first) first = at
    score += 1 + Math.min(3, lower.split(word).length - 2)
  }
  const start = Math.max(0, first - SNIPPET / 2)
  const window = text.slice(start, start + SNIPPET + 40).replace(/\s+/g, ' ').trim()
  return { score, snippet: `${start > 0 ? '…' : ''}${window}${start + SNIPPET + 40 < text.length ? '…' : ''}` }
}

const textOf = (m: AgentMessage): string => {
  const calls = (m.tool_calls ?? []).map((c) => `${c.function.name}(${c.function.arguments ?? ''})`).join(' ')
  return [m.content ?? '', calls].filter(Boolean).join(' ')
}

/**
 * `recall` — search and read other conversations (roadmap stage 3c).
 *
 * Transcripts on disk are not memory until the agent can find them. Search
 * covers live messages and the originals archived by compaction; the current
 * session's live messages are skipped (the model already has them).
 *
 * Read-only, but it exposes past conversations to the model: keep it out of
 * presets that should not see them (the built-in reviewer/researcher omit it).
 */
export const toolsRecall = {
  name: 'recall-tools',
  inject: ['tools', 'sessions'],

  apply(ctx: Context) {
    const search: ToolSpec = {
      name: 'search_sessions',
      description:
        'Search earlier conversations (including parts summarized away by compaction) for words. All words must match. Returns session ids and snippets; use read_session to read more.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to look for.' },
          limit: { type: 'number', description: 'Max results (default 8, max 20).' },
        },
        required: ['query'],
      },
      execute(args: { query: string; limit?: number }, tctx: ToolContext) {
        const words = String(args.query ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 8)
        if (!words.length) return 'Error: give at least one word of 2+ characters to search for.'
        const limit = Math.max(1, Math.min(Number(args.limit) || 8, 20))
        const hits: Hit[] = []
        for (const session of ctx.sessions.list()) {
          const scan = (messages: AgentMessage[], where: Hit['where']): void => {
            messages.forEach((m, index) => {
              if (m.role === 'system') return
              if (where === 'live' && session.id === tctx.sessionId) return
              const found = matchText(textOf(m), words)
              if (found) hits.push({ sessionId: session.id, title: session.title, role: m.role, where, index, snippet: found.snippet, updatedAt: session.updatedAt, score: found.score })
            })
          }
          scan(session.messages, 'live')
          scan(session.archived ?? [], 'archived')
        }
        if (!hits.length) return `No earlier conversation mentions: ${words.join(' ')}`
        hits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt)
        const lines = hits.slice(0, limit).map(
          (h, i) => `${i + 1}. ${h.sessionId} "${clip(h.title, 50)}" · ${h.where === 'archived' ? 'archived ' : ''}${h.role} #${h.index} · ${new Date(h.updatedAt).toISOString().slice(0, 10)}\n   ${h.snippet}`,
        )
        return `${hits.length} match(es), showing ${lines.length}:\n${lines.join('\n')}`
      },
    }

    const read: ToolSpec = {
      name: 'read_session',
      description: 'Read messages of another conversation by session id (from search_sessions). Pages of up to 30 messages.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Session id or unique prefix.' },
          offset: { type: 'number', description: 'First message index (default 0).' },
          limit: { type: 'number', description: 'How many messages (default 20, max 30).' },
          archived: { type: 'boolean', description: 'Read the originals that compaction replaced instead of the live transcript.' },
        },
        required: ['id'],
      },
      execute(args: { id: string; offset?: number; limit?: number; archived?: boolean }) {
        const session = ctx.sessions.find(String(args.id ?? '').trim())
        if (!session) return `Error: no session "${args.id}"`
        const all = (args.archived ? session.archived ?? [] : session.messages).filter((m) => m.role !== 'system')
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
        const limit = Math.max(1, Math.min(Math.floor(Number(args.limit) || 20), 30))
        const page = all.slice(offset, offset + limit)
        if (!page.length) return `Session ${session.id} has ${all.length} ${args.archived ? 'archived ' : ''}message(s); nothing at offset ${offset}.`
        const body = page.map((m, i) => `#${offset + i} ${m.role}: ${clip(textOf(m), 1_500)}`).join('\n\n')
        return `Session ${session.id} "${session.title}" — ${args.archived ? 'archived ' : ''}messages ${offset}-${offset + page.length - 1} of ${all.length}:\n\n${body}`
      },
    }

    ctx.effect(() => ctx.tools.register(search))
    ctx.effect(() => ctx.tools.register(read))
  },
}
