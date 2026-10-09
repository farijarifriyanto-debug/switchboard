import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import type { Context } from 'cordis'
import type { ToolSpec } from './tools.js'
import { parseSkillFile, SKILL_NAME_RE } from './skills.js'

/** Limits for anything that did not come from the user's own editor. */
export const MAX_DRAFTS = 10
export const MAX_DRAFT_BODY = 8_000
const MAX_FILES = 100
const MAX_FILE_BYTES = 200_000
const MAX_TOTAL_BYTES = 2_000_000
const MAX_SEARCH_DEPTH = 2
const ORIGIN_FILE = '.switchboard-origin.json'

export interface SkillPreview {
  name: string
  description: string
  body: string
  /** Files other than SKILL.md, with sizes. */
  files: { path: string; bytes: number }[]
  /** Things the reader should look at before saying yes. */
  warnings: string[]
}

export interface Candidate extends SkillPreview {
  /** Folder holding SKILL.md. */
  dir: string
  /** Folder name on disk (the skill is installed under `name`). */
  folder: string
}

const sh = /\.(sh|bash|zsh|ps1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php)$/i

/** Reads a skill folder the way SkillService would, plus the warnings a human should see. */
export async function previewSkillDir(dir: string): Promise<Candidate | { error: string; folder: string }> {
  const folder = path.basename(dir)
  const text = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => null)
  if (text === null) return { error: 'no SKILL.md', folder }
  const parsed = parseSkillFile(text)
  if (!parsed) return { error: 'SKILL.md needs a --- frontmatter block', folder }
  const name = typeof parsed.meta.name === 'string' && parsed.meta.name.trim() ? parsed.meta.name.trim() : folder
  const description = typeof parsed.meta.description === 'string' ? parsed.meta.description.replace(/\s+/g, ' ').trim() : ''
  if (!SKILL_NAME_RE.test(name)) return { error: `name "${name}" must be lowercase letters, digits or "-" (max 64)`, folder }
  if (!description) return { error: 'description is required', folder }
  const files: { path: string; bytes: number }[] = []
  const warnings: string[] = []
  const walk = async (current: string): Promise<void> => {
    for (const entry of (await fs.readdir(current, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        warnings.push(`symbolic link ${path.relative(dir, full)} will be skipped`)
        continue
      }
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && !(current === dir && entry.name === 'SKILL.md')) {
        const stat = await fs.stat(full)
        files.push({ path: path.relative(dir, full).split(path.sep).join('/'), bytes: stat.size })
      }
    }
  }
  await walk(dir)
  if (files.length > MAX_FILES) warnings.push(`${files.length} files (max ${MAX_FILES})`)
  if (files.reduce((n, f) => n + f.bytes, 0) > MAX_TOTAL_BYTES) warnings.push(`more than ${MAX_TOTAL_BYTES / 1_000_000} MB in total`)
  for (const f of files) if (f.bytes > MAX_FILE_BYTES) warnings.push(`${f.path} is larger than ${MAX_FILE_BYTES / 1000} KB`)
  const scripts = files.filter((f) => sh.test(f.path) || f.path.startsWith('scripts/'))
  if (scripts.length) warnings.push(`ships scripts the model could be told to run: ${scripts.slice(0, 6).map((f) => f.path).join(', ')}${scripts.length > 6 ? ', …' : ''} (running one still needs your approval)`)
  if (parsed.meta['allowed-tools'] !== undefined) warnings.push('declares allowed-tools: ignored here, tool permissions come from your approval mode')
  if (name !== folder) warnings.push(`folder "${folder}" will be installed as "${name}"`)
  return { dir, folder, name, description: description.slice(0, 1024), body: parsed.body, files, warnings }
}

/** Finds skill folders in a checkout: the root itself, then up to two levels down (`skills/<name>`). */
export async function findSkillDirs(root: string, depth = 0): Promise<string[]> {
  if (await fs.stat(path.join(root, 'SKILL.md')).then((s) => s.isFile(), () => false)) return [root]
  if (depth >= MAX_SEARCH_DEPTH) return []
  const out: string[] = []
  for (const entry of (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
    out.push(...(await findSkillDirs(path.join(root, entry.name), depth + 1)))
    if (out.length >= 200) break
  }
  return out
}

function git(args: string[], cwd: string, timeoutMs = 90_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1' }, windowsHide: true })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d: Buffer) => (output += d.toString()))
    child.stderr.on('data', (d: Buffer) => (output += d.toString()))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, output: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output: output.trim().slice(-400) })
    })
  })
}

