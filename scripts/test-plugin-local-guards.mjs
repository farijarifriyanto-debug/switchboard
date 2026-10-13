import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stopLocalSandbox, startLocalSandbox } from '../dist/services/local-opensandbox.js'
const root = await mkdtemp(path.join(tmpdir(),'sbx-local-guards-'))
const prior = process.env.PATH
const installId = '1c8aa83d-7aae-4086-b039-d17512a43a21'
const containerName = 'sbx-opensandbox-1c8aa83d7aae'
const managed = { installId,containerName,port:23591 }
const dir=path.join(root,'opensandbox-local',installId)
async function fakeDock(script) {
 const bin=path.join(root,'fake-bin');await mkdir(bin,{recursive:true})
 await writeFile(path.join(bin,'docker'), '#!/bin/sh\n'+script+'\n',{mode:0o700})
 process.env.PATH=bin
}
try {
 process.env.PATH = path.join(root,'nothing')
 await assert.rejects(startLocalSandbox(root),/Docker Desktop \/ Docker Engine is required/)
 console.log('GUARD_DOCKER_MISSING_FAILS_BEFORE_INSTALL_PASS')
 if (process.platform === 'win32') {
  // execFile cannot run POSIX sh fakes on Windows (Node also refuses .cmd/bat
  // without shell since CVE-2024-27980). These ownership/OS-mismatch guard
  // paths stay covered on Linux CI and by the real Docker Desktop E2E here.
  console.log('GUARD_POSIX_FAKE_DOCKER_SKIPPED_ON_WIN32 (covered by real-docker E2E)')
 } else {
  await fakeDock("if [ \"$1\" = version ]; then echo windows; fi")
  await assert.rejects(startLocalSandbox(root),/requires Docker Linux containers/)
  console.log('GUARD_WINDOWS_CONTAINER_ENGINE_BLOCKED_PASS')
  await mkdir(dir,{recursive:true,mode:0o700})
  await writeFile(path.join(dir,'server.toml'),'secret test only',{mode:0o600})
  await fakeDock("if [ \"$1\" = container ]; then exit 0; fi")
  await stopLocalSandbox(root,managed)
  await assert.rejects(stat(dir),/ENOENT/)
  console.log('GUARD_UNINSTALL_WORKS_WHEN_CONTAINER_ALREADY_GONE_PASS')
  await mkdir(dir,{recursive:true,mode:0o700})
  await writeFile(path.join(dir,'server.toml'),'unrelated test only',{mode:0o600})
  await fakeDock(`if [ \"$1\" = container ]; then echo ${containerName}; elif [ \"$1\" = inspect ]; then echo wrong-owner; fi`)
  await assert.rejects(stopLocalSandbox(root,managed),/not owned/)
  assert.ok((await stat(dir)).isDirectory())
  console.log('GUARD_UNRELATED_DOCKER_CONTAINER_NEVER_REMOVED_PASS')
 }
 console.log('LOCAL_DOCKER_SAFETY_GUARDS_PASS')
}finally{process.env.PATH=prior;await rm(root,{recursive:true,force:true})}