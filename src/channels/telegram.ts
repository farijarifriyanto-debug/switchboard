import type { Context } from 'cordis'
import path from 'node:path'
import { createChatCore, type ChatTransport } from './core.js'
import { PairingStore } from './pairing.js'
import { expandHome } from '../services/session.js'

export interface TelegramConfig {
  enabled?: boolean
  /** Name of the env var holding the bot token. The token itself never goes in a config file. */
  tokenEnv?: string
  /** Telegram user ids allowed to talk to the agent. Required: an empty list refuses to start. */
  allowFrom?: Array<number | string>
  /** Preset applied to new chats (default: none). */
  preset?: string
  /**
   * Allow running while `approval.mode` is `off`: a chat message could then run
   * shell commands with nobody confirming. Off unless you set it on purpose.
   */
  allowUnattended?: boolean
  /** Let unknown private senders request a pairing code that you approve with `sbx channels approve <code>`. Off by default. */
  pairing?: boolean
  /** Bot API base. Tests point it at a local fake. Default https://api.telegram.org */
  apiBase?: string
  /** Long-poll seconds for getUpdates (default 25). */
  pollSeconds?: number
  /** Directory for the chat -> session map. Default `~/.switchboard`. */
  dir?: string
}

const LIMIT = 3_900

/** Splits text into Telegram-sized messages, preferring line breaks. */
export function splitMessage(text: string, limit = LIMIT): string[] {
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

interface TgUser { id: number; username?: string; first_name?: string }
interface TgChat { id: number; type: string }
interface TgMessage { message_id: number; text?: string; from?: TgUser; chat: TgChat }
interface TgCallback { id: string; from: TgUser; data?: string; message?: TgMessage }
interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback }

class TelegramError extends Error {
  constructor(readonly method: string, readonly status: number, message: string) {
    super(`telegram ${method}: ${message}`)
  }
}

/**
 * `channel-telegram` — talk to the agent from a Telegram private chat
 * (roadmap stage 6, first channel).
 *
 * Long polling only: no inbound port. Fail-closed: refuses to start without a
 * token and a non-empty allow-list, and (unless allowUnattended) without an
 * approval gate. Only private chats from allow-listed user ids are served;
 * everything else is dropped silently. Tool approvals come back as inline
 * buttons and only an allow-listed user's tap can settle them.
 */
