import type { Context } from 'cordis'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describeToolCall } from '../services/approval.js'
import { formatUsage } from '../services/usage.js'

/**
 * What a chat channel (Telegram, Discord, ...) must provide. Everything else — which chat maps to which
 * session, the `/new` `/stop` `/status` ... commands, streaming a run with a status line, and the
 * approval round trip — is shared in `createChatCore`, so every channel behaves the same way.
 *
 * Chats are opaque strings. A transport must only call into the core for chats it has already authorized
 * (allow-listed user, private conversation); the core does no authorization of its own.
 */
export interface ChatTransport {
  /** Used in logs and as the persisted map key. */
  readonly name: string
  /** Sends text (split to the platform's limit); returns a reference to the LAST message, if any. */
  say(chat: string, text: string): Promise<string | undefined>
  edit(chat: string, ref: string, text: string): Promise<void>
  remove(chat: string, ref: string): Promise<void>
  /** Shows a typing indicator (best effort). */
  typing(chat: string): Promise<void>
  /** Sends the approval question with Allow / Deny / Always buttons; returns the message reference. */
  askApproval(chat: string, approvalId: string, text: string): Promise<string | undefined>
}

export interface ChatCoreOptions {
  /** File mapping chats to sessions (`{version:1, <name>: {chat: sessionId}}`). */
  mapFile: string
  /** Preset applied to new chats. */
  preset?: string
  /** Title prefix of created sessions. */
  title: string
}

export type ApprovalChoice = 'y' | 'n' | 'a'

const HELP = [
  'Switchboard agent. Send a message to start.',
  '/new — fresh conversation',
  '/stop — cancel the current run',
  '/compact [focus] — summarize older history',
  '/preset [id] — show or set the agent preset',
  '/status — session, preset, approval mode',
].join('\n')