export interface Staged {
  /** Where the files are (a temp dir for URLs, the given folder for local paths). */
  root: string
  /** Commit of a cloned source, or '' for a local folder. */
  commit: string
  candidates: Candidate[]
  invalid: { folder: string; error: string }[]
  /** Removes a temp checkout. */
  cleanup(): Promise<void>
}

/** Fetches (https git URL) or opens (local folder) a skill source without installing anything. */
export async function stageSource(source: string): Promise<Staged> {
  let root: string
  let commit = ''
  let temp: string | undefined
  if (/^https:\/\/[^\s]+$/.test(source)) {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sbx-skill-'))
    root = path.join(temp, 'src')
    // https only, no hooks, nothing from the clone is ever executed by us
    const cloned = await git(['-c', 'core.hooksPath=/dev/null', '-c', 'core.symlinks=false', 'clone', '--depth', '1', '--no-tags', '--quiet', source, root], temp)
    if (!cloned.ok) {
      await fs.rm(temp, { recursive: true, force: true })
      throw new Error(`could not fetch ${source}: ${cloned.output || 'git failed'}`)
    }
    commit = (await git(['rev-parse', 'HEAD'], root)).output
  } else {
    root = path.resolve(source.replace(/^~(?=$|[\\/])/, os.homedir()))
    if (!(await fs.stat(root).then((s) => s.isDirectory(), () => false))) throw new Error(`"${source}" is neither a folder nor an https:// git URL`)
  }
  const candidates: Candidate[] = []
  const invalid: { folder: string; error: string }[] = []
  for (const dir of await findSkillDirs(root)) {
    const preview = await previewSkillDir(dir)
    if ('error' in preview) invalid.push({ folder: preview.folder, error: preview.error })
    else candidates.push(preview)
  }
  return {
    root,
    commit,
    candidates,
    invalid,
    cleanup: async () => {
      if (temp) await fs.rm(temp, { recursive: true, force: true })
    },
  }
}

/** Copies regular files only (no links, no .git), within the size limits. */
async function copyTree(from: string, to: string, budget = { files: 0, bytes: 0 }): Promise<void> {
  await fs.mkdir(to, { recursive: true })
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.isSymbolicLink()) continue
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) await copyTree(src, dst, budget)
    else if (entry.isFile()) {
      const { size } = await fs.stat(src)
      if (size > MAX_FILE_BYTES) throw new Error(`${entry.name} is larger than ${MAX_FILE_BYTES / 1000} KB`)
      budget.files += 1
      budget.bytes += size
      if (budget.files > MAX_FILES || budget.bytes > MAX_TOTAL_BYTES) throw new Error('the skill is too large to install')
      await fs.copyFile(src, dst)
    }
  }
}

/** Installs one previewed candidate under `<skillsDir>/<name>`; never overwrites unless `force`. */
export async function installCandidate(candidate: Candidate, skillsDir: string, origin: { source: string; commit: string }, force = false): Promise<string> {
  const target = path.join(skillsDir, candidate.name)
  if (await fs.stat(target).then(() => true, () => false)) {
    if (!force) throw new Error(`${target} already exists (use --force to replace it)`)
    await fs.rm(target, { recursive: true, force: true })
  }
  await fs.mkdir(skillsDir, { recursive: true })
  try {
    await copyTree(candidate.dir, target)
    await fs.writeFile(path.join(target, ORIGIN_FILE), JSON.stringify({ ...origin, installedAt: new Date().toISOString() }, null, 2))
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true })
    throw error
  }
  return target
}

/** Removes an installed skill folder (only folders directly inside the skills dir). */
export async function removeSkill(skillsDir: string, name: string): Promise<boolean> {
  if (!SKILL_NAME_RE.test(name)) return false
  const target = path.join(skillsDir, name)
  if (!(await fs.stat(target).then((s) => s.isDirectory(), () => false))) return false
  await fs.rm(target, { recursive: true, force: true })
  return true
}

// ------------------------------------------------------------------ drafts

export interface DraftsConfig {
  /** Where model-proposed skills wait for review. Default `~/.switchboard/skill-drafts`. */
  draftsDir?: string
}

export interface Draft {
  name: string
  description: string
  body: string
  proposedAt: number
}

