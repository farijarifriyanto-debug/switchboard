/**
 * run_command sandbox: wrapper command lines (always), and real isolation when
 * bubblewrap / docker work on this machine (skipped otherwise, say so).
 *
 *   node scripts/test-sandbox.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHost } from '../dist/index.js'
import { buildSandboxCommand, sandboxProblem } from '../dist/services/sandbox.js'

const ws = '/tmp/some project'
const inArgs = (args, ...seq) => args.some((_, i) => seq.every((v, j) => args[i + j] === v))

// ---- wrapper command lines
const bw = buildSandboxCommand({ mode: 'bwrap' }, { workspace: ws, command: 'echo hi', name: 'x' })
assert.equal(bw.file, 'bwrap')
assert.ok(bw.args.includes('--unshare-all') && bw.args.includes('--clearenv') && bw.args.includes('--die-with-parent'))
assert.ok(!bw.args.includes('--share-net'), 'no network by default')
assert.ok(inArgs(bw.args, '--bind', ws, '/workspace'), 'project is writable at /workspace')
assert.ok(inArgs(bw.args, '--chdir', '/workspace'))
assert.deepEqual(bw.args.slice(-3), ['/bin/sh', '-c', 'echo hi'], 'the command goes last, as one argument')
assert.ok(!bw.args.includes('/home') && !bw.args.some((a) => a.startsWith('/home/')), 'the home directory is never mounted')
process.env.SBX_TEST_SECRET = 'hunter2'
assert.ok(!JSON.stringify(bw.args).includes('hunter2'), 'host env is not passed by default')
const bwNet = buildSandboxCommand({ mode: 'bwrap', network: true, workspace: 'ro', passEnv: ['SBX_TEST_SECRET', 'NOT SET', 'bad name'], readOnly: ['/'] }, { workspace: ws, command: 'x', name: 'x' })
assert.ok(bwNet.args.includes('--share-net'))
assert.ok(inArgs(bwNet.args, '--ro-bind', ws, '/workspace'), 'workspace: ro')
assert.ok(inArgs(bwNet.args, '--setenv', 'SBX_TEST_SECRET', 'hunter2'), 'passEnv is explicit')
assert.ok(!bwNet.args.includes('bad name'))

const dk = buildSandboxCommand({ mode: 'docker', image: 'alpine:3', memory: '256m' }, { workspace: ws, command: 'echo "a b"', name: 'abc', uid: 1001, gid: 1002 })
assert.equal(dk.file, 'docker')
assert.equal(dk.container, 'sbx-abc')
for (const flag of ['--rm', '--init', '--read-only', '--cap-drop', 'ALL', 'no-new-privileges', 'none']) assert.ok(dk.args.includes(flag), `docker has ${flag}`)
assert.ok(inArgs(dk.args, '--user', '1001:1002') && inArgs(dk.args, '--memory', '256m') && inArgs(dk.args, '-v', `${ws}:/workspace`))
assert.deepEqual(dk.args.slice(-4), ['alpine:3', 'sh', '-c', 'echo "a b"'])
assert.ok(inArgs(buildSandboxCommand({ mode: 'docker', network: true }, { workspace: ws, command: 'x', name: 'x' }).args, '--network', 'bridge'))
assert.ok(inArgs(buildSandboxCommand({ mode: 'docker', workspace: 'ro' }, { workspace: ws, command: 'x', name: 'x' }).args, '-v', `${ws}:/workspace:ro`))
assert.ok(!JSON.stringify(dk.args).includes('hunter2'))

// ---- fail closed: a missing sandbox never falls back to the host
{
  const dir = await mkdtemp(path.join(tmpdir(), 'sbx-sb-'))
  const savedPath = process.env.PATH
  process.env.PATH = '/nonexistent'
  const host = await createHost({
    llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub', retries: 0 },
    metrics: { persist: '', load: false },
    sessions: { dir: '' },
    settings: { dir: '' },
    approval: { mode: 'off' },
    workspace: { root: dir, remember: false },
    tools: { shell: { cwd: dir, sandbox: { mode: 'docker', image: 'missing:image' } } },
  })
  try {
    const out = await host.ctx.tools.call('run_command', { command: `touch ${dir}/ran-on-host` })
    assert.match(out, /sandbox is unavailable, so the command was NOT run/)
    await assert.rejects(readFile(path.join(dir, 'ran-on-host')), /ENOENT/, 'nothing ran on the host')
    assert.match(host.ctx.tools.get('run_command').description, /docker sandbox/, 'the model is told about the sandbox')
  } finally {
    process.env.PATH = savedPath
    await host.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

// ---- real isolation, when this machine can do it
const real = async (sandbox, label) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sbx-real-'))
  await writeFile(path.join(dir, 'in.txt'), 'project file')
  const make = (extra = {}) =>
    createHost({
      llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub', retries: 0 },
      metrics: { persist: '', load: false },
      sessions: { dir: '' },
      settings: { dir: '' },
      approval: { mode: 'off' },
      workspace: { root: dir, remember: false },
      tools: { shell: { cwd: dir, timeoutMs: 20_000, sandbox: { ...sandbox, ...extra } } },
    })
  const host = await make()
  const run = (command) => host.ctx.tools.call('run_command', { command })
  try {
    assert.equal(await run('cat /workspace/in.txt'), 'project file', `${label}: the project is visible`)
    assert.match(await run('echo "[$SBX_TEST_SECRET]"'), /^\[\]$/, `${label}: host env (API keys) is not visible`)
    assert.match(await run('ls /home 2>&1; ls /root 2>&1; cat /etc/shadow 2>&1'), /No such file|cannot access|Permission denied|can't open/, `${label}: the host home/shadow are not there`)
    await run('echo written > /workspace/out.txt')
    assert.equal((await readFile(path.join(dir, 'out.txt'), 'utf8')).trim(), 'written', `${label}: writes to the project land on the host`)
    assert.equal((await run('cat /proc/net/dev | tail -n +3 | wc -l')).trim(), '1', `${label}: only the loopback interface exists`)
    const started = Date.now()
    const slow = await run('sleep 60 & sleep 60')
    void slow
    await host.dispose()
    // ---- read-only project
    const roHost = await make({ workspace: 'ro' })
    try {
      const denied = await roHost.ctx.tools.call('run_command', { command: 'echo nope > /workspace/blocked.txt' })
      assert.match(denied, /exit [1-9]|Read-only/i, `${label}: the project can be mounted read-only`)
      await assert.rejects(readFile(path.join(dir, 'blocked.txt')), /ENOENT/)
    } finally {
      await roHost.dispose()
    }
    return Date.now() - started
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
for (const [sandbox, label] of [[{ mode: 'bwrap' }, 'bwrap'], [{ mode: 'docker', image: 'node:24-alpine' }, 'docker']]) {
  const problem = sandboxProblem(sandbox)
  if (problem) {
    console.log(`sandbox ${label}: SKIPPED real checks (${problem})`)
    continue
  }
  const ms = await real(sandbox, label)
  assert.ok(ms < 40_000, `${label}: a stuck command is cut off by the timeout (took ${ms}ms)`)
  console.log(`sandbox ${label}: real isolation checks passed`)
}
console.log('sandbox: OK')
