import { open, readFile, unlink, mkdir, link } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

interface Owner { host: string; pid: number; token: string }
/** Exclusive owner for one session directory; never steal a live/unknown/foreign owner. */
type Release = () => Promise<void>
export async function acquireRecoveryLock(dir: string): Promise<Release | undefined> {
  await mkdir(dir, { recursive: true })
  return acquire(path.join(dir, '.recovery.lock'), 0)
}

async function acquire(file: string, depth: number): Promise<Release | undefined> {
  if (depth > 32) return undefined // conservatively refuse pathological crash chains
  const owner: Owner = { host: os.hostname(), pid: process.pid, token: randomUUID() }
  for (let attempt = 0; attempt < 2; attempt++) {
    const staged = `${file}.${owner.token}.tmp`
    try {
      // Publish complete metadata atomically with exclusive creation. A crash
      // while writing leaves only an irrelevant temp file, never an empty lock.
      const fd = await open(staged, 'wx', 0o600)
      try { await fd.writeFile(JSON.stringify(owner)) } finally { await fd.close() }
      await link(staged, file)
      return async () => {
        try {
          const current = JSON.parse(await readFile(file, 'utf8')) as Owner
          if (current.token === owner.token) await unlink(file)
        } catch { /* missing lock is already released */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally { await unlink(staged).catch(() => {}) }

    let prior: Owner
    try { prior = JSON.parse(await readFile(file, 'utf8')) } catch { return undefined }
    if (prior.host !== owner.host || !Number.isInteger(prior.pid) || prior.pid <= 0 || typeof prior.token !== 'string') return undefined
    try { process.kill(prior.pid, 0); return undefined } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return undefined
    }
    // Reclamation has crash-recoverable ownership too. A dead guard is
    // reclaimed under its own guard; live contenders always serialize.
    const releaseGuard = await acquire(`${file}.claim`, depth + 1)
    if (!releaseGuard) return undefined
    try {
      const latest = JSON.parse(await readFile(file, 'utf8')) as Owner
      if (latest.token !== prior.token) return undefined
      await unlink(file)
    } catch { return undefined } finally { await releaseGuard() }
  }
  return undefined
}
