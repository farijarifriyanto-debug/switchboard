import { spawn } from 'node:child_process'
import path from 'node:path'
import type { Context } from 'cordis'
import type { ToolSpec } from '../services/tools.js'
import { expandHome } from '../services/session.js'
import { killTree, trackTree } from '../services/proc.js'
import { buildSandboxCommand, describeSandbox, killContainer, sandboxProblem, type SandboxConfig } from '../services/sandbox.js'
import { randomBytes } from 'node:crypto'

export interface ShellConfig {
  /** Working directory for commands. Defaults to the process cwd. */
  cwd?: string
  /** Hard timeout per command, in ms. */
  timeoutMs?: number
  /** Set true to disable this plugin's tools. */
  disabled?: boolean
  /** Run commands in an OS sandbox (bubblewrap or docker). Off by default; see the README. */
  sandbox?: SandboxConfig
}

/** `tools-shell` — runs a shell command and returns stdout/stderr. */
export const toolsShell = {
  name: 'tools-shell',
  inject: ['tools'],

  apply(ctx: Context, config: ShellConfig = {}) {
    if (config.disabled) return

    let cwd = path.resolve(expandHome(config.cwd ?? process.cwd()))
    const timeoutMs = config.timeoutMs ?? 30_000
    const sandbox = config.sandbox?.mode && config.sandbox.mode !== 'off' ? config.sandbox : undefined
    const sandboxNote = sandbox ? ` ${describeSandbox(sandbox)}` : ''
    ctx.on('workspace/changed', (next) => {
      cwd = next
    })

    const def: ToolSpec = {
      name: 'run_command',
      description:
        'Run a shell command in the workspace and return its combined output. The shell is PowerShell on Windows (ls, dir, cat and similar work) and POSIX sh (not bash) elsewhere, so avoid bash-only syntax. If a command returns no output, double-check the path with list_dir — a wrong path can come back empty.' + sandboxNote,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line to execute.' },
        },
        required: ['command'],
      },
      execute(args: { command: string }, toolCtx: { signal?: AbortSignal }) {
        return new Promise<string>((resolve) => {
          if (sandbox) {
            const problem = sandboxProblem(sandbox)
            if (problem) return resolve(`Error: the ${sandbox.mode} sandbox is unavailable, so the command was NOT run: ${problem}`)
          }
          const isWin = process.platform === 'win32'
          // Windows: PowerShell instead of cmd.exe, so common Unix-style
          // commands (ls, cat, ...) keep working through its aliases.
          const wrapped = sandbox
            ? buildSandboxCommand(sandbox, { workspace: cwd, command: args.command, name: randomBytes(6).toString('hex'), uid: process.getuid?.(), gid: process.getgid?.() })
            : undefined
          const [file, argv] = wrapped
            ? [wrapped.file, wrapped.args]
            : isWin
            ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${args.command}`]]
            : ['/bin/sh', ['-c', args.command]]
          // spawn (not exec/execFile): only spawn honors `detached`, which makes the
          // command lead its own process group so killTree reaches grandchildren.
          const child = spawn(file, argv, { cwd, windowsHide: true, detached: !isWin })
          const stop = (grace?: number): void => {
            killTree(child, grace)
            if (wrapped?.container) killContainer(wrapped.container)
          }
          trackTree(child)
          const MAX = 1_000_000
          let stdout = ''
          let stderr = ''
          let overflow = false
          const take = (which: 'out' | 'err') => (chunk: Buffer) => {
            if (stdout.length + stderr.length >= MAX) {
              if (!overflow) {
                overflow = true
                stop()
              }
              return
            }
            if (which === 'out') stdout += chunk.toString('utf8')
            else stderr += chunk.toString('utf8')
          }
          child.stdout?.on('data', take('out'))
          child.stderr?.on('data', take('err'))
          let timedOut = false
          const timer = setTimeout(() => {
            timedOut = true
            stop()
          }, timeoutMs)
          // Stop must kill the tool, not just the model stream.
          toolCtx?.signal?.addEventListener('abort', () => stop(500), { once: true })
          const finish = (code: number | null, error?: Error) => {
            clearTimeout(timer)
            if (toolCtx?.signal?.aborted) return resolve('Error: command cancelled before completion.')
            const out = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
            const notes = [
              overflow ? '(output exceeded 1 MB; command stopped)' : '',
              timedOut ? `(timed out after ${Math.round(timeoutMs / 1000)}s)` : '',
            ].filter(Boolean)
            if (error || code !== 0 || timedOut || overflow) {
              resolve([`exit ${code ?? 1}`, out || error?.message || '', ...notes].filter((x) => x !== '').join('\n'))
            } else resolve(out || '(no output)')
          }
          child.on('error', (error) => finish(1, error))
          child.on('close', (code) => finish(code))
        })
      },
    }

    ctx.effect(() => ctx.tools.register(def))
  },
}