export const telegramChannel = {
  name: 'channel-telegram',
  inject: ['agent', 'sessions', 'presets', 'approvals', 'compaction', 'workspace'],

  apply(ctx: Context, config: TelegramConfig = {}) {
    const tokenEnv = config.tokenEnv ?? 'TELEGRAM_BOT_TOKEN'
    const token = process.env[tokenEnv]?.trim()
    if (!token) throw new Error(`telegram channel: set ${tokenEnv} to the bot token (from @BotFather)`)
    const allow = new Set((config.allowFrom ?? []).map((id) => String(id).trim()).filter(Boolean))
    if (!allow.size && !config.pairing) throw new Error('telegram channel: channels.telegram.allowFrom must list at least one Telegram user id (or set "pairing": true)')
    if (ctx.approvals.mode === 'off' && !config.allowUnattended) {
      throw new Error('telegram channel: approval.mode is "off", so chat messages could run shell commands unconfirmed. Use "risky" (default) or set channels.telegram.allowUnattended')
    }
    if (config.preset && !ctx.presets?.get(config.preset)) throw new Error(`telegram channel: unknown preset "${config.preset}"`)

    const base = (config.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '')
    const pollSeconds = Math.max(1, Math.min(config.pollSeconds ?? 25, 50))
    const mapFile = path.join(path.resolve(expandHome(config.dir ?? '~/.switchboard')), 'channels.json')
    const log = ctx.logger('telegram')
    const pairing = config.pairing ? new PairingStore(path.join(path.dirname(mapFile), 'pairing.json')) : undefined

    // ------------------------------------------------------------ api
    const api = async <T = unknown>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal, timeoutMs = 15_000): Promise<T> => {
      let res: Response
      try {
        res = await fetch(`${base}/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        // never include the URL: it contains the token
        throw new TelegramError(method, 0, error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'network error')
      }
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string }
      if (!res.ok || !body.ok) throw new TelegramError(method, res.status, body.description ?? `HTTP ${res.status}`)
      return body.result as T
    }
    const quiet = <T>(p: Promise<T>): Promise<T | undefined> => p.catch((error) => (log.debug('%s', String(error)), undefined))
    const say = async (chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<number | undefined> => {
      let last: number | undefined
      for (const part of splitMessage(text)) {
        const sent = await quiet(api<{ message_id: number }>('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true, ...extra }))
        last = sent?.message_id
      }
      return last
    }

    // ------------------------------------------------- transport
    const transport: ChatTransport = {
      name: 'telegram',
      say: async (chat, text) => String((await say(Number(chat), text)) ?? '') || undefined,
      edit: async (chat, ref, text) => void (await api('editMessageText', { chat_id: Number(chat), message_id: Number(ref), text })),
      remove: async (chat, ref) => void (await api('deleteMessage', { chat_id: Number(chat), message_id: Number(ref) })),
      typing: async (chat) => void (await api('sendChatAction', { chat_id: Number(chat), action: 'typing' })),
      askApproval: async (chat, id, text) => {
        const sent = await say(Number(chat), text, {
          reply_markup: { inline_keyboard: [[{ text: '✅ Allow', callback_data: `ap|${id}|y` }, { text: '❌ Deny', callback_data: `ap|${id}|n` }, { text: '♾ Always (this chat)', callback_data: `ap|${id}|a` }]] },
        })
        return sent === undefined ? undefined : String(sent)
      },
    }
    const core = createChatCore(ctx, transport, { mapFile, ...(config.preset ? { preset: config.preset } : {}), title: 'Telegram' })
    const root = new AbortController()

    const authorized = (user: TgUser | undefined, chat: TgChat | undefined): boolean => Boolean(user && chat && chat.type === 'private' && (allow.has(String(user.id)) || pairing?.has('telegram', String(user.id))))

    const handleCallback = async (cb: TgCallback): Promise<void> => {
      await pairing?.load()
      const match = /^ap\|([^|]+)\|([yna])$/.exec(cb.data ?? '')
      const chat = cb.message?.chat
      if (!match || !authorized(cb.from, chat)) {
        await quiet(api('answerCallbackQuery', { callback_query_id: cb.id }))
        return
      }
      const outcome = core.decide(match[1], String(chat?.id), match[2] as 'y' | 'n' | 'a')
      await quiet(api('answerCallbackQuery', { callback_query_id: cb.id, text: outcome === 'unknown' ? 'This request is no longer pending.' : outcome === 'done' ? 'Done' : 'Too late' }))
    }

    const handleMessage = async (message: TgMessage): Promise<void> => {
      await pairing?.load()
      if (!authorized(message.from, message.chat)) {
        log.warn('ignored a message from an unauthorized sender')
        if (pairing && message.from && message.chat?.type === 'private') {
          const offer = await pairing.request('telegram', String(message.from.id), message.from.username ?? message.from.first_name)
          if (offer) await quiet(say(message.chat.id, `Not paired yet. Ask the owner to run:\n  sbx channels approve ${offer.code}\nThe code expires in one hour.`))
        }
        return
      }
      await core.handleText(String(message.chat.id), message.text ?? '')
    }

    // ------------------------------------------------------ polling
    const poll = async (): Promise<void> => {
      let offset = 0
      let delay = 1_000
      let conflicts = 0
      while (!root.signal.aborted) {
        try {
          const updates = await api<TgUpdate[]>('getUpdates', { offset, timeout: pollSeconds, allowed_updates: ['message', 'callback_query'] }, root.signal, (pollSeconds + 15) * 1_000)
          delay = 1_000
          conflicts = 0
          for (const update of updates) {
            offset = Math.max(offset, update.update_id + 1)
            // each update in its own try: one bad message must not stop the loop
            void (update.callback_query ? handleCallback(update.callback_query) : update.message ? handleMessage(update.message) : Promise.resolve()).catch((error) => log.warn('update failed: %s', String(error)))
          }
        } catch (error) {
          if (root.signal.aborted) return
          if (error instanceof TelegramError && error.status === 401) {
            log.error('the bot token was rejected (401); the Telegram channel is stopping')
            return
          }
          if (error instanceof TelegramError && error.status === 409) {
            conflicts += 1
            log.error('another process is polling this bot token (409)')
            if (conflicts >= 3) return
          } else log.warn('%s', String(error))
          await new Promise((resolve) => setTimeout(resolve, delay).unref?.())
          delay = Math.min(delay * 2, 30_000)
        }
      }
    }
    void api('getMe', {}, root.signal).then(
      (me) => log.info('telegram channel up as @%s', String((me as { username?: string })?.username ?? '?')),
      (error) => log.warn('getMe failed: %s', String(error)),
    )
    // restore the chat -> session map, then start polling
    const ready = core.restore()
    void ready.then(() => poll())

    // Used by automations to deliver results; only allow-listed private chats can receive.
    ctx.reflect.provide('telegram', {
      ready: () => ready,
      async send(chatId: number, text: string): Promise<void> {
        await pairing?.load()
        if (!allow.has(String(chatId)) && !pairing?.has('telegram', String(chatId))) throw new Error('chat is not on the Telegram allow-list')
        await say(chatId, text)
      },
    })

    ctx.effect(() => () => {
      root.abort()
      core.dispose()
    })
  },
}

declare module 'cordis' {
  interface Context {
    telegram?: { ready(): Promise<void>; send(chatId: number, text: string): Promise<void> }
  }
}
