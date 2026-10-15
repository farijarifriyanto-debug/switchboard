// `botconnector attach <url>` — a terminal client for an ALREADY-RUNNING
// backend (started by `botconnector ui` or `botconnector serve`), so the
// Web Agent Workspace and a terminal session can share one backend, one
// session store, one running local model, at the same time.
//
// Deliberately NOT a port of tui/app.cjs's full in-process agent loop: this
// contains no agent logic of its own at all — it is a thin HTTP client over
// the exact same /api/agent/task and /api/agent/apply endpoints the browser
// UI already calls (webui/server.cjs, agent/loop.cjs underneath). "Do not
// create separate agent implementations" is satisfied by there being
// nothing here to diverge — every decision (intent routing, approval
// gating, atomic apply) happens server-side, once, shared by both clients.
// This first cut is a plain line-based REPL, not the bare `botconnector`
// TUI's full ANSI rendering — the bare TUI is unchanged and remains the
// richer, first-class standalone experience; this is the additive, simpler
// "share a session with the browser" mode.
'use strict';
const readline = require('node:readline');

function attachFetch(base, path, opts = {}) {
  return fetch(new URL(path, base), opts);
}

async function runAttach(urlArg) {
  let base;
  try { base = new URL(urlArg); } catch { console.error(`Not a valid URL: ${urlArg}`); process.exit(1); }
  console.log(`Attaching to ${base.origin} ...`);
  let health;
  try { health = await attachFetch(base, '/health'); } catch (e) { console.error(`Could not reach ${base.origin}: ${e.message}`); process.exit(1); }
  if (!health.ok) { console.error(`${base.origin} did not respond healthily (HTTP ${health.status}). Is 'botconnector ui' or 'botconnector serve' running there?`); process.exit(1); }
  let secret;
  try { secret = (await (await attachFetch(base, '/api/session')).json()).secret; } catch (e) { console.error(`Could not establish a session with ${base.origin}: ${e.message}`); process.exit(1); }
  if (!secret) { console.error(`${base.origin} did not return a session credential.`); process.exit(1); }

  async function call(path, body) {
    const res = await attachFetch(base, path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BotConnector-Session': secret }, body: JSON.stringify(body || {}) });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || `Request failed: ${res.status}`);
    return data;
  }

  console.log(`Attached. This session shares its backend, sessions, and approvals with anyone using the Web Agent Workspace at ${base.origin}.`);
  console.log('Type a task/prompt (or "workspace <path>" to set the folder the agent works in, "exit" to quit).\n');

  // runAttach must not resolve until the REPL actually ends — without this,
  // the caller's `await runAttach(url)` resolves the instant listeners are
  // registered (readline.createInterface() itself doesn't block), and
  // execution falls through to whatever command-dispatch code follows in
  // bin/botconnector.mjs while this REPL is still running in the
  // background. Confirmed live: without this, every attach session
  // immediately printed "unknown command: attach" and the full --help text
  // before the REPL had processed a single line.
  return new Promise((resolveSession) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  let workspace = process.cwd();
  console.log(`Workspace: ${workspace}`);
  rl.prompt();

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }
    if (text === 'exit' || text === 'quit') { rl.close(); return; }
    if (text.startsWith('workspace ')) { workspace = text.slice('workspace '.length).trim(); console.log(`Workspace set to: ${workspace}`); rl.prompt(); return; }
    try {
      const r = await call('/api/agent/task', { prompt: text, workspace });
      if (r.status === 'needsApproval') {
        console.log(`\n--- Proposed ${r.kind} ---`);
        console.log(r.detail);
        console.log('---');
        const answer = await new Promise((resolve) => rl.question('Approve? [y/N] ', resolve));
        const approved = /^y(es)?$/i.test(answer.trim());
        const applied = await call('/api/agent/apply', { taskId: r.taskId, approved });
        console.log(`\n${applied.answer}\n`);
      } else {
        console.log(`\n${r.answer}\n`);
      }
    } catch (e) {
      console.error(`Error: ${e.message || e}`);
    }
    rl.prompt();
  });
  rl.on('close', () => { console.log('Detached.'); resolveSession(); });
  });
}

module.exports = { runAttach };
