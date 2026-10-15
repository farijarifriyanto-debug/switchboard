// Per-user single-instance lock for `botconnector ui`. A second launch
// should not start a second HTTP server/core process — it should find the
// live instance and hand the user back to it. A background process cannot
// literally focus another process's already-open browser TAB (browsers
// don't expose that to outside processes, by design, for security) — the
// honest equivalent every local-web-app launcher uses is: open a new tab
// pointed at the same already-running server. That is what the caller does
// with the record this module returns; this module only answers "is a live
// instance already up, and if so where."
'use strict';
const fs = require('node:fs');

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function findExisting(lockFile) {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; }
  if (!rec || !Number.isInteger(rec.pid) || !Number.isInteger(rec.port)) return null;
  if (!isAlive(rec.pid)) return null; // stale lock from a crashed process — self-heals
  try {
    const r = await fetch(`http://127.0.0.1:${rec.port}/health`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) return rec;
  } catch { /* port not actually answering — stale lock, treat as no existing instance */ }
  return null;
}

function writeLock(lockFile, rec) {
  fs.writeFileSync(lockFile, JSON.stringify(rec));
}

function clearLock(lockFile, pid) {
  try {
    const rec = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (rec && rec.pid === pid) fs.unlinkSync(lockFile);
  } catch { /* already gone, or owned by a different (newer) process — leave it */ }
}

module.exports = { findExisting, writeLock, clearLock };
