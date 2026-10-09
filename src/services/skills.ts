import { Service } from 'cordis'
import type { Context } from 'cordis'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import type { ToolSpec } from './tools.js'
import { confine } from './confine.js'

export interface SkillsConfig {
  /** Set false to turn skills off entirely (no scan, no tool, no prompt section). */
  enabled?: boolean
  /** Global skills directory. Default `~/.switchboard/skills`. */
  globalDir?: string
  /** Project skills directory, relative to the workspace. Default `.switchboard/skills`. */
  projectDir?: string
  /** Where model-proposed skills wait for review. Default `~/.switchboard/skill-drafts`. */
  draftsDir?: string
}

export interface Skill {
  /** Slug used by `load_skill` and `/name`. */
  name: string
  description: string
  source: 'project' | 'global'
  /** Absolute path of the skill folder. */
  dir: string
  /** Markdown after the frontmatter. */
  body: string
  /** Other files shipped with the skill (relative paths, max 40). */
  files: string[]
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_BODY = 32_000
const MAX_FILE = 64_000
const MAX_INDEX = 40
export const SKILLS_HEADING = '## Skills'

/** Splits `---\nyaml\n---\nbody`. Returns null when there is no frontmatter block. */
export function parseSkillFile(text: string): { meta: Record<string, unknown>; body: string } | null {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text)
  if (!match) return null
  let meta: unknown
  try {
    meta = YAML.parse(match[1])
  } catch {
    return null
  }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  return { meta: meta as Record<string, unknown>, body: (match[2] ?? '').trim() }
}

