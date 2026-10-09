import { open } from 'node:fs/promises'
import { constants } from 'node:fs'

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
