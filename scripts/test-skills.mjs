/**
 * Skills: SKILL.md discovery, precedence, validation, load_skill, confinement,
 * the system-prompt section, and `/name` invocation.
 *
 *   node scripts/test-skills.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'
import { parseSkillFile, withSkills } from '../dist/services/skills.js'

// ---- parser + prompt helper
assert.equal(parseSkillFile('no frontmatter'), null)
assert.equal(parseSkillFile('---\n: bad: yaml: [\n---\nbody'), null)
assert.deepEqual(parseSkillFile('---\nname: a\ndescription: b\n---\n\nhello\n'), { meta: { name: 'a', description: 'b' }, body: 'hello' })
assert.equal(withSkills('base', '## Skills\nx'), 'base\n\n## Skills\nx')
assert.equal(withSkills(withSkills('base', '## Skills\nx'), '## Skills\ny'), 'base\n\n## Skills\ny', 'idempotent replace')
assert.equal(withSkills(withSkills('base', '## Skills\nx'), ''), 'base', 'empty section removes it')

// ---- fixtures
const base = await mkdtemp(path.join(tmpdir(), 'sbx-skills-'))
const ws = path.join(base, 'ws')
const globalDir = path.join(base, 'global')
const outside = path.join(base, 'secret.txt')
await writeFile(outside, 'TOP SECRET').catch(() => {})
const skill = async (root, folder, text, files = {}) => {
  const dir = path.join(root, folder)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), text)
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), content)
  }
  return dir
}
const projectSkills = path.join(ws, '.switchboard', 'skills')
await mkdir(ws, { recursive: true })
await writeFile(outside, 'TOP SECRET')
const deploy = await skill(projectSkills, 'deploy', '---\nname: deploy\ndescription: Ship the app safely.\n---\n# Deploy\nRun the checklist.', { 'scripts/check.sh': 'echo check', 'notes.md': 'remember' })
await symlink(outside, path.join(deploy, 'leak.txt'))
await skill(projectSkills, 'shared', '---\ndescription: Project version wins.\n---\nproject body')
await skill(globalDir, 'shared', '---\ndescription: Global version.\n---\nglobal body')
await skill(globalDir, 'only-global', '---\nname: only-global\ndescription: Lives in the home dir.\n---\nglobal only')
await skill(projectSkills, 'broken-no-desc', '---\nname: broken-no-desc\n---\nbody')
await skill(projectSkills, 'Bad Name', '---\nname: Bad Name\ndescription: invalid slug\n---\nbody')
await skill(projectSkills, 'no-frontmatter', 'just text')

// ---- stub model recording each request
const seen = []
const stub = http.createServer(async (req, res) => {
  if (req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'stub' }] }))
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  seen.push({ tools: (body.tools ?? []).map((t) => t.function.name), system: body.messages?.[0]?.content ?? '', messages: body.messages })
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise((r) => stub.listen(0, '127.0.0.1', r))
const baseURL = `http://127.0.0.1:${stub.address().port}/v1`
const boot = (extra = {}) =>
  createHost({
    llm: { baseURL, defaultModel: 'stub', retries: 0 },
    metrics: { persist: '', load: false },
    sessions: { dir: '', load: false },
    settings: { dir: path.join(base, 'settings') },
    workspace: { root: ws, remember: false },
    approval: { mode: 'off' },
    skills: { globalDir },
    web: { enabled: true, port: 0 },
    ...extra,
  })
const drain = async (stream) => {
  for await (const _ of stream) void _
}

const host = await boot()
try {
  const { ctx } = host
  const listed = await ctx.skills.list()
  assert.deepEqual(listed.map((s) => `${s.name}:${s.source}`), ['deploy:project', 'only-global:global', 'shared:project'], 'valid skills only; project beats global')
  assert.equal((await ctx.skills.get('shared')).body, 'project body')
  assert.deepEqual((await ctx.skills.get('deploy')).files, ['notes.md', 'scripts/check.sh'], 'links are not advertised')

  // ---- load_skill
  const loaded = await ctx.tools.call('load_skill', { name: 'deploy' })
  assert.match(loaded, /# Skill: deploy \(project\)/)
  assert.match(loaded, /Run the checklist\./)
  assert.match(loaded, /- scripts\/check\.sh/)
  assert.equal(await ctx.tools.call('load_skill', { name: 'deploy', file: 'scripts/check.sh' }), 'echo check')
  assert.match(await ctx.tools.call('load_skill', { name: 'deploy', file: '../../../../../secret.txt' }), /escapes workspace/)
  assert.match(await ctx.tools.call('load_skill', { name: 'deploy', file: 'leak.txt' }), /escapes workspace/, 'a link out of the skill folder is refused')
  assert.match(await ctx.tools.call('load_skill', { name: 'nope' }), /no skill "nope"\. Available: deploy, only-global, shared/)

  // ---- system prompt section and /name invocation
  const s1 = ctx.sessions.create({ title: 't' })
  await drain(ctx.agent.stream('hello', s1.id))
  let last = seen.at(-1)
  assert.match(last.system, /## Skills\n[\s\S]*- deploy: Ship the app safely\./)
  assert.match(last.system, /- only-global: Lives in the home dir\./)
  assert.ok(!last.system.includes('Run the checklist.'), 'bodies are not in the system prompt')
  assert.ok(last.tools.includes('load_skill'))

  await drain(ctx.agent.stream('/deploy to staging', s1.id))
  const userMsg = seen.at(-1).messages.filter((m) => m.role === 'user').at(-1).content
  assert.match(userMsg, /^\/deploy to staging/)
  assert.match(userMsg, /Run the checklist\./)
  assert.match(userMsg, /Task: to staging/)
  await drain(ctx.agent.stream('/unknown thing', s1.id))
  assert.equal(seen.at(-1).messages.filter((m) => m.role === 'user').at(-1).content, '/unknown thing', 'unknown slash text is untouched')

  // ---- hidden when the tool is hidden
  await drain(ctx.agent.stream('plain', ctx.sessions.create({ title: 'x' }).id, { excludeTools: ['load_skill'] }))
  assert.ok(!seen.at(-1).system.includes('## Skills'), 'no catalog when the model cannot load skills')
  // reviewer preset keeps load_skill
  await drain(ctx.agent.stream('review', ctx.sessions.create({ title: 'r' }).id, { preset: 'reviewer' }))
  assert.ok(seen.at(-1).system.includes('## Skills') && seen.at(-1).tools.includes('load_skill'))

  // ---- API
  const { url } = await ctx.web.ready()
  const api = await (await fetch(`${url}api/skills`)).json()
  assert.deepEqual(api.skills.map((s) => s.name), ['deploy', 'only-global', 'shared'])
  console.log('skills: OK')
} finally {
  await host.dispose()
  const off = await boot({ skills: { enabled: false, globalDir } })
  try {
    assert.deepEqual(await off.ctx.skills.list(), [])
    assert.equal(off.ctx.tools.get('load_skill'), undefined, 'disabled: no tool')
  } finally {
    await off.dispose()
  }
  stub.close()
  stub.closeAllConnections?.()
  await rm(base, { recursive: true, force: true })
}