async function listFiles(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  if (out.length >= 40) return out
  for (const entry of (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= 40) break
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await listFiles(full, base, out)
    else if (entry.isFile() && entry.name !== 'SKILL.md') out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

/**
 * `ctx.skills` — SKILL.md discovery (roadmap stage 3).
 *
 * A skill is a folder with a `SKILL.md` (YAML frontmatter `name`, `description`;
 * markdown body). Only name + description are advertised in the system prompt;
 * the model loads the full text on demand with `load_skill`, or the user runs it
 * with `/name <task>`. Project skills override global ones of the same name.
 *
 * Skills are instructions from the files on disk: treat a skill from a project
 * you did not write like any other text in that project.
 */
export class SkillService extends Service {
  static inject: string[] = []

  readonly enabled: boolean
  private readonly globalDir: string
  private readonly projectDir: string
  private cache?: { key: string; at: number; skills: Skill[] }

  constructor(ctx: Context, config: SkillsConfig = {}) {
    super(ctx, 'skills')
    this.enabled = config.enabled !== false
    this.globalDir = path.resolve((config.globalDir ?? path.join(os.homedir(), '.switchboard', 'skills')).replace(/^~(?=$|[\\/])/, os.homedir()))
    this.projectDir = config.projectDir ?? '.switchboard/skills'
  }

  /** Where skills of one source live (the folder `skills install` and `accept` write to). */
  skillsDir(source: Skill['source']): string {
    return source === 'global' ? this.globalDir : path.resolve(this.root(), this.projectDir)
  }

  private root(): string {
    return this.ctx.get('workspace', false)?.root ?? process.cwd()
  }

  private async scanDir(dir: string, source: Skill['source'], warn: string[]): Promise<Skill[]> {
    const found: Skill[] = []
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      const folder = path.join(dir, entry.name)
      const text = await fs.readFile(path.join(folder, 'SKILL.md'), 'utf8').catch(() => null)
      if (text === null) continue
      const parsed = parseSkillFile(text)
      if (!parsed) {
        warn.push(`${entry.name}: SKILL.md needs a --- frontmatter block`)
        continue
      }
      const name = typeof parsed.meta.name === 'string' && parsed.meta.name.trim() ? parsed.meta.name.trim() : entry.name
      const description = typeof parsed.meta.description === 'string' ? parsed.meta.description.replace(/\s+/g, ' ').trim() : ''
      if (!SKILL_NAME_RE.test(name)) {
        warn.push(`${entry.name}: name "${name}" must be lowercase letters, digits or "-" (max 64)`)
        continue
      }
      if (!description) {
        warn.push(`${entry.name}: description is required`)
        continue
      }
      found.push({
        name,
        description: description.slice(0, 1024),
        source,
        dir: folder,
        body: parsed.body.length > MAX_BODY ? `${parsed.body.slice(0, MAX_BODY)}\n…[skill truncated]` : parsed.body,
        files: await listFiles(folder),
      })
    }
    return found
  }

  /** All skills visible from the current workspace (project wins over global). Cached for 5 s. */
  async list(): Promise<Skill[]> {
    if (!this.enabled) return []
    const projectRoot = path.resolve(this.root(), this.projectDir)
    const key = `${projectRoot}|${this.globalDir}`
    if (this.cache && this.cache.key === key && Date.now() - this.cache.at < 5_000) return this.cache.skills
    const warn: string[] = []
    const byName = new Map<string, Skill>()
    for (const skill of await this.scanDir(this.globalDir, 'global', warn)) byName.set(skill.name, skill)
    for (const skill of await this.scanDir(projectRoot, 'project', warn)) byName.set(skill.name, skill)
    for (const message of warn) this.ctx.logger('skills').warn('%s', message)
    const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    this.cache = { key, at: Date.now(), skills }
    return skills
  }

  async get(name: string): Promise<Skill | undefined> {
    return (await this.list()).find((s) => s.name === name)
  }

  /** The system-prompt section: one line per skill, never the bodies. */
  async index(): Promise<string> {
    const skills = (await this.list()).slice(0, MAX_INDEX)
    if (!skills.length) return ''
    const lines = skills.map((s) => `- ${s.name}: ${s.description.length > 240 ? `${s.description.slice(0, 240)}…` : s.description}`)
    return `${SKILLS_HEADING}\nSpecialised instructions are available as skills. When a task matches one, call load_skill with its name before starting, then follow it.\n${lines.join('\n')}`
  }

  /** Reads one file shipped with a skill; confined to the skill folder (links included). */
  async readFile(skill: Skill, file: string): Promise<string> {
    const target = await confine(skill.dir, file)
    const buf = await fs.readFile(target)
    const text = buf.subarray(0, MAX_FILE).toString('utf8')
    return buf.length > MAX_FILE ? `${text}\n…[truncated ${buf.length - MAX_FILE} bytes]` : text
  }

  /**
   * `/name task…` -> the prompt the model should see, or null when the text is
   * not a skill invocation. The skill body travels with the message so the
   * invocation does not depend on the model deciding to load it.
   */
  async expand(prompt: string): Promise<string | null> {
    const match = /^\/([a-z0-9][a-z0-9-]{0,63})(?:\s+([\s\S]*))?$/.exec(prompt.trim())
    if (!match) return null
    const skill = await this.get(match[1])
    if (!skill) return null
    const task = (match[2] ?? '').trim()
    return `${prompt.trim().split('\n')[0]}\n\n[Skill "${skill.name}" — follow these instructions]\n${skill.body}\n[end of skill]${task ? `\n\nTask: ${task}` : ''}`
  }
}

/** Replaces (or removes) the skills section of a system prompt; idempotent. */
export function withSkills(base: string, section: string): string {
  const marker = `\n${SKILLS_HEADING}\n`
  const idx = base.startsWith(`${SKILLS_HEADING}\n`) ? 0 : base.indexOf(marker)
  const head = idx === -1 ? base : base.slice(0, idx).replace(/\s+$/, '')
  return section.trim() ? `${head}\n\n${section.trim()}` : head
}

/** `skills-tool` — registers `load_skill`. */
export const toolsSkills = {
  name: 'skills-tool',
  inject: ['tools', 'skills'],

  apply(ctx: Context) {
    if (!ctx.skills.enabled) return
    const def: ToolSpec = {
      name: 'load_skill',
      description:
        'Load a skill (specialised instructions) by name, listed under "Skills" in the system prompt. Pass `file` to read a file that ships with the skill.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name.' },
          file: { type: 'string', description: 'Optional path of a file inside the skill folder, as listed by the skill.' },
        },
        required: ['name'],
      },
      async execute(args: { name: string; file?: string }) {
        const skill = await ctx.skills.get(String(args.name ?? '').trim())
        if (!skill) {
          const names = (await ctx.skills.list()).map((s) => s.name)
          return `Error: no skill "${args.name}". Available: ${names.join(', ') || 'none'}`
        }
        if (args.file) return ctx.skills.readFile(skill, String(args.file))
        const files = skill.files.length ? `\n\nFiles in this skill (read with load_skill {name, file}):\n${skill.files.map((f) => `- ${f}`).join('\n')}` : ''
        return `# Skill: ${skill.name} (${skill.source})\n\n${skill.body}${files}`
      },
    }
    ctx.effect(() => ctx.tools.register(def))
  },
}

declare module 'cordis' {
  interface Context {
    skills: SkillService
  }
}
