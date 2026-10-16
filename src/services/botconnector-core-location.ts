/** Resolve the SAME pinned original BotConnector Local Core in npm and Windows portable.
 * npm layout: app root /vendor/botconnector-local-core
 * portable ZIP: Switchboard-<version>/app + sibling /local-core
 * No dynamic download or alternate model manager is used.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const BOTCONNECTOR_LOCAL_CORE_PIN = '1aa37824ea5d6bcd35f499c892a68cecfa695660'
const candidates = [
  fileURLToPath(new URL('../../vendor/botconnector-local-core/', import.meta.url)),
  fileURLToPath(new URL('../../../local-core/', import.meta.url)),
]
export function bundledBotConnectorCore(): string {
  for (const root of candidates) {
    const revision = path.join(root, 'SOURCE-REVISION.txt')
    const entry = path.join(root, 'bin', 'botconnector.mjs')
    if (!existsSync(revision) || !existsSync(entry)) continue
    const text = readFileSync(revision, 'utf8')
    if (text.includes(BOTCONNECTOR_LOCAL_CORE_PIN)) return root
    throw new Error('Bundled BotConnector Local Core does not match the pinned revision.')
  }
  throw new Error('Pinned BotConnector Local Core is missing. Reinstall the complete npm package or Windows portable ZIP.')
}
