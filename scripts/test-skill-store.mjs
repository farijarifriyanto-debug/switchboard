/**
 * Skill drafts (propose_skill) and installing skills from a folder or git URL: previews and warnings,
 * limits, links skipped, no silent overwrite, drafts inert until accepted.
 *
 *   node scripts/test-skill-store.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'
import { SkillDrafts, MAX_DRAFTS, MAX_DRAFT_BODY, previewSkillDir, stageSource, installCandidate, removeSkill } from '../dist/services/skill-store.js'
import { parseSkillFile } from '../dist/services/skills.js'

const base = await mkdtemp(path.join(tmpdir(), 'sbx-skillstore-'))
const exists = (p) => stat(p).then(() => true, () => false)
const put = async (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), text)
  }
}

// ---- drafts
const drafts = new SkillDrafts(path.join(base, 'drafts'))
assert.match(await drafts.propose({ name: 'release-checklist', description: 'Ship a release.  Use when asked to release.', body: '1. test\n2. tag' }), /saved as a draft/)
const d = await drafts.get('release-checklist')
assert.equal(d.description, 'Ship a release. Use when asked to release.')
assert.equal(d.body, '1. test\n2. tag')
await assert.rejects(drafts.propose({ name: 'Bad Name', description: 'x', body: 'y' }), /lowercase/)
await assert.rejects(drafts.propose({ name: '../evil', description: 'x', body: 'y' }), /lowercase/)
await assert.rejects(drafts.propose({ name: 'a', description: '', body: 'y' }), /description is required/)
await assert.rejects(drafts.propose({ name: 'a', description: 'x', body: '' }), /empty/)
await assert.rejects(drafts.propose({ name: 'a', description: 'x', body: 'z'.repeat(MAX_DRAFT_BODY + 1) }), /too long/)
// a body cannot add frontmatter fields: the file's header is built by us
await drafts.propose({ name: 'sneaky', description: 'plain', body: '---\nname: other\nallowed-tools: Bash\n---\nhello' })
const sneaky = parseSkillFile(await readFile(path.join(base, 'drafts', 'sneaky', 'SKILL.md'), 'utf8'))
assert.deepEqual(sneaky.meta, { name: 'sneaky', description: 'plain' })
await drafts.reject('sneaky')
// a description that tries YAML tricks stays a plain string
await drafts.propose({ name: 'yaml', description: 'x\n---\nname: evil\n: [', body: 'b' })
assert.equal(parseSkillFile(await readFile(path.join(base, 'drafts', 'yaml', 'SKILL.md'), 'utf8')).meta.name, 'yaml')
await drafts.reject('yaml')
// the queue is capped (an injected page cannot flood it), but a known draft can be rewritten
for (let i = 0; drafts && (await drafts.list()).length < MAX_DRAFTS; i++) await drafts.propose({ name: `fill-${i}`, description: 'x', body: 'y' })
await assert.rejects(drafts.propose({ name: 'one-too-many', description: 'x', body: 'y' }), /drafts are already waiting/)
await drafts.propose({ name: 'release-checklist', description: 'updated', body: 'new' })
assert.equal((await drafts.get('release-checklist')).body, 'new')
for (const x of await drafts.list()) if (x.name.startsWith('fill-')) await drafts.reject(x.name)
await drafts.propose({ name: 'release-checklist', description: 'Ship it.', body: 'steps' })

// accept moves it into a skills folder; never over an existing one
const skillsDir = path.join(base, 'ws', '.switchboard', 'skills')
const target = await drafts.accept('release-checklist', skillsDir)
assert.equal(target, path.join(skillsDir, 'release-checklist'))
assert.ok(await exists(path.join(target, 'SKILL.md')))
assert.equal(await drafts.get('release-checklist'), undefined, 'accepted drafts leave the queue')
await drafts.propose({ name: 'release-checklist', description: 'again', body: 'again' })
await assert.rejects(drafts.accept('release-checklist', skillsDir), /already exists/)
assert.ok(await drafts.get('release-checklist'), 'a refused accept keeps the draft')
await drafts.accept('release-checklist', skillsDir, true)
assert.equal((await drafts.reject('nope')), false)

// ---- previews and warnings
const src = path.join(base, 'src')
await put(path.join(src, 'skills', 'deploy'), {
  'SKILL.md': '---\nname: deploy\ndescription: Ship the app.\nallowed-tools: Bash(git:*)\nlicense: MIT\n---\n# Deploy\nrun scripts/go.sh',
  'scripts/go.sh': 'echo go',
  'references/notes.md': 'notes',
})
await put(path.join(src, 'skills', 'folder-name'), { 'SKILL.md': '---\nname: renamed\ndescription: Folder differs from name.\n---\nbody' })
await put(path.join(src, 'skills', 'broken'), { 'SKILL.md': 'no frontmatter' })
await put(path.join(src, 'skills', 'nodesc'), { 'SKILL.md': '---\nname: nodesc\n---\nbody' })
await put(path.join(src, 'node_modules', 'x'), { 'SKILL.md': '---\nname: x\ndescription: ignored\n---\nbody' })
await writeFile(path.join(base, 'secret.txt'), 'TOP SECRET')
await symlink(path.join(base, 'secret.txt'), path.join(src, 'skills', 'deploy', 'leak.txt'))

const staged = await stageSource(src)
assert.deepEqual(staged.candidates.map((c) => c.name).sort(), ['deploy', 'renamed'])
assert.deepEqual(staged.invalid.map((i) => i.folder).sort(), ['broken', 'nodesc'])
const deploy = staged.candidates.find((c) => c.name === 'deploy')
assert.ok(deploy.warnings.some((w) => /ships scripts.*scripts\/go\.sh/.test(w)))
assert.ok(deploy.warnings.some((w) => /allowed-tools: ignored/.test(w)))
assert.ok(deploy.warnings.some((w) => /symbolic link leak\.txt will be skipped/.test(w)))
assert.deepEqual(deploy.files.map((f) => f.path), ['references/notes.md', 'scripts/go.sh'])
assert.ok(staged.candidates.find((c) => c.name === 'renamed').warnings.some((w) => /installed as "renamed"/.test(w)))
assert.equal(staged.commit, '')

// ---- install: copies files (no links), records the origin, refuses to overwrite
const dest = path.join(base, 'dest')
const installed = await installCandidate(deploy, dest, { source: src, commit: '' })
assert.equal(installed, path.join(dest, 'deploy'))
assert.deepEqual((await readdir(installed)).sort(), ['.switchboard-origin.json', 'SKILL.md', 'references', 'scripts'])
assert.ok(!(await exists(path.join(installed, 'leak.txt'))), 'the link was not followed or copied')
assert.equal(JSON.parse(await readFile(path.join(installed, '.switchboard-origin.json'), 'utf8')).source, src)
await assert.rejects(installCandidate(deploy, dest, { source: src, commit: '' }), /already exists/)
await installCandidate(deploy, dest, { source: src, commit: '' }, true)
const renamed = staged.candidates.find((c) => c.name === 'renamed')
assert.equal(await installCandidate(renamed, dest, { source: src, commit: '' }), path.join(dest, 'renamed'), 'installed under the skill name, not the folder name')

// size limits abort and clean up
await put(path.join(base, 'big', 'huge'), { 'SKILL.md': '---\nname: huge\ndescription: too big.\n---\nb', 'blob.bin': 'x'.repeat(250_000) })
const big = await stageSource(path.join(base, 'big'))
assert.ok(big.candidates[0].warnings.some((w) => /blob\.bin is larger/.test(w)))
await assert.rejects(installCandidate(big.candidates[0], dest, { source: 'big', commit: '' }), /larger than/)
assert.ok(!(await exists(path.join(dest, 'huge'))), 'a failed install leaves nothing behind')

// remove
assert.equal(await removeSkill(dest, 'deploy'), true)
assert.equal(await removeSkill(dest, 'deploy'), false)
assert.equal(await removeSkill(dest, '../dest'), false, 'names are slugs, never paths')

// sources: only folders and https URLs
await assert.rejects(stageSource('http://example.com/x.git'), /neither a folder nor an https/)
await assert.rejects(stageSource('git@github.com:a/b.git'), /neither a folder nor an https/)
await assert.rejects(stageSource('ext::sh -c touch /tmp/pwned'), /neither a folder nor an https/)
await assert.rejects(stageSource(path.join(base, 'missing')), /neither a folder nor an https/)
const empty = await previewSkillDir(path.join(base, 'big'))
assert.ok('error' in empty)

// ---- the tool, and drafts never become skills by themselves
const host = await createHost({
  llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub', retries: 0 },
  metrics: { persist: '', load: false },
  sessions: { dir: '', load: false },
  settings: { dir: path.join(base, 'settings') },
  workspace: { root: path.join(base, 'ws'), remember: false },
  approval: { mode: 'risky' },
  skills: { globalDir: path.join(base, 'global'), draftsDir: path.join(base, 'tool-drafts') },
})
try {
  const { ctx } = host
  const tool = ctx.tools.get('propose_skill')
  assert.ok(tool, 'propose_skill is registered')
  assert.equal(ctx.approvals.needsApproval('propose_skill', undefined, tool.risk), false, 'inert: it only writes a draft')
  assert.match(await ctx.tools.call('propose_skill', { name: 'from-model', description: 'Use when X.', body: 'do the thing' }), /saved as a draft "from-model"/)
  assert.match(await ctx.tools.call('propose_skill', { name: 'Bad', description: 'x', body: 'y' }), /^Error: the skill name must be/)
  assert.ok(!(await ctx.skills.list()).some((s) => s.name === 'from-model'), 'a draft is not a skill')
  assert.ok(await exists(path.join(base, 'tool-drafts', 'from-model', 'SKILL.md')))
} finally {
  await host.dispose()
}
await staged.cleanup()
console.log('skill-store: OK')
