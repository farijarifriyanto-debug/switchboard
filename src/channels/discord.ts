import type { Context } from 'cordis'
import path from 'node:path'
import { expandHome } from '../services/session.js'
import { createChatCore, type ChatTransport } from './core.js'

export interface DiscordConfig {
  enabled?: boolean
  /** Name of the env var holding the bot token. The token itself never goes in a config file. */
  tokenEnv?: string
  /** Discord user ids (as STRINGS: ids are too big for a JSON number) allowed to talk to the agent. An empty list refuses to start. */
  allowFrom?: Array<number | string>
  /** Preset applied to new chats (default: none). */
  preset?: string
  /** Allow running while `approval.mode` is `off`. Off unless you set it on purpose. */
  allowUnattended?: boolean
  /** REST base. Tests point it at a local fake. Default https://discord.com/api/v10 */
  apiBase?: string
  /** Gateway URL override (tests). Default: what `GET /gateway/bot` returns. */
  gatewayUrl?: string
  /** Directory for the chat -> session map. Default `~/.switchboard`. */
  dir?: string
}

const LIMIT = 1_900 // Discord rejects messages over 2000 characters
const INTENT_DIRECT_MESSAGES = 1 << 12
/** Close codes after which retrying cannot help (bad token, bad intents, ...). */
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014])
/** Close codes that invalidate the session: reconnect with a fresh IDENTIFY. */
const NO_RESUME = new Set([4007, 4009])

/** Splits text into Discord-sized messages, preferring line breaks. */
export function splitDiscord(text: string, limit = LIMIT): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit)
    if (cut < limit / 2) cut = limit
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out.length ? out : ['(empty)']
}

class DiscordError extends Error {
  constructor(readonly route: string, readonly status: number, message: string) {
    super(`discord ${route}: ${message}`)
  }
}

interface GatewayFrame { op: number; d?: any; s?: number | null; t?: string | null }

/**
 * `channel-discord` — talk to the agent from a Discord DM (the second chat channel).
 *
 * Same rules as the Telegram channel, through the shared core (`channels/core.ts`): only DMs from the
 * allow-listed user ids are served and everything else is dropped without a reply (servers and group
 * DMs are ignored); it refuses to start without a token, an allow-list, and (unless allowUnattended)
 * an approval gate; tool approvals come back as buttons that only an allow-listed user can press.
 * It connects OUT to Discord's gateway over a WebSocket, so no inbound port. Needs Node 22+ (global
 * WebSocket). Text only.
 */
