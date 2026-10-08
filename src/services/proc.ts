import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

/**
 * Stops a child AND everything it spawned. A shell wrapper (`/bin/sh -c`) only
 * forwards a signal to itself, so grandchildren survive a plain `child.kill()`
 * and keep running (and holding the stdio pipes open) after a timeout/cancel.
 * POSIX: the child must be spawned `detached` so it leads its own process
 * group; the whole group gets SIGTERM, then SIGKILL after `graceMs`.
 * Windows: `taskkill /t /f` takes the tree down.
 */
export function killTree(child: ChildProcess, graceMs = 3_000): void {
  const pid = child.pid
  if (pid == null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    })
    return
  }
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        /* already gone */
      }
    }
  }
  signalGroup('SIGTERM')
  setTimeout(() => signalGroup('SIGKILL'), graceMs).unref()
}

const live = new Set<ChildProcess>()
let exitHook = false

/**
 * Detached children no longer receive the terminal's Ctrl+C with the parent, so
 * remember them and take their group down when this process exits.
 */
export function trackTree(child: ChildProcess): void {
  if (process.platform === 'win32') return
  live.add(child)
  child.once('close', () => live.delete(child))
  if (exitHook) return
  exitHook = true
  process.on('exit', () => {
    for (const c of live) {
      if (c.pid == null) continue
      try {
        process.kill(-c.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  })
}
