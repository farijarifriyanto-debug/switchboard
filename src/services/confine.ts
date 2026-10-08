import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

const inside = (root: string, target: string): boolean => {
  const rel = path.relative(root, target)
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Resolves `target` against `root` and refuses anything that leaves it, INCLUDING
 * through symlinks: the deepest existing ancestor is realpath'ed and must stay
 * inside the real root. A dangling symlink is refused (writing through it would
 * create the file wherever it points). Returns the lexical absolute path.
 *
 * ponytail: check-then-use, so a link swapped in between the check and the open
 * can still win; closing that needs openat/O_NOFOLLOW, which Node does not expose.
 */
export async function confine(root: string, target: string): Promise<string> {
  const lexical = path.resolve(root, target)
  if (!inside(root, lexical)) throw new Error(`path escapes workspace: ${target}`)
  const realRoot = await realpath(root)
  let probe = lexical
  for (;;) {
    try {
      if (!inside(realRoot, await realpath(probe))) throw new Error(`path escapes workspace: ${target}`)
      return lexical
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      // realpath fails for a dangling symlink too; lstat tells the two apart.
      if (await lstat(probe).then(() => true, () => false)) throw new Error(`path escapes workspace (dangling link): ${target}`)
      const parent = path.dirname(probe)
      if (parent === probe) return lexical
      probe = parent
    }
  }
}
