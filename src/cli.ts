#!/usr/bin/env node
import { constants, promises as fs, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createHost } from './index.js'
import { describeToolCall } from './services/approval.js'
import { formatUsage } from './services/usage.js'
import { formatUndo } from './services/undo.js'
import { SkillDrafts, installCandidate, removeSkill, stageSource } from './services/skill-store.js'
import { loadConfig, type SwitchboardConfig } from './config.js'

const USAGE = `sbx — Switchboard

Usage:
  sbx [options] [command]

Commands:
  chat [prompt...]   Start an interactive session (default command)
  run <prompt...>    Run one prompt and print the answer, then exit
  web                Serve the local operator console (http://127.0.0.1:7777)
  sessions           List stored sessions
  presets            List agent presets (use one with --preset <id>)
  automations [cmd]  list | add <cron> <prompt…> | run <id> | remove <id> (scheduled agent runs)
  channels           Run the configured chat channels (Telegram, Discord) until interrupted
  channels pairing   List pending pairing codes and approved senders (also: channels approve <code>, channels revoke <channel> <id>)
  skills             List skills found for this workspace (SKILL.md folders)
  info               Show config, endpoint and loaded plugins
  doctor             Run diagnostics (config, host, endpoint, key, data dir)
  tools              List registered tools
  models             List models advertised by the endpoint
  metrics            Show per-model latency collected this session
  ci [name] [--list] Run local workflows from .switchboard/workflows/
  help               Show this help

Options:
  -c, --config <file>   Config file (default: ./switchboard.config.jsonc, then ~/.switchboard/config.jsonc)
  -m, --model <id>      Model override
  -r, --resume <id>     Continue a stored session (id or unique prefix)
  -p, --plugins <list>  Comma-separated extra plugin paths or packages
      --cwd <dir>       Workspace root for filesystem/shell tools
      --port <n>        Port for the console (default: 7777)
      --host <addr>     Interface for the console (default: 127.0.0.1; others get an access token)
      --no-open         Do not open a browser for 'sbx web'
      --no-session      Do not persist the session to disk
      --json            'sbx run': print one JSON object per line (events, then a final result) instead of text
      --name <text>     Name for 'sbx automations add'
      --telegram <id>   Deliver an automation's result to this Telegram user id
      --discord <id>    Deliver an automation's result to this Discord user id (a string of digits)
      --preset <id>     Run with an agent preset (system prompt, model, step budget, tool access)
      --sandbox <mode>  Run run_command in a sandbox: bwrap (Linux) or docker
      --approval <m>    Tool approval: risky (default), all, or off
  -y, --yes             Run tools without asking (same as --approval off)
  -v, --version         Print version
`

export interface Args {
  command: string
  positional: string[]
  configPath?: string
  model?: string
  plugins: string[]
  cwd?: string
  resume?: string
  session: boolean
  port?: number
  host?: string
  preset?: string
  name?: string
  telegram?: number
  discord?: string
  open: boolean
  json?: boolean
  approval?: 'off' | 'risky' | 'all'
  sandbox?: 'bwrap' | 'docker'
}

function parseArgs(argv: string[]): Args {
  const out: Args = { command: 'chat', positional: [], plugins: [], session: true, open: true }
  const commands = new Set(['chat', 'run', 'web', 'sessions', 'info', 'doctor', 'tools', 'models', 'metrics', 'ci', 'presets', 'skills', 'memory', 'channels', 'automations', 'help'])
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === '-c' || arg === '--config') out.configPath = argv[++i]
    else if (arg === '-m' || arg === '--model') out.model = argv[++i]
    else if (arg === '-r' || arg === '--resume') out.resume = argv[++i]
    else if (arg === '-p' || arg === '--plugins') out.plugins.push(...(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
    else if (arg === '--cwd') out.cwd = argv[++i]
    else if (arg === '--port') out.port = Number(argv[++i])
    else if (arg === '--host') out.host = argv[++i]
    else if (arg === '--preset') out.preset = argv[++i]
    else if (arg === '--name') out.name = argv[++i]
    else if (arg === '--telegram') out.telegram = Number(argv[++i])
    else if (arg === '--discord') out.discord = argv[++i]
    else if (arg === '--no-open') out.open = false
    else if (arg === '--json') out.json = true
    else if (arg === '-y' || arg === '--yes') out.approval = 'off'
    else if (arg === '--sandbox') {
      const mode = argv[++i]
      if (mode !== 'bwrap' && mode !== 'docker') throw new Error('--sandbox must be bwrap or docker')
      out.sandbox = mode
    } else if (arg === '--approval') {
      const mode = argv[++i]
      if (mode !== 'off' && mode !== 'risky' && mode !== 'all') throw new Error('--approval must be off, risky or all')
      out.approval = mode
    }
    else if (arg === '--no-session') out.session = false
    else if (arg === '-h' || arg === '--help') out.command = 'help'
    else if (arg === '-v' || arg === '--version') out.command = 'version'
    else if (arg.startsWith('-')) out.positional.push(arg)
    else if (!out.positional.length && commands.has(arg)) out.command = arg
    else out.positional.push(arg)
    i += 1
  }
  return out
}

async function resolveConfigPath(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit
  const local = path.resolve('switchboard.config.jsonc')
  try {
    await fs.access(local)
    return local
  } catch {
    /* fall through */
  }
  const home = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.switchboard', 'config.jsonc')
  try {
    await fs.access(home)
    return home
  } catch {
    return undefined
  }
}

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
}

/**
 * The CLI is the operator for `chat`/`run`: ask on the terminal when there is
 * one, otherwise refuse immediately (an unattended gate would just time out)
 * and say how to opt out.
 */
