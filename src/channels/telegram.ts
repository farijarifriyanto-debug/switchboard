import { formatUsage } from '../services/usage.js'
import type { Context } from 'cordis'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describeToolCall } from '../services/approval.js'
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

interface TgUser { id: number }
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
    if (!allow.size) throw new Error('telegram channel: channels.telegram.allowFrom must list at least one Telegram user id')
    if (ctx.approvals.mode === 'off' && !config.allowUnattended) {
      throw new Error('telegram channel: approval.mode is "off", so chat messages could run shell commands unconfirmed. Use "risky" (default) or set channels.telegram.allowUnattended')
    }
    if (config.preset && !ctx.presets?.get(config.preset)) throw new Error(`telegram channel: unknown preset "${config.preset}"`)

    const base = (config.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '')
    const pollSeconds = Math.max(1, Math.min(config.pollSeconds ?? 25, 50))
    const mapFile = path.join(path.resolve(expandHome(config.dir ?? '~/.switchboard')), 'channels.json')
    const log = ctx.logger('telegram')

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

    // --------------------------------------------------- chat -> session
    const sessionOf = new Map<number, string>()
    const chatOfSession = new Map<string, number>()
    let writing: Promise<void> = Promise.resolve()
    const persist = (): void => {
      const data = JSON.stringify({ version: 1, telegram: Object.fromEntries(sessionOf) }, null, 2)
      writing = writing
        .then(async () => {
          await mkdir(path.dirname(mapFile), { recursive: true })
          await writeFile(`${mapFile}.tmp`, data, { encoding: 'utf8', mode: 0o600 })
          await rename(`${mapFile}.tmp`, mapFile)
        })
        .catch(() => {})
    }
    const bind = (chatId: number, sessionId: string): void => {
      const old = sessionOf.get(chatId)
      if (old) chatOfSession.delete(old)
      sessionOf.set(chatId, sessionId)
      chatOfSession.set(sessionId, chatId)
      persist()
    }
    const newSession = (chatId: number): string => {
      const session = ctx.sessions.create({ title: `Telegram ${chatId}`, ...(config.preset ? { preset: config.preset } : {}), projectRoot: ctx.workspace?.root })
      bind(chatId, session.id)
      return session.id
    }
    const sessionFor = (chatId: number): string => {
      const id = sessionOf.get(chatId)
      return id && ctx.sessions.get(id) ? id : newSession(chatId)
    }

    // ------------------------------------------------------- state
    const running = new Map<number, AbortController>()
    /** approval id -> where its buttons live, so a late tap can be answered/edited. */
    const prompts = new Map<string, { chatId: number; messageId?: number }>()
    const root = new AbortController()

    const authorized = (user: TgUser | undefined, chat: TgChat | undefined): boolean => Boolean(user && chat && chat.type === 'private' && allow.has(String(user.id)))

    // ----------------------------------------------------- approvals
    const onRequest = ({ id, tool, args, sessionId }: { id: string; tool: string; args: unknown; sessionId?: string }): void => {
      const chatId = sessionId ? chatOfSession.get(sessionId) : undefined
      if (chatId === undefined) return // not a Telegram session: the console/CLI handles it
      prompts.set(id, { chatId })
      void (async () => {
        const messageId = await say(chatId, `Approve ${tool}?\n${describeToolCall(tool, args)}`, {
          reply_markup: { inline_keyboard: [[{ text: '✅ Allow', callback_data: `ap|${id}|y` }, { text: '❌ Deny', callback_data: `ap|${id}|n` }, { text: '♾ Always (this chat)', callback_data: `ap|${id}|a` }]] },
        })
        const entry = prompts.get(id)
        if (entry) entry.messageId = messageId
      })()
    }
    const onSettled = ({ id, decision }: { id: string; decision: string }): void => {
      const entry = prompts.get(id)
      if (!entry) return
      prompts.delete(id)
      const label = decision === 'approved' ? '✅ Allowed' : decision === 'approved_session' ? '♾ Allowed for this chat' : decision === 'rejected' ? '❌ Denied' : decision === 'timeout' ? '⌛ Expired (no answer)' : '⏹ Cancelled'
      if (entry.messageId) void quiet(api('editMessageText', { chat_id: entry.chatId, message_id: entry.messageId, text: label }))
    }
    ctx.on('approval/request', onRequest)
    ctx.on('approval/settled', onSettled)

    const handleCallback = async (cb: TgCallback): Promise<void> => {
      const match = /^ap\|([^|]+)\|([yna])$/.exec(cb.data ?? '')
      const chat = cb.message?.chat
      if (!match || !authorized(cb.from, chat)) {
        await quiet(api('answerCallbackQuery', { callback_query_id: cb.id }))
        return
      }
      const entry = prompts.get(match[1])
      if (!entry || entry.chatId !== chat?.id) {
        await quiet(api('answerCallbackQuery', { callback_query_id: cb.id, text: 'This request is no longer pending.' }))
        return
      }
      const decided = ctx.approvals.decide(match[1], match[2] === 'y' ? 'approved' : match[2] === 'a' ? 'approved_session' : 'rejected')
      await quiet(api('answerCallbackQuery', { callback_query_id: cb.id, text: decided ? 'Done' : 'Too late' }))
    }

    // --------------------------------------------------- messages
    const help = [
      'Switchboard agent. Send a message to start.',
      '/new — fresh conversation',
      '/stop — cancel the current run',
      '/compact [focus] — summarize older history',
      '/preset [id] — show or set the agent preset',
      '/status — session, preset, approval mode',
    ].join('\n')

    const run = async (chatId: number, text: string): Promise<void> => {
      const ac = new AbortController()
      running.set(chatId, ac)
      const typing = setInterval(() => void quiet(api('sendChatAction', { chat_id: chatId, action: 'typing' })), 4_000)
      void quiet(api('sendChatAction', { chat_id: chatId, action: 'typing' }))
      let statusId: number | undefined
      let lastEdit = 0
      const status = async (line: string): Promise<void> => {
        if (statusId === undefined) statusId = await say(chatId, line)
        else if (Date.now() - lastEdit > 1_500) {
          lastEdit = Date.now()
          await quiet(api('editMessageText', { chat_id: chatId, message_id: statusId, text: line }))
        }
      }
      let answer = ''
      let failure = ''
      try {
        for await (const event of ctx.agent.stream(text, sessionFor(chatId), { signal: ac.signal })) {
          if (event.type === 'tool_call') await status(`⚙ ${event.name} ${describeToolCall(event.name, event.args).slice(0, 120)}`)
          else if (event.type === 'notice') await status(`ℹ ${event.notice}`)
          else if (event.type === 'final') answer = event.content
          else if (event.type === 'error') failure = event.error
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      } finally {
        clearInterval(typing)
        running.delete(chatId)
      }
      if (statusId !== undefined) await quiet(api('deleteMessage', { chat_id: chatId, message_id: statusId }))
      if (ac.signal.aborted) await say(chatId, '⏹ Stopped.')
      else if (failure) await say(chatId, `⚠ ${failure}`)
      else await say(chatId, answer || '(no answer)')
    }

    const handleMessage = async (message: TgMessage): Promise<void> => {
      if (!authorized(message.from, message.chat)) {
        log.warn('ignored a message from an unauthorized sender')
        return
      }
      const chatId = message.chat.id
      const text = (message.text ?? '').trim()
      if (!text) return
      const command = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text)
      const name = command?.[1].toLowerCase()
      const arg = (command?.[2] ?? '').trim()
      if (name === 'start' || name === 'help') return void (await say(chatId, help))
      if (name === 'new') {
        running.get(chatId)?.abort()
        newSession(chatId)
        return void (await say(chatId, 'Started a new conversation.'))
      }
      if (name === 'stop') {
        const ac = running.get(chatId)
        if (!ac) return void (await say(chatId, 'Nothing is running.'))
        ac.abort()
        return
      }
      if (name === 'status') {
        const id = sessionFor(chatId)
        const session = ctx.sessions.get(id)
        return void (await say(chatId, [`session ${id}`, `preset ${session?.preset ?? 'none'}`, `approval ${ctx.approvals.mode}`, `usage ${ctx.get('usage', false) ? formatUsage(ctx.get('usage', false)!.summary(id)) : 'n/a'}`, running.has(chatId) ? 'running' : 'idle'].join('\n')))
      }
      if (name === 'preset') {
        const id = sessionFor(chatId)
        if (!arg) return void (await say(chatId, `Preset: ${ctx.sessions.get(id)?.preset ?? 'none'}\nAvailable: ${ctx.presets.list().map((p) => p.id).join(', ')}`))
        if (arg !== 'default' && !ctx.presets.get(arg)) return void (await say(chatId, `No preset "${arg}".`))
        ctx.sessions.setPreset(id, arg === 'default' ? undefined : arg)
        return void (await say(chatId, `Preset set to ${arg}.`))
      }
      if (name === 'compact') {
        if (running.has(chatId)) return void (await say(chatId, 'A run is in progress; try again when it ends.'))
        const outcome = await ctx.compaction.compact(sessionFor(chatId), { focus: arg || undefined })
        return void (await say(chatId, outcome.ok ? `Summarized ${outcome.summarized} message(s): ~${outcome.before} → ~${outcome.after} tokens.` : `Not compacted: ${outcome.reason}`))
      }
      // `/skill-name …` and plain text both go to the agent (skills expand there).
      if (running.has(chatId)) return void (await say(chatId, 'Still working on the previous message. Send /stop to cancel it.'))
      void run(chatId, text)
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
    const ready = readFile(mapFile, 'utf8')
      .then((text) => {
        const map = (JSON.parse(text) as { telegram?: Record<string, string> }).telegram ?? {}
        for (const [chat, session] of Object.entries(map)) if (ctx.sessions.get(session)) bind(Number(chat), session)
      })
      .catch(() => {})
      .then(() => poll())
    void ready

    // Used by automations to deliver results; only allow-listed private chats can receive.
    ctx.reflect.provide('telegram', {
      async send(chatId: number, text: string): Promise<void> {
        if (!allow.has(String(chatId))) throw new Error('chat is not on the Telegram allow-list')
        await say(chatId, text)
      },
    })

    ctx.effect(() => () => {
      root.abort()
      for (const ac of running.values()) ac.abort()
    })
  },
}

declare module 'cordis' {
  interface Context {
    telegram?: { send(chatId: number, text: string): Promise<void> }
  }
}