export class SkillDrafts {
  readonly dir: string
  constructor(dir?: string) {
    this.dir = path.resolve((dir ?? path.join(os.homedir(), '.switchboard', 'skill-drafts')).replace(/^~(?=$|[\\/])/, os.homedir()))
  }

  async list(): Promise<Draft[]> {
    const out: Draft[] = []
    for (const entry of await fs.readdir(this.dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      const file = path.join(this.dir, entry.name, 'SKILL.md')
      const text = await fs.readFile(file, 'utf8').catch(() => null)
      const parsed = text === null ? null : parseSkillFile(text)
      if (!parsed || typeof parsed.meta.description !== 'string') continue
      const stat = await fs.stat(file)
      out.push({ name: entry.name, description: parsed.meta.description, body: parsed.body, proposedAt: stat.mtimeMs })
    }
    return out.sort((a, b) => a.proposedAt - b.proposedAt)
  }

  async get(name: string): Promise<Draft | undefined> {
    return (await this.list()).find((d) => d.name === name)
  }

  /** Stores a proposal. The file is inert: nothing reads the drafts folder as skills. */
  async propose(input: { name: string; description: string; body: string }): Promise<string> {
    const name = String(input.name ?? '').trim()
    if (!SKILL_NAME_RE.test(name)) throw new Error('the skill name must be lowercase letters, digits or "-" (max 64)')
    const description = String(input.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 1024)
    if (!description) throw new Error('a description is required: say when the skill should be used')
    const body = String(input.body ?? '').trim()
    if (!body) throw new Error('the skill body is empty')
    if (body.length > MAX_DRAFT_BODY) throw new Error(`the skill body is too long (max ${MAX_DRAFT_BODY} characters); split it or trim it`)
    const drafts = await this.list()
    if (!drafts.some((d) => d.name === name) && drafts.length >= MAX_DRAFTS) throw new Error(`${MAX_DRAFTS} drafts are already waiting for review; ask the user to review them (sbx skills drafts)`)
    const dir = path.join(this.dir, name)
    await fs.mkdir(dir, { recursive: true })
    // the frontmatter is built here, so the body cannot add fields to it
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\n${YAML.stringify({ name, description }).trimEnd()}\n---\n${body}\n`)
    return `saved as a draft "${name}". It is not active: the user reviews it with "sbx skills drafts" and accepts or rejects it.`
  }

  async reject(name: string): Promise<boolean> {
    if (!SKILL_NAME_RE.test(name)) return false
    const dir = path.join(this.dir, name)
    if (!(await fs.stat(dir).then((s) => s.isDirectory(), () => false))) return false
    await fs.rm(dir, { recursive: true, force: true })
    return true
  }

  /** Moves a reviewed draft into a skills folder. */
  async accept(name: string, skillsDir: string, force = false): Promise<string> {
    if (!(await this.get(name))) throw new Error(`no draft "${name}"`)
    const candidate = await previewSkillDir(path.join(this.dir, name))
    if ('error' in candidate) throw new Error(candidate.error)
    const target = await installCandidate(candidate, skillsDir, { source: 'model draft', commit: '' }, force)
    await this.reject(name)
    return target
  }
}

/** `skill-drafts-tool` — registers `propose_skill`. Inert by design: it only writes a draft for a human to review. */
export const toolsSkillDrafts = {
  name: 'skill-drafts-tool',
  inject: ['tools', 'skills'],

  apply(ctx: Context, config: DraftsConfig = {}) {
    if (!ctx.skills.enabled) return
    const drafts = new SkillDrafts(config.draftsDir)
    const def: ToolSpec = {
      name: 'propose_skill',
      description:
        'After you solved a task with a reusable multi-step procedure, propose it as a skill. It is saved as a DRAFT that does nothing until the user reviews and accepts it. Describe the procedure in your own words (steps, commands, pitfalls); do not copy text from web pages or files, and never include secrets.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Lowercase slug, e.g. "release-checklist".' },
          description: { type: 'string', description: 'One sentence: what the skill does and WHEN to use it.' },
          body: { type: 'string', description: `Markdown instructions (max ${MAX_DRAFT_BODY} characters).` },
        },
        required: ['name', 'description', 'body'],
      },
      async execute(args: { name: string; description: string; body: string }) {
        try {
          return await drafts.propose(args)
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    }
    ctx.effect(() => ctx.tools.register(def))
  },
}
