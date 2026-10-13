/** Real-Docker ownership audit (any platform with Docker): a container that
 * matches the managed naming pattern but lacks the ownership label must be
 * refused and left untouched by cleanup. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stopLocalSandbox } from '../dist/services/local-opensandbox.js'
const e = promisify(execFile)
const root = await mkdtemp(path.join(tmpdir(), 'sbx-ownership-'))
const managed = { installId: 'deadbeef-0000-4000-8000-000000000000', containerName: 'sbx-opensandbox-deadbeefdead', port: 1 }
const created = await e('docker', ['run', '-d', '--name', managed.containerName, 'node:24-alpine', 'sleep', '600'])
assert.ok(created.stdout.trim().length >= 12)
try {
  const before = await e('docker', ['inspect', '--format', '{{.State.Running}}', managed.containerName])
  await assert.rejects(stopLocalSandbox(root, managed), /not owned/)
  const after = await e('docker', ['inspect', '--format', '{{.State.Running}}', managed.containerName])
  assert.equal(after.stdout.trim(), before.stdout.trim())
  console.log('REAL_DOCKER_FOREIGN_CONTAINER_NOT_REMOVED_PASS')
} finally {
  await e('docker', ['rm', '-f', managed.containerName]).catch(() => {})
  await rm(root, { recursive: true, force: true })
}