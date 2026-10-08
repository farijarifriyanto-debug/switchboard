import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Context } from 'cordis'
import type { ToolSpec } from '../services/tools.js'
import { expandHome } from '../services/session.js'
import { confine } from '../services/confine.js'

export interface FilesystemConfig {
  /** Directory tools are allowed to touch. Defaults to the process cwd. */
  root?: string
  /** Max bytes returned by `read_file`. */
  maxBytes?: number
}

/** `tools-fs` — filesystem tools (read, write, list, search). */
export const toolsFs = {
  name: 'tools-fs',
  inject: ['tools'],

  apply(ctx: Context, config: FilesystemConfig = {}) {
    let root = path.resolve(expandHome(config.root ?? process.cwd()))
    const maxBytes = config.maxBytes ?? 64_000
    ctx.on('workspace/changed', (next) => {
      root = next
    })
    // Boundary guard against the *live* root (symlinks included); re-checked on
    // every call so a workspace switch takes effect immediately.
    const boundary = (target: string): Promise<string> => confine(root, expandHome(target))

    const defs: ToolSpec[] = [
      {
        name: 'read_file',
        description: 'Read a text file from the workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to the workspace root.' },
          },
          required: ['path'],
        },
        async execute(args: { path: string }) {
          const file = await boundary(args.path)
          const buf = await fs.readFile(file)
          const text = buf.subarray(0, maxBytes).toString('utf8')
          return buf.length > maxBytes ? `${text}\n...[truncated ${buf.length - maxBytes} bytes]` : text
        },
      },
      {
        name: 'write_file',
        description: 'Create or overwrite a text file in the workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
        async execute(args: { path: string; content: string }) {
          const file = await boundary(args.path)
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, args.content, 'utf8')
          return `Wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}`
        },
      },
      {
        name: 'list_dir',
        description:
          'List entries of a directory in the workspace. Prefer this over shell ls/dir to explore a repository.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Defaults to "."' } },
        },
        async execute(args: { path?: string }) {
          const dir = await boundary(args.path ?? '.')
          const entries = await fs.readdir(dir, { withFileTypes: true })
          return entries
            .map((e) => `${e.isDirectory() ? 'dir ' : 'file'}  ${e.name}`)
            .sort()
            .join('\n')
        },
      },
      {
        name: 'search_files',
        description:
          'Search file contents by regular expression inside the workspace. Use this instead of shell grep/find to locate code across a repository.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'JavaScript regular expression.' },
            path: { type: 'string', description: 'Directory to search, defaults to "."' },
            maxResults: { type: 'number', description: 'Defaults to 50.' },
          },
          required: ['pattern'],
        },
        async execute(args: { pattern: string; path?: string; maxResults?: number }) {
          const dir = await boundary(args.path ?? '.')
          const re = new RegExp(args.pattern)
          const limit = args.maxResults ?? 50
          const hits: string[] = []

          const walk = async (current: string): Promise<void> => {
            if (hits.length >= limit) return
            for (const entry of await fs.readdir(current, { withFileTypes: true })) {
              if (hits.length >= limit) return
              if (entry.name === 'node_modules' || entry.name === '.git') continue
              const full = path.join(current, entry.name)
              if (entry.isDirectory()) {
                await walk(full)
              } else {
                // a link inside the workspace may point outside it: skip, never read through it
                if (await boundary(full).then(() => false, () => true)) continue
                const text = await fs.readFile(full, 'utf8').catch(() => '')
                text.split(/\r?\n/).forEach((line, i) => {
                  if (hits.length < limit && re.test(line)) {
                    hits.push(`${path.relative(root, full)}:${i + 1}: ${line.trim().slice(0, 200)}`)
                  }
                })
              }
            }
          }

          await walk(dir)
          return hits.length ? hits.join('\n') : 'no matches'
        },
      },
    ]

    for (const def of defs) ctx.effect(() => ctx.tools.register(def))
  },
}