function attachCliApprover(ctx: import('cordis').Context, ask: ((question: string) => Promise<string | null>) | null): void {
  ctx.on('approval/request', ({ id, tool, args }) => {
    if (!ask) {
      process.stderr.write(C.yellow(`sbx: ${tool} needs approval but there is no terminal to ask — refused. Re-run with --yes, or set approval.mode in the config.\n`))
      ctx.approvals.decide(id, 'rejected')
      return
    }
    void (async () => {
      const answer = await ask(`\n${C.yellow('approve')} ${C.bold(tool)} ${describeToolCall(tool, args)}\n  allow? [y]es / [N]o / [a]lways this session › `)
      const a = (answer ?? '').trim().toLowerCase()
      ctx.approvals.decide(id, a === 'a' || a === 'always' ? 'approved_session' : a === 'y' || a === 'yes' ? 'approved' : 'rejected')
    })()
  })
}

/** True when the resolved config file sets `approval.mode` itself. */
async function hasExplicitApprovalMode(configPath?: string): Promise<boolean> {
  if (!configPath) return false
  const text = await fs.readFile(configPath, 'utf8').catch(() => '')
  if (!text) return false
  try {
    return Boolean(JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')).approval?.mode)
  } catch {
    return false
  }
}

/** Human label for one MCP server status (`up (n tools)` / `down (reason)` / …). */
function mcpStateLabel(s: { state: string; tools: string[]; lastError?: string }): string {
  if (s.state === 'up') return `up (${s.tools.length} tools)`
  if (s.state === 'exhausted') return 'exhausted'
  if (s.state === 'connecting') return 'connecting'
  return `down (${s.lastError ?? 'unknown'})`
}

function metricsLine(m: { model: string; ttftMs: number; totalMs: number; tokensPerSec: number; usage: { completionTokens?: number; cachedTokens?: number } }): string {  const parts = [
    C.dim('metrics'),
    C.cyan(m.model),
    `ttft ${m.ttftMs}ms`,
    `total ${m.totalMs}ms`,
    `${m.tokensPerSec} tok/s`,
  ]
  if (m.usage.completionTokens) parts.push(`out ${m.usage.completionTokens} tok`)
  if (m.usage.cachedTokens) parts.push(`cached ${m.usage.cachedTokens} tok`)
  return parts.join(C.dim(' · '))
}

/**
 * Streams an agent run to the console.
 *
 * Reasoning is written with a single dim wrapper on either side instead of per
 * delta, so the terminal does not end up with hundreds of tiny escape
 * sequences (which also breaks copy/paste).
 */
async function renderRun(events: AsyncIterable<{ type: string; [k: string]: any }>, label: string): Promise<{ ok: boolean; text: string }> {
  let inReasoning = false
  let text = ''
  let ok = true
  const closeReasoning = () => {
    if (inReasoning) {
      process.stderr.write('\x1b[0m')
      inReasoning = false
    }
  }

  for await (const ev of events) {
    switch (ev.type) {
      case 'reasoning':
        if (!inReasoning) {
          process.stderr.write(`\x1b[2m${label}`)
          inReasoning = true
        }
        process.stderr.write(ev.text)
        break
      case 'delta':
        closeReasoning()
        process.stdout.write(ev.text)
        text += ev.text
        break
      case 'notice':
        closeReasoning()
        process.stderr.write(C.dim(`\n[${ev.notice}]\n`))
        break
      case 'tool_call':
        closeReasoning()
        process.stderr.write(`\n${C.yellow('→ ' + ev.name)} ${C.dim(JSON.stringify(ev.args))}\n`)
        break
      case 'tool_result':
        process.stderr.write(`${C.dim('← ' + ev.name)} ${C.dim(String(ev.result).slice(0, 200).replace(/\n/g, ' '))}\n`)
        break
      case 'metrics':
        closeReasoning()
        process.stderr.write(C.dim(`\n[${metricsLine(ev.metrics)}]\n`))
        break
      case 'error':
        closeReasoning()
        process.stderr.write(C.red(`error: ${ev.error}\n`))
        ok = false
        break
      default:
        break
    }
  }
  closeReasoning()
  return { ok, text }
}

/**
 * `sbx run --json`: machine-readable run. stdout carries ONLY JSON Lines — every agent event as it
 * happens, then one final `{"type":"result","ok":…,"text":…,"sessionId":…}`. Exit code 1 when the run failed.
 */
async function renderRunJson(events: AsyncIterable<{ type: string; [k: string]: any }>, sessionId: string): Promise<boolean> {
  let ok = true
  let text = ''
  for await (const ev of events) {
    if (ev.type === 'delta') text += ev.text
    if (ev.type === 'error') ok = false
    process.stdout.write(`${JSON.stringify(ev)}\n`)
  }
  process.stdout.write(`${JSON.stringify({ type: 'result', ok, text, sessionId })}\n`)
  return ok
}

/** `sbx ci` — local workflow runner. Dispatched before the host boots. */
export async function runCiCommand(args: Args, config: SwitchboardConfig): Promise<void> {
  const root = path.resolve(args.cwd ?? config.workspace?.root ?? process.cwd())
  if (config.ci?.enabled !== true) {
    console.log(C.yellow('ci is disabled'))
    console.log(`Add ${C.bold('"ci": { "enabled": true }')} to switchboard.config.jsonc to enable the local workflow runner.`)
    process.exitCode = 1
    return
  }
  const { listWorkflows, runWorkflow, listRuns, resolveKeepRuns, parseCron, nextFire } = await import('./ci/index.js')
  const keepRuns = resolveKeepRuns(config.ci?.keepRuns)
  const list = await listWorkflows(root)
  const wanted = args.positional.find((p) => !p.startsWith('-'))
  if (args.positional.includes('--list')) {
    const runs = (await listRuns(root, { limit: 50 })).runs
    const last = new Map<string, string>()
    for (const record of runs) {
      if (!last.has(record.workflow)) last.set(record.workflow, record.status)
    }
    const fmtLocal = (d: Date): string => {
      const p = (n: number): string => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }
    const nextOf = (schedule: string[]): Date | null => {
      let next: Date | null = null
      for (const cron of schedule) {
        const at = nextFire(parseCron(cron), new Date())
        if (at && (!next || at.getTime() < next.getTime())) next = at
      }
      return next
    }
    if (!list.length) console.log(C.dim(`no workflows in ${path.join(root, '.switchboard', 'workflows')}`))
    for (const wf of list) {
      const error = wf.error ? ` ${C.red(`· ${wf.error}`)}` : ''
      const status = last.get(wf.id) ?? '-'
      const cronText = wf.schedule.length ? wf.schedule.join(' | ') : '-'
      const next = nextOf(wf.schedule)
      console.log(
        `${C.cyan(wf.id.padEnd(20))} ${wf.name}${error} ${C.dim(wf.jobs.join(', '))} ${C.dim(`last: ${status}`)} ${C.dim(`cron: ${cronText}`)} ${C.dim(`next: ${next ? fmtLocal(next) : '-'}`)}`,
      )
    }
    return
  }
  // spec §7: `sbx ci <name>` runs a single workflow — first match wins, like the web POST
  const targets = wanted ? list.filter((w) => w.id === wanted || w.name === wanted).slice(0, 1) : list
  if (wanted && !targets.length) {
    console.error(C.red(`unknown workflow "${wanted}" (available: ${list.map((w) => w.id).join(', ') || 'none'})`))
    process.exitCode = 1
    return
  }
  if (!targets.length) {
    console.log(C.dim(`no workflows in ${path.join(root, '.switchboard', 'workflows')}`))
    return
  }
  // Ctrl+C aborts the current run; the handler never exits the process itself,
  // so the loop can persist the `cancelled` record before we leave.
  const controller = new AbortController()
  let interrupted: NodeJS.Signals | null = null
  const onInterrupt = (signal: NodeJS.Signals): void => {
    if (!interrupted) interrupted = signal
    controller.abort()
  }
  const onSigint = (): void => onInterrupt('SIGINT')
  const onSigterm = (): void => onInterrupt('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)

  let failed = false
  try {
    for (const wf of targets) {
      console.log(`${C.bold(`▸ ${wf.name}`)} ${C.dim(`(${wf.id})`)}`)
      const record = await runWorkflow(root, wf.id, {
        trigger: 'cli',
        keepRuns,
        signal: controller.signal,
        onEvent(ev) {
          if (ev.type === 'step_start') {
            console.log(C.dim(`  · ${ev.step.name}`))
          } else if (ev.type === 'step_end') {
            const ok = ev.record.status === 'success'
            const ms = ev.record.startedAt && ev.record.endedAt ? Date.parse(ev.record.endedAt) - Date.parse(ev.record.startedAt) : 0
            console.log(`${ok ? C.green('  ✓') : C.red('  ✗')} ${ev.step.name} ${C.dim(`${ev.record.exitCode ?? '-'} · ${ms}ms`)}`)
            if (ev.record.log.trim()) {
              for (const line of ev.record.log.trimEnd().split('\n')) console.log(C.dim(`      ${line}`))
            }
            if (ev.record.note) console.log(C.yellow(`      ${ev.record.note}`))
          }
        },
      })
      if (record.status === 'success') console.log(C.green(`  run ${record.status}`))
      else {
        console.log(C.red(`  run ${record.status}${record.error ? `: ${record.error}` : ''}`))
        failed = true
      }
      if (controller.signal.aborted) break
    }
  } finally {
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
  }
  if (interrupted) {
    process.exitCode = interrupted === 'SIGINT' ? 130 : 143
    return
  }
  if (failed) process.exitCode = 1
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === 'version') {
    const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(`sbx ${pkg.version}`)
    return
  }
  if (args.command === 'help') {
    console.log(USAGE)
    return
  }

  const configPath = await resolveConfigPath(args.configPath)
  const config = await loadConfig(configPath)
  if (args.model) config.llm = { ...config.llm, defaultModel: args.model }
  if (!args.session) config.sessions = { ...config.sessions, dir: '', load: false }
  if (args.cwd) {
    config.workspace = { ...config.workspace, root: args.cwd }
    config.tools = { ...config.tools, fs: { ...config.tools?.fs, root: args.cwd }, shell: { ...config.tools?.shell, cwd: args.cwd } }
  }
  if (args.plugins.length) config.plugins = [...(config.plugins ?? []), ...args.plugins]
  if (args.command === 'ci') {
    await runCiCommand(args, config)
    return
  }
  if (args.command === 'web') {
    config.web = { ...config.web, enabled: true, ...(args.port ? { port: args.port } : {}), ...(args.host ? { host: args.host } : {}) }
    // A non-loopback bind must not be open: mint a token unless one is configured.
    const bindHost = (config.web.host ?? '127.0.0.1').toLowerCase()
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(bindHost) && !config.web.token && !process.env.SWITCHBOARD_WEB_TOKEN) {
      config.web = { ...config.web, token: randomBytes(24).toString('base64url') }
    }
    // The console implies an operator at the screen: gate risky tools unless the
    // config file explicitly chose a mode.
    const explicit = await hasExplicitApprovalMode(configPath)
    if (!explicit) config.approval = { ...config.approval, mode: 'risky' }
  }
  if (args.approval) config.approval = { ...config.approval, mode: args.approval }
  if (args.sandbox) config.tools = { ...config.tools, shell: { ...config.tools?.shell, sandbox: { ...config.tools?.shell?.sandbox, mode: args.sandbox } } }

  // CLI and local Web UI both own the browser bridge. Browser actions run
  // in the same agent host and the extension remains only a browser tool.
  if ((args.command === 'chat' || args.command === 'run' || args.command === 'web') && config.browser?.enabled !== false) {
    const browserDir = path.join(os.homedir(), '.switchboard')
    const tokenFile = path.join(browserDir, 'browser-companion-token')
    await fs.mkdir(browserDir, { recursive: true, mode: 0o700 })
    let browserToken: string
    try {
      browserToken = (await fs.readFile(tokenFile, 'utf8')).trim()
      if (!/^[a-f0-9]{48}$/.test(browserToken)) throw new Error('Invalid companion token file')
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
      browserToken = randomBytes(24).toString('hex')
      await fs.writeFile(tokenFile, browserToken + '\n', { flag: 'wx', mode: 0o600 })
    }
    // Never accept a public bind for the CLI browser companion.
    config.browser = {
      ...config.browser,
      host: '127.0.0.1',
      port: config.browser?.port ?? 7778,
      token: config.browser?.token ?? browserToken,
    }
  }

  const host = await createHost(config)
  const { ctx } = host
  if (args.preset && !ctx.presets.get(args.preset)) {
    await host.dispose()
    throw new Error(`unknown preset "${args.preset}" (see: sbx presets)`)
  }
  const presetOptions = args.preset ? { preset: args.preset } : {}

  /** Creates a session or resumes an existing one (id or unique prefix). */
  const startSession = (title: string): { id: string; resumed: boolean } => {
    if (args.resume) {
      const found = ctx.sessions.find(args.resume)
      if (!found) throw new Error(`no session matches "${args.resume}"`)
      return { id: found.id, resumed: true }
    }
    return { id: ctx.sessions.create({ title, model: args.model }).id, resumed: false }
  }

  try {
    switch (args.command) {
      case 'info': {
        const models = await ctx.llm.listModels().catch(() => [])
        console.log(C.bold('Switchboard'))
        console.log(`config      ${configPath ?? C.dim('(defaults)')}`)
        console.log(`endpoint    ${ctx.llm.settings.baseURL}`)
        console.log(`model       ${ctx.llm.settings.defaultModel}`)
        console.log(`api key     ${process.env.BOTCONNECTOR_API_KEY ? C.green('set') : C.yellow('not set (BOTCONNECTOR_API_KEY)')}`)
        console.log(`models      ${models.length} advertised`)
        console.log(`tools       ${ctx.tools.list().map((t) => t.name).join(', ')}`)
        console.log(`plugins     ${[...ctx.registry.values()].map((f) => f.name).filter(Boolean).join(', ')}`)
        for (const s of ctx.mcp?.status() ?? []) {
          console.log(`mcp         ${s.name}: ${mcpStateLabel(s)}`)
        }
        break
      }
      case 'doctor': {
        let errors = 0
        let warnings = 0
        console.log(C.bold('sbx doctor'))
        console.log(`  ${C.green('✓')} config      ${configPath ?? C.dim('(defaults)')}`)
        const plugins = [...ctx.registry.values()].map((f) => f.name).filter(Boolean)
        console.log(`  ${C.green('✓')} host        ${plugins.length} plugins · ${ctx.tools.list().length} tools`)
        try {
          const models = await ctx.llm.listModels()
          console.log(`  ${C.green('✓')} endpoint    ${ctx.llm.settings.baseURL} (${models.length} models)`)
        } catch (error) {
          errors += 1
          const message = error instanceof Error ? error.message : String(error)
          console.log(`  ${C.red('✗')} endpoint    ${ctx.llm.settings.baseURL} — ${message}`)
          if (/HTTP 40[13]\b/.test(message)) console.log(`              ${C.dim('the endpoint rejected the API key: check the value of BOTCONNECTOR_API_KEY (no placeholder text, quotes or spaces)')}`)
        }
        const key = process.env.BOTCONNECTOR_API_KEY
        if (key && /[<>\s]/.test(key)) {
          warnings += 1
          console.log(`  ${C.yellow('⚠')} api key     BOTCONNECTOR_API_KEY looks like placeholder text (it has spaces or < >), not a key`)
        } else if (key) {
          console.log(`  ${C.green('✓')} api key     BOTCONNECTOR_API_KEY set`)
        } else {
          warnings += 1
          console.log(`  ${C.yellow('⚠')} api key     BOTCONNECTOR_API_KEY not set (local endpoints may not need it)`)
        }
        for (const s of ctx.mcp?.status() ?? []) {
          if (s.state === 'up') {
            console.log(`  ${C.green('✓')} mcp ${s.name.padEnd(12)} up (${s.tools.length} tools)`)
          } else {
            warnings += 1
            const label = s.state === 'exhausted' ? 'exhausted' : `down (${s.lastError ?? 'unknown'})`
            console.log(`  ${C.yellow('⚠')} mcp ${s.name.padEnd(12)} ${label}`)
          }
        }
        const dataDir = ctx.sessions.dir || path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.switchboard', 'sessions')
        try {
          await fs.mkdir(dataDir, { recursive: true })
          await fs.access(dataDir, constants.W_OK)
          console.log(`  ${C.green('✓')} data dir    ${dataDir}`)
        } catch (error) {
          errors += 1
          const message = error instanceof Error ? error.message : String(error)
          console.log(`  ${C.red('✗')} data dir    ${dataDir} — ${message}`)
        }
        if (errors) {
          console.log(C.red(`${errors} error(s), ${warnings} warning(s)`))
          process.exitCode = 1
        } else {
          console.log(C.green(`all checks passed${warnings ? `, ${warnings} warning(s)` : ''}`))
        }
        break
      }
      case 'tools': {
        for (const tool of ctx.tools.list()) {
          const origin = ctx.mcp?.origin(tool.name)
          console.log(`${C.cyan(tool.name.padEnd(16))} ${tool.description}`)
          console.log(C.dim(`                 from ${origin ?? tool.plugin} · params: ${Object.keys(tool.parameters.properties ?? {}).join(', ')}`))
        }
        break
      }
      case 'models': {
        const models = await ctx.llm.listModels()
        for (const model of models) {
          const access = model.botconnector_access ? `[${model.botconnector_access}]` : ''
          const caps = model.botconnector_capabilities
            ? [
                model.botconnector_capabilities.tools ? 'tools' : null,
                model.botconnector_capabilities.reasoning ? 'reasoning' : null,
              ]
                .filter(Boolean)
                .join('+')
            : ''
          console.log(`${model.id.padEnd(38)} ${access.padEnd(8)} ${C.dim(caps)}`)
        }
        break
      }
      case 'automations': {
        await ctx.automations.ready()
        const [cmd = 'list', ...rest] = args.positional
        if (cmd === 'list') {
          const items = ctx.automations.list()
          if (!items.length) console.log(C.dim('no automations. Add one: sbx automations add "0 9 * * 1-5" "Summarize yesterday\'s changes" --name morning'))
          for (const a of items) {
            const last = a.runs[0]
            console.log(`${a.id.padEnd(18)}${a.enabled ? 'on ' : 'off'} ${a.schedule.padEnd(16)}${(a.nextRun ? new Date(a.nextRun).toISOString().slice(0, 16).replace('T', ' ') : '-').padEnd(18)}${last ? last.status : 'never run'.padEnd(9)}  ${a.name}`)
          }
          console.log(C.dim('\nthe schedule only ticks while `sbx web` or `sbx channels` is running; `sbx automations run <id>` runs one now'))
        } else if (cmd === 'add') {
          const [schedule, ...words] = rest
          const prompt = words.join(' ')
          const name = args.name ?? prompt.slice(0, 40)
          const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'automation'
          const made = await ctx.automations.create({ id, name, schedule, prompt, preset: args.preset ?? 'reviewer', deliver: args.telegram ? { type: 'telegram', chatId: args.telegram } : args.discord ? { type: 'discord', userId: args.discord } : { type: 'console' } })
          console.log(`added ${C.bold(made.id)} — next run ${made.nextRun ? new Date(made.nextRun).toISOString().slice(0, 16).replace('T', ' ') : 'never'} (UTC)`)
        } else if (cmd === 'run') {
          const record = await ctx.automations.runNow(rest[0] ?? '')
          console.log(record.status === 'success' ? record.output : C.red(`failed: ${record.error}`))
          if (record.status !== 'success') process.exitCode = 1
        } else if (cmd === 'remove') {
          await ctx.automations.remove(rest[0] ?? '')
          console.log('removed')
        } else {
          console.error(C.red('usage: sbx automations [list | add <cron> <prompt…> | run <id> | remove <id>]'))
          process.exitCode = 1
        }
        break
      }
      case 'channels': {
        const [sub, ...subArgs] = args.positional
        if (sub === 'pairing' || sub === 'approve' || sub === 'revoke') {
          const { PairingStore } = await import('./channels/pairing.js')
          const dir = path.resolve((config.settings?.dir ?? '~/.switchboard').replace(/^~(?=$|[\\/])/, os.homedir()))
          const store = new PairingStore(path.join(dir, 'pairing.json'))
          if (sub === 'approve') {
            const who = subArgs[0] ? await store.approve(subArgs[0]) : null
            console.log(who ? C.green(`approved ${who.channel} user ${who.userId}${who.label ? ` (${who.label})` : ''}`) : C.red('unknown or expired code'))
            if (!who) process.exitCode = 1
          } else if (sub === 'revoke') {
            const ok = subArgs[0] && subArgs[1] ? await store.revoke(subArgs[0], subArgs[1]) : false
            console.log(ok ? C.green('revoked') : C.red('usage: sbx channels revoke <telegram|discord> <user id> (must be an approved id)'))
            if (!ok) process.exitCode = 1
          } else {
            const { pending, approved } = await store.list()
            console.log(C.bold('pending') + (pending.length ? '' : C.dim('  (none)')))
            for (const p of pending) console.log(`  ${p.code}  ${p.channel}  ${p.userId}${p.label ? `  ${p.label}` : ''}`)
            console.log(C.bold('approved') + (approved.length ? '' : C.dim('  (none)')))
            for (const a of approved) console.log(`  ${a.channel}  ${a.userId}`)
          }
          break
        }
        const tg = config.channels?.telegram?.enabled ? config.channels.telegram : undefined
        const dc = config.channels?.discord?.enabled ? config.channels.discord : undefined
        if (!tg && !dc) {
          console.error(C.red('sbx channels: nothing enabled. Set "channels": { "telegram": { "enabled": true, "allowFrom": [<your Telegram user id>] } } and export TELEGRAM_BOT_TOKEN, or the same with "discord" (user ids as strings) and DISCORD_BOT_TOKEN (see the README).'))
          process.exitCode = 1
          break
        }
        const running = [tg && `telegram (${tg.allowFrom?.length ?? 0} allowed)`, dc && `discord (${dc.allowFrom?.length ?? 0} allowed)`].filter(Boolean).join(', ')
        console.log(C.bold('Switchboard channels') + C.dim(` — ${running} · approval ${ctx.approvals.mode}`))
        console.log(C.dim('press Ctrl+C to stop'))
        ctx.automations.start()
        await new Promise<void>((resolve) => {
          process.once('SIGINT', resolve)
          process.once('SIGTERM', resolve)
        })
        break
      }
      case 'memory': {
        const memory = ctx.memory
        const [cmd = 'list', ...rest] = args.positional
        const global = rest.includes('--global')
        const words = rest.filter((w) => w !== '--global')
        const scopes = (global ? ['global'] : ['global', 'project']) as ('global' | 'project')[]
        if (cmd === 'list') {
          for (const scope of scopes) {
            const notes = await memory.list(scope)
            console.log(C.bold(`${scope}`) + C.dim(`  ${memory.fileOf(scope)}`))
            if (!notes.length) console.log(C.dim('  (no notes)'))
            notes.forEach((note, i) => console.log(`  ${String(i + 1).padStart(2)}. ${note}`))
          }
          console.log(C.dim('\nadd: sbx memory add "text" [--global]   remove: sbx memory forget <number|text> [--global]\nthe model adds notes itself with the remember tool, and you approve each one'))
        } else if (cmd === 'add') {
          console.log(await memory.add(words.join(' '), global ? 'global' : 'project'))
        } else if (cmd === 'forget') {
          const which = words.join(' ')
          if (!which) throw new Error('usage: sbx memory forget <number|text> [--global]')
          const gone = await memory.forget(global ? 'global' : 'project', /^\d+$/.test(which) ? Number(which) : which)
          console.log(gone ? `forgot ${gone} note(s)` : 'no matching note')
        } else throw new Error(`unknown memory command "${cmd}" (list, add, forget)`)
        break
      }
      case 'skills': {
        const [cmd = 'list', ...rest] = args.positional
        const flag = (name: string): boolean => rest.includes(name)
        const value = (name: string): string | undefined => {
          const at = rest.indexOf(name)
          return at >= 0 ? rest[at + 1] : undefined
        }
        const words = rest.filter((w, i) => !w.startsWith('--') && rest[i - 1] !== '--skill')
        const yes = args.approval === 'off'
        const scope: 'project' | 'global' = flag('--global') ? 'global' : 'project'
        const skillsDir = ctx.skills.skillsDir(scope)
        const drafts = new SkillDrafts(config.skills?.draftsDir)
        const confirm = async (question: string): Promise<boolean> => {
          if (yes) return true
          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            console.log(C.yellow('this needs a yes from a person: run it in a terminal, or add --yes after reading the skill'))
            return false
          }
          const readline = await import('node:readline/promises')
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
          const answer = await rl.question(question)
          rl.close()
          return /^y(es)?$/i.test(answer.trim())
        }
        const show = (c: { name: string; description: string; body: string; files: { path: string; bytes: number }[]; warnings: string[] }): void => {
          console.log(`${C.bold(c.name)}  ${c.description}`)
          if (c.files.length) console.log(C.dim(`files: ${c.files.slice(0, 12).map((f) => `${f.path} (${f.bytes} B)`).join(', ')}${c.files.length > 12 ? `, … ${c.files.length - 12} more` : ''}`))
          for (const w of c.warnings) console.log(C.yellow(`! ${w}`))
          const lines = c.body.split('\n')
          console.log(C.dim('--- SKILL.md ---'))
          console.log(lines.slice(0, 80).join('\n') + (lines.length > 80 ? C.dim(`\n… ${lines.length - 80} more line(s)`) : ''))
          console.log(C.dim('--- end ---'))
          console.log(C.yellow('A skill is instructions the model will follow. Install only what you have read and trust.'))
        }
        if (cmd === 'list') {
          const skills = await ctx.skills.list()
          if (!skills.length) {
            console.log(C.dim('no skills found — add <workspace>/.switchboard/skills/<name>/SKILL.md or ~/.switchboard/skills/<name>/SKILL.md, or: sbx skills install <folder|https://git-url>'))
          }
          for (const skill of skills) console.log(`${skill.name.padEnd(24)}${C.dim(skill.source.padEnd(9))}${skill.description}`)
          const waiting = await drafts.list()
          if (skills.length) console.log(C.dim('\nrun one with: /<name> <task>   ·   the model loads them with load_skill'))
          if (waiting.length) console.log(C.yellow(`${waiting.length} skill draft(s) proposed by the model are waiting: sbx skills drafts`))
        } else if (cmd === 'drafts') {
          const waiting = await drafts.list()
          if (!waiting.length) console.log(C.dim('no drafts. The model can propose one with propose_skill; nothing is active until you accept it.'))
          for (const d of waiting) console.log(`${d.name.padEnd(24)}${new Date(d.proposedAt).toISOString().slice(0, 16).replace('T', ' ')}  ${d.description}`)
          if (words[0]) {
            const d = await drafts.get(words[0])
            if (!d) throw new Error(`no draft "${words[0]}"`)
            console.log('')
            show({ name: d.name, description: d.description, body: d.body, files: [], warnings: [] })
          } else if (waiting.length) console.log(C.dim('\nread one: sbx skills drafts <name>   accept: sbx skills accept <name> [--global]   discard: sbx skills reject <name>'))
        } else if (cmd === 'accept') {
          const d = words[0] ? await drafts.get(words[0]) : undefined
          if (!d) throw new Error('usage: sbx skills accept <draft-name> [--global] [--force]  (list them with: sbx skills drafts)')
          show({ name: d.name, description: d.description, body: d.body, files: [], warnings: [] })
          if (!(await confirm(`\nActivate "${d.name}" as a ${scope} skill? [y/N] `))) break
          console.log(`installed ${await drafts.accept(d.name, skillsDir, flag('--force'))}`)
        } else if (cmd === 'reject') {
          if (!words[0]) throw new Error('usage: sbx skills reject <draft-name>')
          console.log((await drafts.reject(words[0])) ? `discarded draft ${words[0]}` : `no draft "${words[0]}"`)
        } else if (cmd === 'install') {
          if (!words[0]) throw new Error('usage: sbx skills install <folder | https://git-url> [--skill <name>] [--global] [--force]')
          const staged = await stageSource(words[0])
          try {
            for (const bad of staged.invalid) console.log(C.dim(`skipped ${bad.folder}: ${bad.error}`))
            if (!staged.candidates.length) throw new Error('no installable skill found (a skill is a folder with a SKILL.md that has name and description)')
            const wanted = value('--skill')
            let pick = wanted ? staged.candidates.find((c) => c.name === wanted) : staged.candidates.length === 1 ? staged.candidates[0] : undefined
            if (!pick) {
              console.log(wanted ? C.red(`no skill "${wanted}" in this source.`) : `${staged.candidates.length} skills found:`)
              for (const c of staged.candidates) console.log(`  ${c.name.padEnd(24)}${C.dim(c.description)}`)
              if (!wanted) console.log(C.dim('\nchoose one: sbx skills install <source> --skill <name>'))
              break
            }
            show(pick)
            if (staged.commit) console.log(C.dim(`source ${words[0]} @ ${staged.commit.slice(0, 12)}`))
            if (!(await confirm(`\nInstall "${pick.name}" as a ${scope} skill? [y/N] `))) break
            console.log(`installed ${await installCandidate(pick, skillsDir, { source: words[0], commit: staged.commit }, flag('--force'))}`)
          } finally {
            await staged.cleanup()
          }
        } else if (cmd === 'remove') {
          if (!words[0]) throw new Error('usage: sbx skills remove <name> [--global]')
          if (!(await confirm(`Delete the ${scope} skill "${words[0]}"? [y/N] `))) break
          console.log((await removeSkill(skillsDir, words[0])) ? `removed ${words[0]}` : `no ${scope} skill "${words[0]}"`)
        } else throw new Error(`unknown skills command "${cmd}" (list, drafts, accept, reject, install, remove)`)
        break
      }
      case 'presets': {
        console.log(C.bold('id'.padEnd(16)) + 'steps  tools                         name')
        for (const preset of ctx.presets.list()) {
          const tools = preset.tools?.allow ? `only ${preset.tools.allow.length}` : preset.tools?.deny ? `minus ${preset.tools.deny.length}` : 'all'
          console.log(`${preset.id.padEnd(16)}${String(preset.maxSteps ?? '-').padEnd(7)}${tools.padEnd(29)}${preset.name}${preset.builtin ? C.dim(' (built-in)') : ''}`)
        }
        console.log(C.dim(`\nuse one with: sbx chat --preset <id>   ·   custom presets live in ${ctx.presets.dir}/presets.json (or the console API)`))
        break
      }
      case 'sessions': {
        const sessions = ctx.sessions.list()
        if (!sessions.length) {
          console.log(C.dim('no stored sessions'))
          break
        }
        console.log(C.bold('id'.padEnd(24)) + 'updated'.padEnd(20) + 'msgs  title')
        for (const s of sessions.slice(0, 50)) {
          const when = new Date(s.updatedAt).toISOString().replace('T', ' ').slice(0, 16)
          console.log(`${s.id.padEnd(24)}${when.padEnd(20)}${String(s.messages.length).padEnd(6)}${s.title}`)
        }
        if (ctx.sessions.dir) console.log(C.dim(`\nstored in ${ctx.sessions.dir}`))
        break
      }
      case 'metrics': {
        const summary = ctx.metrics.summary()
        const rows = Object.entries(summary)
        if (!rows.length) {
          console.log(C.dim('no samples yet'))
          break
        }
        console.log(C.bold('model'.padEnd(30)) + 'calls  ttft p50  ttft p95   tok/s p50')
        for (const [model, s] of rows) {
          console.log(
            `${model.padEnd(30)}${String(s.calls).padEnd(7)}${String(s.ttftP50 + 'ms').padEnd(11)}${String(s.ttftP95 + 'ms').padEnd(12)}${s.tpsP50}`,
          )
        }
        break
      }
      case 'web': {
        const { url, accessUrl } = await ctx.web.ready()
        const tools = ctx.tools.list().length
        const guarded = accessUrl !== url
        console.log(C.bold('Switchboard console') + C.dim(` — ${guarded ? accessUrl : url}`))
        console.log(C.dim(`${ctx.llm.settings.defaultModel} · ${tools} tools · ${guarded ? 'access token required (open the URL above once; it sets a cookie)' : 'loopback only, no auth'}`))
        if (ctx.browserCompanion?.pairingCode) {
          console.log(C.dim('Browser Companion pairing code (valid 15 minutes, one use): ') + C.bold(ctx.browserCompanion.pairingCode))
        }
        console.log(C.dim('press Ctrl+C to stop'))
        if (args.open && process.platform === 'win32') {
          // Detached so a browser that outlives the shell does not hold the process.
          spawn('cmd', ['/c', 'start', '', accessUrl], { detached: true, stdio: 'ignore' }).unref()
        }
        // Keep the process alive until interrupted; the HTTP server holds the loop.
        await new Promise<void>((resolve) => {
          process.once('SIGINT', resolve)
          process.once('SIGTERM', resolve)
        })
        break
      }
      case 'run': {
        const prompt = args.positional.join(' ').trim()
        if (!prompt) {
          console.error(C.red('sbx run: prompt is required'))
          process.exitCode = 1
          break
        }
        const session = startSession(prompt.slice(0, 60))
        const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
        const rlRun: { rl?: import('node:readline/promises').Interface } = {}
        attachCliApprover(
          ctx,
          interactive
            ? async (question) => {
                const readline = await import('node:readline/promises')
                rlRun.rl ??= readline.createInterface({ input: process.stdin, output: process.stdout })
                return rlRun.rl.question(question).catch(() => null)
              }
            : null,
        )
        if (args.json) {
          if (!(await renderRunJson(ctx.agent.stream(prompt, session.id, presetOptions), session.id))) process.exitCode = 1
          rlRun.rl?.close()
          break
        }
        const outcome = await renderRun(ctx.agent.stream(prompt, session.id, presetOptions), 'thinking › ')
        if (!outcome.ok) process.exitCode = 1
        process.stdout.write('\n')
        rlRun.rl?.close()
        break
      }
      case 'chat':
      default: {
        const readline = await import('node:readline/promises')
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        let session = startSession('interactive')
        let closed = false
        rl.on('close', () => {
          closed = true
        })
        /** Reads a line; returns null when stdin ends (piped input, Ctrl+D). */
        const ask = async (prompt: string): Promise<string | null> => {
          if (closed) return null
          try {
            return await rl.question(prompt)
          } catch {
            closed = true
            return null
          }
        }

        attachCliApprover(ctx, process.stdin.isTTY && process.stdout.isTTY ? (question) => rl.question(question).catch(() => null) : null)

        const seed = args.positional.join(' ').trim()
        let prompt: string | null = seed
        if (ctx.browserCompanion?.pairingCode) {
          console.log(C.dim('Browser Companion pairing code (valid 15 minutes, one use): ') + C.bold(ctx.browserCompanion.pairingCode))
        }
        console.log(C.bold('Switchboard') + C.dim(` — ${ctx.llm.settings.defaultModel} · session ${session.id}${session.resumed ? ' (resumed)' : ''}`))
        console.log(C.dim('type /exit to quit, /new for a new session, /sessions to list, /compact to summarize history, /usage for tokens and cost, /changes and /undo [n|force] for file edits, /metrics for latency'))
        if (!prompt) prompt = await ask(C.cyan('you › '))

        while (prompt && prompt.trim()) {
          const text = prompt.trim()
          if (text === '/exit' || text === '/quit') break
          if (text === '/metrics') {
            for (const [model, s] of Object.entries(ctx.metrics.summary())) {
              console.log(`${model.padEnd(30)} calls=${s.calls} ttft p50=${s.ttftP50}ms p95=${s.ttftP95}ms tok/s p50=${s.tpsP50}`)
            }
            prompt = await ask(C.cyan('you › '))
            continue
          }
          if (text === '/usage') {
            const usage = ctx.get('usage', false)
            if (usage) {
              await usage.refresh()
              console.log(C.dim(formatUsage(usage.summary(session.id))))
            }
            prompt = await ask(C.cyan('you › '))
            continue
          }
          if (text === '/changes') {
            const changes = await ctx.undo.list(session.id)
            console.log(changes.length ? changes.map((c) => C.dim(`#${c.seq} ${new Date(c.at).toISOString().slice(11, 19)} `) + `${c.created ? 'created ' : 'changed '}${c.file}`).join('\n') : C.dim('no file changes recorded in this session'))
            prompt = await ask(C.cyan('you › '))
            continue
          }
          if (text === '/undo' || text.startsWith('/undo ')) {
            const args = text.slice('/undo'.length).trim().split(/\s+/).filter(Boolean)
            const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 1)
            console.log(C.dim(formatUndo(await ctx.undo.undo(session.id, count, args.includes('force')))))
            prompt = await ask(C.cyan('you › '))
            continue
          }
          if (text === '/compact' || text.startsWith('/compact ')) {
            const outcome = await ctx.compaction.compact(session.id, { focus: text.slice('/compact'.length).trim() || undefined })
            console.log(outcome.ok ? C.dim(`compacted ${outcome.summarized} message(s): ~${outcome.before} → ~${outcome.after} tokens`) : C.yellow(`not compacted: ${outcome.reason}`))
            prompt = await ask(C.cyan('you › '))
            continue
          }
          if (text === '/new') {
            const fresh = ctx.sessions.create({ title: 'interactive' })
            session = { id: fresh.id, resumed: false }
            console.log(C.dim(`new session ${fresh.id}`))
            prompt = await ask(C.cyan('you › '))
            continue
          }
          if (text === '/sessions') {
            for (const s of ctx.sessions.list().slice(0, 10)) {
              const when = new Date(s.updatedAt).toISOString().replace('T', ' ').slice(0, 16)
              console.log(C.dim(`${s.id}  ${when}  ${s.messages.length} msgs  `) + s.title)
            }
            console.log(C.dim(`\nresume with: sbx chat -r <id>`))
            prompt = await ask(C.cyan('you › '))
            continue
          }

          process.stdout.write(C.green('sbx › '))
          const outcome = await renderRun(ctx.agent.stream(text, session.id, presetOptions), '  thinking › ')
          if (outcome.ok) process.stdout.write('\n\n')
          prompt = await ask(C.cyan('you › '))
        }

        rl.close()
        break
      }
    }
  } finally {
    await ctx.sessions.flush()
    await host.dispose()
  }
}

/** True when this file is the process entry (`node dist/cli.js`), not an import. */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    console.error(C.red(`sbx: ${error instanceof Error ? error.message : String(error)}`))
    process.exit(1)
  })
}
