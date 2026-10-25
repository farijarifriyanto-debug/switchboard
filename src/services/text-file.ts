import { open, rename } from 'node:fs/promises'
import { constants } from 'node:fs'

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Windows can reject an atomic replace with EPERM/EACCES while another reader
 * has the target open. Retrying briefly preserves the atomic swap instead of
 * failing a completed write on a transient sharing violation.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  let delay = 10
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!code || !RENAME_RETRY_CODES.has(code) || attempt >= 8) throw error
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, 160)
    }
  }
}

/** Bound the actual read, not only a pre-read stat; refuse symlinks when supported. */
export async function readBoundedText(file: string, maxBytes: number): Promise<string | undefined> {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const st = await handle.stat()
    if (!st.isFile() || st.size > maxBytes) return undefined
    const buffer = Buffer.alloc(Math.min(st.size + 1, maxBytes + 1))
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null)
      if (!bytesRead) break
      total += bytesRead
    }
    if (total > maxBytes || total > st.size) return undefined
    return buffer.subarray(0, total).toString('utf8')
  } catch { return undefined } finally { await handle?.close() }
}