export const discordChannel = {
  name: 'channel-discord',
  inject: ['agent', 'sessions', 'presets', 'approvals', 'compaction', 'workspace'],

  apply(ctx: Context, config: DiscordConfig = {}) {
    const tokenEnv = config.tokenEnv ?? 'DISCORD_BOT_TOKEN'
    const token = process.env[tokenEnv]?.trim()
    if (!token) throw new Error(`discord channel: set ${tokenEnv} to the bot token (Developer Portal > Bot > Reset Token)`)
    const ids = (config.allowFrom ?? []).map((id) => {
      if (typeof id === 'number' && !Number.isSafeInteger(id)) throw new Error('discord channel: a Discord user id is too large for a JSON number — write it as a string, e.g. "123456789012345678"')
      return String(id).trim()
    }).filter(Boolean)
    for (const id of ids) if (!/^\d{5,25}$/.test(id)) throw new Error(`discord channel: "${id}" is not a Discord user id (digits only; enable Developer Mode, right-click yourself, Copy User ID)`)
    const allow = new Set(ids)
    if (!allow.size) throw new Error('discord channel: channels.discord.allowFrom must list at least one Discord user id')
    if (ctx.approvals.mode === 'off' && !config.allowUnattended) {
      throw new Error('discord channel: approval.mode is "off", so chat messages could run shell commands unconfirmed. Use "risky" (default) or set channels.discord.allowUnattended')
    }
    if (config.preset && !ctx.presets?.get(config.preset)) throw new Error(`discord channel: unknown preset "${config.preset}"`)
    const WS = (globalThis as { WebSocket?: new (url: string) => any }).WebSocket
    if (!WS) throw new Error('discord channel: needs Node.js 22 or newer (it uses the built-in WebSocket)')

    const base = (config.apiBase ?? 'https://discord.com/api/v10').replace(/\/+$/, '')
    const mapFile = path.join(path.resolve(expandHome(config.dir ?? '~/.switchboard')), 'channels-discord.json')
    const log = ctx.logger('discord')
    const root = new AbortController()

    // ------------------------------------------------------------ REST
    const rest = async <T = unknown>(method: string, route: string, body?: unknown, attempt = 0): Promise<T> => {
      let res: Response
      try {
        res = await fetch(`${base}${route}`, {
          method,
          headers: { authorization: `Bot ${token}`, 'content-type': 'application/json', 'user-agent': 'DiscordBot (switchboard, 0)' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.any([root.signal, AbortSignal.timeout(15_000)]),
        })
      } catch (error) {
        throw new DiscordError(route, 0, error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'network error')
      }
      if (res.status === 429 && attempt < 2) {
        const wait = Number(((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 1)
        await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(wait, 0.1), 10) * 1_000).unref?.())
        return rest<T>(method, route, body, attempt + 1)
      }
      const text = await res.text()
      if (!res.ok) throw new DiscordError(route, res.status, `HTTP ${res.status}${text ? ` ${text.slice(0, 120)}` : ''}`)
      return (text ? JSON.parse(text) : undefined) as T
    }
    const quiet = <T>(p: Promise<T>): Promise<T | undefined> => p.catch((error) => (log.debug('%s', String(error)), undefined))
    const noPings = { parse: [] as string[] }

    const say = async (channel: string, text: string, extra: Record<string, unknown> = {}): Promise<string | undefined> => {
      let last: string | undefined
      for (const part of splitDiscord(text)) {
        const sent = await quiet(rest<{ id: string }>('POST', `/channels/${channel}/messages`, { content: part, allowed_mentions: noPings, ...extra }))
        last = sent?.id
      }
      return last
    }
    const transport: ChatTransport = {
      name: 'discord',
      say: (chat, text) => say(chat, text),
      edit: async (chat, ref, text) => void (await rest('PATCH', `/channels/${chat}/messages/${ref}`, { content: text.slice(0, 2_000), components: [], allowed_mentions: noPings })),
      remove: async (chat, ref) => void (await rest('DELETE', `/channels/${chat}/messages/${ref}`)),
      typing: async (chat) => void (await rest('POST', `/channels/${chat}/typing`)),
      askApproval: (chat, id, text) =>
        say(chat, text, {
          components: [{ type: 1, components: [
            { type: 2, style: 3, label: 'Allow', custom_id: `ap|${id}|y` },
            { type: 2, style: 4, label: 'Deny', custom_id: `ap|${id}|n` },
            { type: 2, style: 2, label: 'Always (this chat)', custom_id: `ap|${id}|a` },
          ] }],
        }),
    }
    const core = createChatCore(ctx, transport, { mapFile, ...(config.preset ? { preset: config.preset } : {}), title: 'Discord' })

    // ------------------------------------------------------ gateway events
    let selfId = ''
    /** DMs only (no guild), from an allow-listed human. */
    const authorized = (userId: string | undefined, guildId: unknown): boolean => Boolean(userId && !guildId && userId !== selfId && allow.has(userId))

    const onMessage = async (m: any): Promise<void> => {
      if (m?.author?.bot) return
      if (!authorized(m?.author?.id, m?.guild_id) || typeof m.channel_id !== 'string') {
        log.warn('ignored a message from an unauthorized sender')
        return
      }
      // type 0 = normal message, 19 = reply; anything else (joins, pins, ...) is not for the agent
      if (m.type !== undefined && m.type !== 0 && m.type !== 19) return
      await core.handleText(m.channel_id, String(m.content ?? ''))
    }
    const onInteraction = async (i: any): Promise<void> => {
      if (i?.type !== 3) return // message components only
      const user = i.user ?? i.member?.user
      const match = /^ap\|([^|]+)\|([yna])$/.exec(String(i.data?.custom_id ?? ''))
      const ack = (content?: string): Promise<unknown> =>
        quiet(rest('POST', `/interactions/${i.id}/${i.token}/callback`, content ? { type: 4, data: { content, flags: 64 } } : { type: 6 }))
      if (!match || !authorized(user?.id, i.guild_id)) return void (await ack())
      const outcome = core.decide(match[1], String(i.channel_id), match[2] as 'y' | 'n' | 'a')
      await ack(outcome === 'unknown' ? 'This request is no longer pending.' : outcome === 'late' ? 'Too late.' : undefined)
    }
    const dispatch = (t: string, d: any): void => {
      const task = t === 'MESSAGE_CREATE' ? onMessage(d) : t === 'INTERACTION_CREATE' ? onInteraction(d) : undefined
      void task?.catch((error) => log.warn('event failed: %s', String(error)))
    }

    // ------------------------------------------------------------ gateway
    let seq: number | null = null
    let sessionId = ''
    let resumeUrl = ''
    let socket: any

    /** One connection. Resolves with the close code when it ends. */
    const connectOnce = (url: string): Promise<{ code: number; ready: boolean }> =>
      new Promise((resolve) => {
        const sock = new WS(`${url.replace(/\/+$/, '')}/?v=10&encoding=json`)
        socket = sock
        let beat: ReturnType<typeof setInterval> | undefined
        let first: ReturnType<typeof setTimeout> | undefined
        let acked = true
        let ready = false
        let done = false
        const send = (frame: GatewayFrame): void => {
          try {
            sock.send(JSON.stringify(frame))
          } catch {
            /* closing */
          }
        }
        const finish = (code: number): void => {
          if (done) return
          done = true
          clearInterval(beat)
          clearTimeout(first)
          resolve({ code, ready })
        }
        sock.onclose = (event: { code: number }) => finish(event.code)
        sock.onerror = () => finish(1006)
        sock.onmessage = (event: { data: unknown }) => {
          let frame: GatewayFrame
          try {
            frame = JSON.parse(String(event.data)) as GatewayFrame
          } catch {
            return
          }
          if (typeof frame.s === 'number') seq = frame.s
          switch (frame.op) {
            case 10: {
              const interval = Number(frame.d?.heartbeat_interval) || 41_250
              const tick = (): void => {
                if (!acked) return void sock.close(4000, 'no heartbeat ack') // zombie connection: reconnect and resume
                acked = false
                send({ op: 1, d: seq })
              }
              first = setTimeout(() => {
                tick()
                beat = setInterval(tick, interval)
                beat.unref?.()
              }, Math.floor(interval * Math.random()))
              first.unref?.()
              if (sessionId && seq !== null) send({ op: 6, d: { token, session_id: sessionId, seq } })
              else send({ op: 2, d: { token, intents: INTENT_DIRECT_MESSAGES, properties: { os: process.platform, browser: 'switchboard', device: 'switchboard' } } })
              break
            }
            case 11:
              acked = true
              break
            case 1:
              send({ op: 1, d: seq })
              break
            case 7: // server asks us to reconnect; the session stays resumable
              sock.close(4000, 'reconnect requested')
              break
            case 9: // invalid session: d = whether it can still be resumed
              if (frame.d !== true) {
                sessionId = ''
                seq = null
              }
              setTimeout(() => sock.close(4000, 'invalid session'), 1_000 + Math.floor(Math.random() * 4_000)).unref?.()
              break
            case 0:
              if (frame.t === 'READY') {
                ready = true
                sessionId = String(frame.d?.session_id ?? '')
                resumeUrl = String(frame.d?.resume_gateway_url ?? '')
                selfId = String(frame.d?.user?.id ?? '')
                log.info('discord channel up as %s', String(frame.d?.user?.username ?? '?'))
              } else if (frame.t === 'RESUMED') ready = true
              else if (frame.t) dispatch(frame.t, frame.d)
              break
          }
        }
      })

    const run = async (): Promise<void> => {
      let delay = 1_000
      let url = config.gatewayUrl
      while (!root.signal.aborted) {
        try {
          url ??= (await rest<{ url: string }>('GET', '/gateway/bot')).url
          const end = await connectOnce(sessionId && resumeUrl ? resumeUrl : url)
          if (root.signal.aborted) return
          if (FATAL.has(end.code)) {
            log.error('discord closed the connection with code %d (bad token or intents); the Discord channel is stopping', end.code)
            return
          }
          if (NO_RESUME.has(end.code)) {
            sessionId = ''
            seq = null
          }
          if (end.ready) delay = 1_000
        } catch (error) {
          if (root.signal.aborted) return
          if (error instanceof DiscordError && error.status === 401) {
            log.error('the bot token was rejected (401); the Discord channel is stopping')
            return
          }
          log.warn('%s', String(error))
        }
        await new Promise((resolve) => setTimeout(resolve, delay).unref?.())
        delay = Math.min(delay * 2, 30_000)
      }
    }
    void core.restore().then(() => run())

    // Used by automations to deliver results; only allow-listed users can receive (opens a DM with them).
    ctx.reflect.provide('discord', {
      async send(userId: string, text: string): Promise<void> {
        if (!allow.has(String(userId))) throw new Error('user is not on the Discord allow-list')
        const dm = await rest<{ id: string }>('POST', '/users/@me/channels', { recipient_id: String(userId) })
        await say(dm.id, text)
      },
    })

    ctx.effect(() => () => {
      root.abort()
      try {
        socket?.close(1000)
      } catch {
        /* already closed */
      }
      core.dispose()
    })
  },
}

declare module 'cordis' {
  interface Context {
    discord?: { send(userId: string, text: string): Promise<void> }
  }
}
