import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Local CI runs shell commands with the operator's permissions. `enabled` only
 * opens the feature; `trusted` is a separate, per-project decision. The
 * interactive CLI writes this file after showing the project path. A config
 * `ci.trust: true` is an explicit opt-out for unattended hosts.
 */
export const CI_TRUST_FILE = path.join(os.homedir(), '.switchboard', 'ci-trust.json')

interface TrustFile {
  version: 1
  roots: string[]
}

function canonicalRoot(root: string): string {
  const resolved = path.resolve(root)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function readTrustFile(): TrustFile {
  try {
    const parsed = JSON.parse(readFileSync(CI_TRUST_FILE, 'utf8')) as Partial<TrustFile>
    if (parsed.version === 1 && Array.isArray(parsed.roots)) {
      return { version: 1, roots: parsed.roots.filter((item): item is string => typeof item === 'string') }
    }
  } catch {
    /* no trust file yet */
  }
  return { version: 1, roots: [] }
}

export function isCiTrusted(root: string, config?: { trust?: boolean }): boolean {
  if (config?.trust === true) return true
  return readTrustFile().roots.includes(canonicalRoot(root))
}

export async function trustCiRoot(root: string): Promise<void> {
  const target = canonicalRoot(root)
  const current = readTrustFile()
  if (!current.roots.includes(target)) current.roots.push(target)
  await mkdir(path.dirname(CI_TRUST_FILE), { recursive: true })
  await writeFile(CI_TRUST_FILE, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}
