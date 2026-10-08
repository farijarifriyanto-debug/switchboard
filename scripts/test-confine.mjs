/**
 * Workspace confinement: lexical escapes AND symlink escapes are refused.
 *
 *   node scripts/test-confine.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { confine } from '../dist/services/confine.js'
import { createHost } from '../dist/index.js'

if (process.platform === 'win32') {
  console.log('confine: skipped on Windows (symlinks need privileges)')
  process.exit(0)
}
const base = await mkdtemp(path.join(tmpdir(), 'sbx-confine-'))
const root = path.join(base, 'ws')
const outside = path.join(base, 'outside')
await mkdir(path.join(root, 'sub'), { recursive: true })
await mkdir(outside)
await writeFile(path.join(outside, 'secret.txt'), 'top secret')
await writeFile(path.join(root, 'ok.txt'), 'fine')
await symlink(outside, path.join(root, 'linkdir'))
await symlink(path.join(outside, 'secret.txt'), path.join(root, 'linkfile'))
await symlink(path.join(outside, 'new.txt'), path.join(root, 'dangling'))
await symlink('ok.txt', path.join(root, 'inner'))

const refuses = async (t) => assert.rejects(confine(root, t), /escapes workspace/, `refuses ${t}`)
try {
  await confine(root, 'ok.txt')
  await confine(root, 'sub/new/deep.txt') // not created yet: still fine
  await confine(root, 'inner') // link that stays inside
  await refuses('../outside/secret.txt')
  await refuses('linkdir/secret.txt')
  await refuses('linkdir/brand-new.txt')
  await refuses('linkfile')
  await refuses('dangling')

  const host = await createHost({
    llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub', retries: 0 },
    metrics: { persist: '', load: false },
    sessions: { dir: '', load: false },
    workspace: { root, remember: false },
    approval: { mode: 'off' },
    tools: { fs: { root } },
  })
  try {
    assert.equal(await host.ctx.tools.call('read_file', { path: 'ok.txt' }), 'fine')
    assert.match(await host.ctx.tools.call('read_file', { path: 'linkfile' }), /escapes workspace/)
    assert.match(await host.ctx.tools.call('write_file', { path: 'linkdir/pwn.txt', content: 'x' }), /escapes workspace/)
    assert.match(await host.ctx.tools.call('write_file', { path: 'dangling', content: 'x' }), /escapes workspace/)
    await assert.rejects(readFile(path.join(outside, 'pwn.txt')), /ENOENT/, 'nothing was written outside')
    await assert.rejects(readFile(path.join(outside, 'new.txt')), /ENOENT/, 'nothing was written through the dangling link')
    const found = await host.ctx.tools.call('search_files', { pattern: 'secret' })
    assert.equal(found, 'no matches', 'search does not read through links that leave the workspace')
  } finally {
    await host.dispose()
  }
  console.log('confine: OK')
} finally {
  await rm(base, { recursive: true, force: true })
}
