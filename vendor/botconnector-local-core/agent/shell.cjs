// Phase-1 real shell tool. Runs INSIDE the workspace jail, tracks owned child
// processes, supports cancellation of ONLY BotConnector-owned processes.
// Prefers argv execution (shell=false); shell syntax only on explicit request.
// Dangerous patterns are flagged — never executed silently (loop gates them).
'use strict';
const { spawn, execFile } = require('child_process');
const path = require('path');

const MAX_OUTPUT_BYTES = 256 * 1024;
const owned = new Set(); // pids started by BotConnector and still running

const DANGEROUS = [
  [/rm\s+(-[^ ]*r[^ ]*\s+.*|\s+-rf?\s+)/i, 'rm -rf'],
  [/\bdel\b.*\/s/i, 'del /s'],
  [/Remove-Item/i, 'Remove-Item'],
  [/git\s+reset\s+--hard/i, 'git reset --hard'],
  [/git\s+clean\s+-f/i, 'git clean -f'],
  [/\bformat\b\s+[a-z]:/i, 'format drive'],
  [/\bdiskpart\b/i, 'diskpart'],
  [/\bshutdown\b/i, 'shutdown'],
  [/\breg\s+(add|delete|import)\b/i, 'registry modification'],
  [/\bsc\s+(config|create|delete|failure)\b/i, 'service change'],
  [/\b(New-Service|Set-Service|Stop-Service)\b/i, 'service change'],
  [/npm\s+(install|i)\s+-g/i, 'global package install'],
  [/pip\s+install/i, 'pip install'],
  [/choco\s+install/i, 'choco install'],
  [/winget\s+install/i, 'winget install'],
  [/\bmkfs\b/i, 'mkfs'],
  [/:[()]\s*\{.*\}.*&/i, 'fork bomb'],
];

function analyzeCommand(text) {
  const hits = DANGEROUS.filter(([re]) => re.test(text)).map(([, name]) => name);
  return { dangerous: hits.length > 0, hits };
}

