import { open, readFile, unlink, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

interface Owner { host: string; pid: number; token: string }
/** Exclusive owner for one session directory; never steal a live/unknown/foreign owner. */
export async function acquireRecoveryLock(dir: string): Promise<(() => Promise<void>) | undefined> {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, '.recovery.lock')
  const owner: Owner = { host: os.hostname(), pid: process.pid, token: randomUUID() }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = await open(file, 'wx', 0o600)
      try { await fd.writeFile(JSON.stringify(owner)) } finally { await fd.close() }
      return async () => {
        try {
          const current = JSON.parse(await readFile(file, 'utf8')) as Owner
          if (current.token === owner.token) await unlink(file)
        } catch { /* missing lock is already released */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let prior: Owner
      try { prior = JSON.parse(await readFile(file, 'utf8')) } catch { return undefined }
      if (prior.host !== owner.host || !Number.isInteger(prior.pid) || prior.pid <= 0 || typeof prior.token !== 'string') return undefined
      try { process.kill(prior.pid, 0); return undefined } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return undefined
      }
      // A competing claimant can observe the same dead owner. Atomically serialize
      // reclamation with a second exclusive lock, then compare before unlinking.
      const claim = `${file}.claim`
      let guard
      try { guard = await open(claim, 'wx', 0o600) } catch { return undefined }
      try {
        const latest = JSON.parse(await readFile(file, 'utf8')) as Owner
        if (latest.token !== prior.token) return undefined
        await unlink(file)
      } catch { return undefined } finally { await guard.close(); await unlink(claim).catch(() => {}) }
    }
  }
  return undefined
}
