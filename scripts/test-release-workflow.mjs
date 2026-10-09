import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'

const workflow = parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
const steps = workflow.jobs.release.steps
const executable = steps.filter(s => ['Tag matches package.json', 'Package release', 'GitHub release', 'Publish to npm'].includes(s.name) || s.run === 'npm test')
const root = await mkdtemp(path.join(tmpdir(), 'sbx-release-workflow-'))
const stub = `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2), tool=path.basename(process.argv[1]);
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify({tool,args})+'\\n');
if(tool==='git'){console.log(process.env.RELEASE_COMMIT);process.exit(0)}
if(tool==='npm'){
 if(args[0]==='pack'){const file='botconnector-switchboard-0.3.0.tgz';fs.writeFileSync(path.join(process.env.RUNNER_TEMP,file),'fixture package');console.log(file)}
 if(args[0]==='test'&&process.env.FAIL_TEST==='yes')process.exit(8);
 if(args[0]==='view'){if(process.env.PUBLISHED==='yes')console.log('0.3.0');else process.exit(1)}
 if(args[0]==='publish'&&process.env.FAIL_PUBLISH==='yes')process.exit(9);
}else if(args[0]==='release'&&args[1]==='view')process.exit(process.env.EXISTS==='yes'?0:1);
else if(args[0]==='api'&&args.some(a=>a.includes('/releases/tags/')))console.log('123');
`
async function scenario(name, extra = {}) {
  const dir = path.join(root, name), bin = path.join(dir, 'bin'), runner = path.join(dir, 'runner')
  await mkdir(bin, { recursive: true }); await mkdir(runner)
  for (const tool of ['gh', 'npm', 'git']) await writeFile(path.join(bin, tool), stub, { mode: 0o755 })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: '@botconnector/switchboard', version: '0.3.0', type: 'module' }))
  await writeFile(path.join(dir, 'CHANGELOG.md'), '# Changelog\n## 0.3.0\nFeature notes.\n## 0.2.0\nOld notes.\n')
  const log = path.join(dir, 'commands.jsonl')
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', executable.map(s => s.run).join('\n')], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, RELEASE_TAG: 'v0.3.0', GITHUB_REF_NAME: 'v0.3.0', GITHUB_REF: 'refs/tags/v0.3.0', GITHUB_SHA: 'release-sha', RELEASE_COMMIT: 'release-sha', GITHUB_REPOSITORY: 'owner/repo', RUNNER_TEMP: runner, GITHUB_OUTPUT: path.join(dir, 'outputs'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary'), PACKAGE_FILE: path.join(runner, 'botconnector-switchboard-0.3.0.tgz'), COMMAND_LOG: log, PRIVATE_REPO: 'false', NODE_AUTH_TOKEN: '', ...extra },
  })
  const calls = (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const gh = calls.filter(c => c.tool === 'gh').map(c => c.args[1])
  return { ...result, calls, gh, runner }
}
try {
  const missing = await scenario('missing-token')
  assert.equal(missing.status, 0, `missing npm token must not fail GitHub release: ${missing.stderr}`)
  assert.ok(missing.gh.includes('create') && missing.gh.includes('upload'), 'GitHub release includes built assets without npm credentials')
  assert.ok(missing.calls.find(c => c.tool === 'gh' && c.args[1] === 'create').args.includes('--latest=false'))
  assert.ok(missing.calls.some(c => c.tool === 'gh' && c.args.includes('make_latest=legacy')), 'new releases use GitHub version/date selection for Latest')
  assert.equal(missing.calls.some(c => c.tool === 'npm' && c.args[0] === 'publish'), false)
  assert.match(await readFile(path.join(missing.runner, 'botconnector-switchboard-0.3.0.tgz.sha256'), 'utf8'), /[a-f0-9]{64}  botconnector-switchboard-0.3.0.tgz/)

  const existing = await scenario('existing-release', { EXISTS: 'yes' })
  assert.equal(existing.status, 0, existing.stderr)
  assert.ok(existing.gh.includes('edit') && existing.gh.includes('upload'))
  assert.equal(existing.gh.includes('create'), false, 'rerun updates the existing release')
  assert.equal(existing.calls.some(c => c.tool === 'gh' && c.args.includes('make_latest=legacy')), false)
  if (process.argv[2] !== 'provenance') assert.equal(existing.calls.find(c => c.tool === 'gh' && c.args[1] === 'edit').args.some(a => a.startsWith('--latest')), false, 'rerunning an older existing release preserves Latest')
  assert.ok(existing.calls.find(c => c.tool === 'gh' && c.args[1] === 'upload').args.includes('--clobber'))

  const configured = await scenario('configured-token', { NODE_AUTH_TOKEN: 'fixture', FAIL_PUBLISH: 'yes' })
  assert.equal(configured.status, 9, 'real npm publication failures remain visible')
  assert.ok(configured.gh.includes('upload'), 'npm failure happens after GitHub release is available')
  const publish = configured.calls.find(c => c.tool === 'npm' && c.args[0] === 'publish')
  assert.ok(publish.args.includes('--provenance'), 'public packages preserve provenance')
  assert.ok(publish.args[1].endsWith('.tgz'), 'publish the built, tested package')
  const privateRepo = await scenario('private-repo', { NODE_AUTH_TOKEN: 'fixture', PRIVATE_REPO: 'true' })
  assert.equal(privateRepo.status, 0, privateRepo.stderr)
  assert.equal(privateRepo.calls.find(c => c.tool === 'npm' && c.args[0] === 'publish').args.includes('--provenance'), false)

  const published = await scenario('already-published', { NODE_AUTH_TOKEN: 'fixture', PUBLISHED: 'yes', EXISTS: 'yes' })
  assert.equal(published.status, 0, published.stderr)
  assert.equal(published.calls.some(c => c.tool === 'npm' && c.args[0] === 'publish'), false, 'npm reruns skip published versions')

  const dispatch = await scenario('dispatch-provenance', { NODE_AUTH_TOKEN: 'fixture', GITHUB_REF: 'refs/heads/master', GITHUB_SHA: 'workflow-sha' })
  assert.equal(dispatch.status, 0, dispatch.stderr)
  assert.ok(dispatch.gh.includes('upload'))
  assert.equal(dispatch.calls.some(c => c.tool === 'npm' && c.args[0] === 'publish'), false, 'dispatch skips publication with mismatched provenance ref')
  const wrongSha = await scenario('wrong-source-sha', { NODE_AUTH_TOKEN: 'fixture', GITHUB_SHA: 'different-sha' })
  assert.notEqual(wrongSha.status, 0, 'mismatched source SHA is refused')
  assert.equal(wrongSha.calls.some(c => c.tool === 'npm' && c.args[0] === 'publish'), false)

  const failedTest = await scenario('failed-test', { FAIL_TEST: 'yes' })
  assert.equal(failedTest.status, 8)
  assert.equal(failedTest.gh.length, 0, 'failed tests prevent publication')
  const wrongTag = await scenario('wrong-tag', { RELEASE_TAG: 'master', GITHUB_REF_NAME: 'master' })
  assert.notEqual(wrongTag.status, 0)
  assert.equal(wrongTag.gh.length, 0, 'mismatched tags prevent publication')

  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true, 'existing tags can be recovered by dispatch')
  assert.ok(steps.find(s => s.uses === 'actions/checkout@v4').with.ref.includes('RELEASE_TAG'))
  assert.ok(steps.find(s => s.uses === 'actions/checkout@v4').with.ref.startsWith('refs/tags/'), 'dispatch builds the immutable tag, not a similarly named branch')
  for (const step of steps.filter(s => ['GitHub release', 'Publish to npm'].includes(s.name) || s.run === 'npm test')) {
    assert.equal(step['continue-on-error'], undefined)
    assert.ok(!step.if || step.if === 'success()', 'publication respects preceding failures')
  }
  console.log('release-workflow: OK (missing token, assets, retries, publish failures, provenance, test/tag gates)')
} finally { await rm(root, { recursive: true, force: true }) }