const SHELL_META = /[|&;><`$(){}!]/;

// Split a simple command line into argv (quotes respected). Returns
// {exe, args} or {needsShell:true} when shell syntax is present.
function splitArgv(cmdline) {
  if (SHELL_META.test(cmdline)) return { needsShell: true };
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmdline))) args.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  if (!args.length) return { error: 'empty command' };
  return { exe: args[0], args: args.slice(1) };
}

function killOwned(pid) {
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => {});
    } else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
    return true;
  } catch { return false; }
}

// Run a command. Returns structured result — never throws.
// {exe, args} + shell:false preferred; {command, shell:true} only if shell
// syntax explicitly required (still owned + cancellable).
function run({ ws, exe = null, args = [], command = null, shell = false, cwdRel = '.', timeoutMs = 120000, signal = null, onData = null } = {}) {
  return new Promise((resolve) => {
    const finish = (r) => resolve(r);
    // cwd jail: child cwd must resolve inside workspace.
    const cwdR = ws.resolveInside(cwdRel || '.');
    if (!cwdR.ok) return finish({ ok: false, error: `COMMAND_CWD_ESCAPE_BLOCKED: ${cwdR.error}` });
    let cwd = cwdR.full;
    try { if (!require('fs').statSync(cwd).isDirectory()) return finish({ ok: false, error: `cwd not a directory: ${cwdR.rel}` }); }
    catch { return finish({ ok: false, error: `cwd missing: ${cwdR.rel}` }); }

    let display, analysis;
    const t0 = Date.now();
    if (command && !exe) {
      display = command;
      analysis = analyzeCommand(command);
      if (!shell) {
        const parts = splitArgv(command);
        if (parts.needsShell) return finish({ ok: false, error: 'command needs shell syntax — resubmit with shell:true (requires explicit approval)', needsShell: true, analysis });
        if (parts.error) return finish({ ok: false, error: parts.error });
        exe = parts.exe; args = parts.args; display = [exe, ...args].join(' ');
      }
    } else {
      display = [exe, ...args].join(' ');
      analysis = analyzeCommand(display);
    }
    if (!exe) return finish({ ok: false, error: 'no executable specified' });

    const spawnOpts = shell
      ? { cwd, shell: true, windowsHide: true }
      : { cwd, shell: false, windowsHide: true };
    let child = null, stdout = '', stderr = '', outTrunc = false, errTrunc = false;
    let killed = false, timedOut = false, settled = false, usedShell = shell;
    let killTimer = null;
    const done = (r) => { if (!settled) { settled = true; if (killTimer) clearTimeout(killTimer); finish(r); } };
    const armTimeout = () => {
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        timedOut = true; killed = true;
        if (child && child.pid) killOwned(child.pid);
      }, timeoutMs);
      if (killTimer.unref) killTimer.unref(); // never hold the loop alive on our own
    };
    const attach = (c) => {
      child = c;
      attach.gen = (attach.gen || 0) + 1;
      const myGen = attach.gen;
      if (child.pid) owned.add(child.pid);
      child.stdout && child.stdout.on('data', (ch) => {
        const s = ch.toString('utf8');
        if (onData) onData({ stream: 'stdout', text: s });
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += s.slice(0, MAX_OUTPUT_BYTES - stdout.length);
        else outTrunc = true;
      });
      child.stderr && child.stderr.on('data', (ch) => {
        const s = ch.toString('utf8');
        if (onData) onData({ stream: 'stderr', text: s });
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += s.slice(0, MAX_OUTPUT_BYTES - stderr.length);
        else errTrunc = true;
      });
      child.on('error', (e) => {
        // Windows: bare names like `npm` are .cmd shims, not real executables —
        // libuv refuses them with shell:false. Retry once through cmd.exe with a
        // safely quoted command line built from the SAME argv array (metachars
        // were already rejected by splitArgv, so no shell syntax can sneak in).
        // Still owned + cancellable via taskkill like any other child.
        if (!usedShell && process.platform === 'win32' && /ENOENT|EINVAL/i.test(e.message || '') && !/[/\\]/.test(exe) && !/\.(cmd|exe|bat)$/i.test(exe)) {
          try {
            // Quote minimally: bare words pass through untouched (cmd.exe /s
            // mangles fully-quoted lines); quote only args with whitespace.
            const q = (a) => /^[^\s"]+$/.test(a) ? a : `"${String(a).replace(/"/g, '""')}"`;
            const line = [exe, ...args].map(q).join(' ');
            usedShell = true;
            attach(spawn('cmd.exe', ['/d', '/s', '/c', line], { cwd, shell: false, windowsHide: true }));
            armTimeout();
            return;
          } catch {}
        }
        if (child.pid) owned.delete(child.pid);
        if (myGen !== attach.gen) return; // superseded by shim retry — ignore
        done({ ok: false, error: `spawn failed: ${e.message}`, command: display, analysis, durationMs: Date.now() - t0 });
      });
      child.on('close', (code, sig) => {
        if (child.pid) owned.delete(child.pid);
        if (myGen !== attach.gen) return; // superseded by shim retry — ignore
        done({
          ok: true, command: display, cwd: path.relative(ws.root, cwd) || '.', analysis,
          exitCode: code, signal: sig, cancelled: killed, timedOut,
          stdout, stderr, stdoutTruncated: outTrunc, stderrTruncated: errTrunc,
          durationMs: Date.now() - t0,
        });
      });
    };
    try {
      attach(shell ? spawn(command, [], spawnOpts) : spawn(exe, args, spawnOpts));
      armTimeout();
    } catch (e) { return done({ ok: false, error: `spawn failed: ${e.message}`, command: display, analysis }); }
    if (signal) {
      if (signal.aborted) { killed = true; if (child.pid) killOwned(child.pid); }
      else signal.addEventListener('abort', () => { killed = true; if (child.pid) killOwned(child.pid); }, { once: true });
    }
    return; // completion via close/error handlers above
  });
}

module.exports = { run, analyzeCommand, splitArgv, killOwned, owned, DANGEROUS: DANGEROUS.map(([, n]) => n) };
