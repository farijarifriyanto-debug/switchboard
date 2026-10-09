import type { Context } from 'cordis'
import type { AgentMessage } from '../types.js'
import type { ToolSpec, ToolContext } from './tools.js'
import { queryTerms, searchText, searchLimit, type SearchMode } from './search.js'

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
  return searchText(text, words)
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
          match: { type: 'string', enum: ['all', 'any'], description: 'All query terms (default), or any term.' },
        },
        required: ['query'],
      },
      async execute(args: { query: string; limit?: number; match?: SearchMode }, tctx: ToolContext) {
        if (args.match !== undefined && !['all', 'any'].includes(args.match)) return 'Error: match must be all or any.'
        const words = queryTerms(args.query)
        if (!words.length) return 'Error: give at least one word of 2+ characters to search for.'
        const limit = searchLimit(args.limit)
        const hits: Hit[] = []
        let count = 0
        const order = (a: Hit, b: Hit): number => b.score - a.score || b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId) || a.index - b.index
        async function* candidates() {
          const live = ctx.sessions.list(), ids = new Set(live.map(s => s.id))
          yield* live
          for await (const stored of ctx.sessions.stored()) if (!ids.has(stored.id)) yield stored
        }
        for await (const session of candidates()) {
          if (tctx.signal?.aborted) return 'Error: session search cancelled.'
          const scan = (messages: AgentMessage[], where: Hit['where']): void => {
            messages.forEach((m, index) => {
              if (m.role === 'system') return
              if (where === 'live' && session.id === tctx.sessionId) return
              const found = searchText(textOf(m), words, args.match)
              if (found) {
                count++
                hits.push({ sessionId: session.id, title: session.title, role: m.role, where, index, snippet: found.snippet, updatedAt: session.updatedAt, score: found.score })
                hits.sort(order)
                if (hits.length > limit) hits.pop()
              }
            })
          }
          scan(session.messages, 'live')
          scan(session.archived ?? [], 'archived')
        }
        if (!hits.length) return `No earlier conversation mentions: ${words.join(' ')}`
        const lines = hits.slice(0, limit).map(
          (h, i) => `${i + 1}. ${h.sessionId} "${clip(h.title, 50)}" · ${h.where === 'archived' ? 'archived ' : ''}${h.role} #${h.index} · ${new Date(h.updatedAt).toISOString().slice(0, 10)}\n   ${h.snippet}`,
        )
        return `${count} match(es), showing ${lines.length}:\n${lines.join('\n')}`
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
      async execute(args: { id: string; offset?: number; limit?: number; archived?: boolean }) {
        const id = String(args.id ?? '').trim()
        if (!/^[\w-]+$/.test(id)) return `Error: no session "${args.id}"`
        let session = ctx.sessions.get(id) ?? await ctx.sessions.readStored(id)
        if (!session) {
          const matches = ctx.sessions.list().filter(s => s.id.startsWith(id))
          const seen = new Set(matches.map(s => s.id))
          for await (const stored of ctx.sessions.stored()) if (stored.id.startsWith(id) && !seen.has(stored.id)) matches.push(stored)
          if (matches.length === 1) session = matches[0]
        }
        if (!session) return `Error: no session "${args.id}"`
        const all = (args.archived ? session.archived ?? [] : session.messages).filter((m) => m.role !== 'system')
        const offset = Number.isFinite(Number(args.offset)) ? Math.max(0, Math.floor(Number(args.offset))) : 0
        const limit = searchLimit(args.limit, 20, 30)
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