export function createChatCore(ctx: Context, transport: ChatTransport, options: ChatCoreOptions) {
  const log = ctx.logger(transport.name)
  const quiet = <T>(p: Promise<T>): Promise<T | undefined> => p.catch((error) => (log.debug('%s', String(error)), undefined))

  // --------------------------------------------------- chat -> session
  const sessionOf = new Map<string, string>()
  const chatOfSession = new Map<string, string>()
  let writing: Promise<void> = Promise.resolve()
  const persist = (): void => {
    const data = JSON.stringify({ version: 1, [transport.name]: Object.fromEntries(sessionOf) }, null, 2)
    writing = writing
      .then(async () => {
        await mkdir(path.dirname(options.mapFile), { recursive: true })
        await writeFile(`${options.mapFile}.tmp`, data, { encoding: 'utf8', mode: 0o600 })
        await rename(`${options.mapFile}.tmp`, options.mapFile)
      })
      .catch(() => {})
  }
  const bind = (chat: string, sessionId: string): void => {
    const old = sessionOf.get(chat)
    if (old) chatOfSession.delete(old)
    sessionOf.set(chat, sessionId)
    chatOfSession.set(sessionId, chat)
    persist()
  }
  const newSession = (chat: string): string => {
    const session = ctx.sessions.create({ title: `${options.title} ${chat}`, ...(options.preset ? { preset: options.preset } : {}), projectRoot: ctx.workspace?.root })
    bind(chat, session.id)
    return session.id
  }
  const sessionFor = (chat: string): string => {
    const id = sessionOf.get(chat)
    return id && ctx.sessions.get(id) ? id : newSession(chat)
  }

  // ------------------------------------------------------- approvals
  const running = new Map<string, AbortController>()
  /** approval id -> where its buttons live, so a late tap can be answered and the message edited. */
  const prompts = new Map<string, { chat: string; ref?: string }>()

  const onRequest = ({ id, tool, args, sessionId }: { id: string; tool: string; args: unknown; sessionId?: string }): void => {
    const chat = sessionId ? chatOfSession.get(sessionId) : undefined
    if (chat === undefined) return // not a session of this channel: the console/CLI handles it
    prompts.set(id, { chat })
    void (async () => {
      const ref = await quiet(transport.askApproval(chat, id, `Approve ${tool}?\n${describeToolCall(tool, args)}`))
      const entry = prompts.get(id)
      if (entry) entry.ref = ref
    })()
  }
  const onSettled = ({ id, decision }: { id: string; decision: string }): void => {
    const entry = prompts.get(id)
    if (!entry) return
    prompts.delete(id)
    const label = decision === 'approved' ? '✅ Allowed' : decision === 'approved_session' ? '♾ Allowed for this chat' : decision === 'rejected' ? '❌ Denied' : decision === 'timeout' ? '⌛ Expired (no answer)' : '⏹ Cancelled'
    if (entry.ref) void quiet(transport.edit(entry.chat, entry.ref, label))
  }
  ctx.on('approval/request', onRequest)
  ctx.on('approval/settled', onSettled)

  /** A tap on an approval button from an authorized user. 'unknown' = not pending in that chat. */
  const decide = (approvalId: string, chat: string, choice: ApprovalChoice): 'done' | 'late' | 'unknown' => {
    const entry = prompts.get(approvalId)
    if (!entry || entry.chat !== chat) return 'unknown'
    return ctx.approvals.decide(approvalId, choice === 'y' ? 'approved' : choice === 'a' ? 'approved_session' : 'rejected') ? 'done' : 'late'
  }

  // --------------------------------------------------------- a run
  const run = async (chat: string, text: string): Promise<void> => {
    const ac = new AbortController()
    running.set(chat, ac)
    const typing = setInterval(() => void quiet(transport.typing(chat)), 4_000)
    void quiet(transport.typing(chat))
    let statusRef: string | undefined
    let lastEdit = 0
    const status = async (line: string): Promise<void> => {
      if (statusRef === undefined) statusRef = await quiet(transport.say(chat, line))
      else if (Date.now() - lastEdit > 1_500) {
        lastEdit = Date.now()
        await quiet(transport.edit(chat, statusRef, line))
      }
    }
    let answer = ''
    let failure = ''
    try {
      for await (const event of ctx.agent.stream(text, sessionFor(chat), { signal: ac.signal })) {
        if (event.type === 'tool_call') await status(`⚙ ${event.name} ${describeToolCall(event.name, event.args).slice(0, 120)}`)
        else if (event.type === 'notice') await status(`ℹ ${event.notice}`)
        else if (event.type === 'final') answer = event.content
        else if (event.type === 'error') failure = event.error
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    } finally {
      clearInterval(typing)
      running.delete(chat)
    }
    if (statusRef !== undefined) await quiet(transport.remove(chat, statusRef))
    if (ac.signal.aborted) await quiet(transport.say(chat, '⏹ Stopped.'))
    else if (failure) await quiet(transport.say(chat, `⚠ ${failure}`))
    else await quiet(transport.say(chat, answer || '(no answer)'))
  }

  /** One message from an authorized chat: a command, or text for the agent. */
  const handleText = async (chat: string, raw: string): Promise<void> => {
    const text = raw.trim()
    if (!text) return
    const say = (reply: string): Promise<void> => quiet(transport.say(chat, reply)).then(() => undefined)
    const command = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text)
    const name = command?.[1].toLowerCase()
    const arg = (command?.[2] ?? '').trim()
    if (name === 'start' || name === 'help') return say(HELP)
    if (name === 'new') {
      running.get(chat)?.abort()
      newSession(chat)
      return say('Started a new conversation.')
    }
    if (name === 'stop') {
      const ac = running.get(chat)
      if (!ac) return say('Nothing is running.')
      ac.abort()
      return
    }
    if (name === 'status') {
      const id = sessionFor(chat)
      const session = ctx.sessions.get(id)
      const usage = ctx.get('usage', false)
      return say([`session ${id}`, `preset ${session?.preset ?? 'none'}`, `approval ${ctx.approvals.mode}`, `usage ${usage ? formatUsage(usage.summary(id)) : 'n/a'}`, running.has(chat) ? 'running' : 'idle'].join('\n'))
    }
    if (name === 'preset') {
      const id = sessionFor(chat)
      if (!arg) return say(`Preset: ${ctx.sessions.get(id)?.preset ?? 'none'}\nAvailable: ${ctx.presets.list().map((p) => p.id).join(', ')}`)
      if (arg !== 'default' && !ctx.presets.get(arg)) return say(`No preset "${arg}".`)
      ctx.sessions.setPreset(id, arg === 'default' ? undefined : arg)
      return say(`Preset set to ${arg}.`)
    }
    if (name === 'compact') {
      if (running.has(chat)) return say('A run is in progress; try again when it ends.')
      const outcome = await ctx.compaction.compact(sessionFor(chat), { focus: arg || undefined })
      return say(outcome.ok ? `Summarized ${outcome.summarized} message(s): ~${outcome.before} → ~${outcome.after} tokens.` : `Not compacted: ${outcome.reason}`)
    }
    // `/skill-name …` and plain text both go to the agent (skills expand there).
    if (running.has(chat)) return say('Still working on the previous message. Send /stop to cancel it.')
    void run(chat, text)
  }

  /** Restores the chat -> session map from disk (only sessions that still exist). */
  const restore = (): Promise<void> =>
    readFile(options.mapFile, 'utf8')
      .then((text) => {
        const map = (JSON.parse(text) as Record<string, Record<string, string> | number>)[transport.name]
        if (map && typeof map === 'object') for (const [chat, session] of Object.entries(map)) if (ctx.sessions.get(session)) bind(chat, session)
      })
      .catch(() => {})

  const dispose = (): void => {
    for (const ac of running.values()) ac.abort()
  }

  return { handleText, decide, restore, dispose, running }
}
