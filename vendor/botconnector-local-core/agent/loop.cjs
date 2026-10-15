// Native agent loop (Phase 1: complete local coding-agent cycle).
// Deterministic intent router (Spark emits no reliable protocol tool_calls —
// verified live), real tools, proposal→diff→approval→apply for mutations,
// owned command execution, bounded multi-turn tasks (default cap 20).
// Router is isolated (detectIntents) so a future tool-calling model can
// replace it without touching tools, approvals, or atomic apply.
'use strict';
const fs = require('fs');
const { gate } = require('./permissions.cjs');
const context = require('./context.cjs');
const projectInstructions = require('./project-instructions.cjs');
const { createWorkspace } = require('./tools.cjs');
const mutate = require('./mutate.cjs');
const shell = require('./shell.cjs');

const MAX_TOOL_TURNS = 20;
const READ_TOOLS = new Set(['list_directory', 'read_file', 'search_files']);

// ---- intent router (deterministic; read + mutation + command) ----
function detectIntent(prompt) {
  const all = detectIntents(prompt);
  return all[0] || null;
}

function detectIntents(prompt) {
  const out = [];
  const quoted = prompt.match(/["“”']([^"'“”']{1,200})["“”']/);
  const fileTok = prompt.match(/[\w\-./\\]+\.\w{1,5}\b/);
  const fileToks = prompt.match(/[\w\-./\\]+\.\w{1,5}\b/g) || [];
  const marker = prompt.match(/[A-Za-z]+-\d{3,}/);

  // command intent
  const cmdM = prompt.match(/\b(npm\s+(test|run\s+\S+|start)\b|node\s+[\w\-./\\]+\.js\b|npx\s+\S+[^\n]*|git\s+status\b)/i);
  const bareTest = /(jalankan|run)\s+(test|tests|pengujian|pengujian|uji)\b/i.test(prompt) && !cmdM;
  if ((/(jalankan|run |execute|lalu jalankan|dan jalankan|npm test|node\s+\S+\.js)/i.test(prompt) && cmdM) || bareTest) {
    const spec = bareTest ? { exe: 'npm', args: ['test'], display: 'npm test' } : shell.splitArgv(cmdM[1].trim());
    if (spec.needsShell || spec.error) {
      if (!spec.needsShell) out.push({ kind: 'command', tool: 'run_command', args: { exe: null, args: [], display: cmdM[1].trim(), blocked: spec.error }, label: `● Running ${cmdM[1].trim()}` });
    } else {
      const display = bareTest ? spec.display : cmdM[1].trim();
      out.push({ kind: 'command', tool: 'run_command', args: { exe: spec.exe, args: spec.args, display }, label: `● Running ${display}` });
    }
  }
  // mutation intents (skipped on explicit "do not change" — e.g. "Jangan ubah apa pun")
  const noMut = /jangan\s+(ubah|edit|hapus|mengubah|menambah|menulis|touch|run|jalankan)/i.test(prompt);
  // Explicit target preposition wins: "tambahkan X ke src/math.js".
  const targetM = prompt.match(/(?:\bke|\bdalam|\bpada|\bdi|\bdari)\s+["“”']?([\w\-./\\]+\.\w{1,5}\b)["“”']?/i);
  const targetPath = targetM ? targetM[1] : null;
  if (!noMut) {
  if (/(buat|create|new file|tambah file|tambahkan file)/i.test(prompt) && (fileTok || quoted)) {
    const p = ((fileTok && fileTok[0]) || quoted[1]).replace(/^(file|berkas)\s+/i, '');
    out.push({ kind: 'mutation', tool: 'create_file', args: { path: p }, label: `● Preparing create ${p}` });
  } else if (/(hapus|delete|remove)\b/i.test(prompt) && (fileTok || quoted)) {
    const p = (fileTok && fileTok[0]) || quoted[1];
    out.push({ kind: 'mutation', tool: 'delete_file', args: { path: p }, label: `● Preparing delete ${p}` });
  } else if (/(rename|ganti nama|pindah|pindahkan)/i.test(prompt) && fileToks.length >= 2) {
    out.push({ kind: 'mutation', tool: 'rename_file', args: { src: fileToks[0], dst: fileToks[1] }, label: `● Preparing rename ${fileToks[0]} → ${fileToks[1]}` });
  } else if (/(tambah|tambahkan|ubah|perbaiki|ganti|tambah fungsi|edit|fix|update|tulis|implement)/i.test(prompt) && (fileTok || quoted)) {
    const p = targetPath || (fileTok && fileTok[0]) || quoted[1];
    out.push({ kind: 'mutation', tool: 'edit_file', args: { path: p }, label: `● Preparing edit ${p}` });
  }
  } // end !noMut
  // read intents (existing Phase-1B behavior)
  if (/cari|berisi|marker|search|find|mengandung|yang ada kata/i.test(prompt)) {
    let query = marker ? marker[0] : (quoted ? quoted[1] : null);
    if (!query) {
      const words = prompt.replace(/["“”']/g, '').split(/\s+/)
        .filter((w) => w.length >= 4 && !/^(cari|file|yang|dari|dalam|project|berisi|untuk|dengan|sebutkan|serta|barisnya|adalah|apa|tentang)$/i.test(w));
      query = words.sort((a, b) => b.length - a.length)[0] || '';
    }
    if (query) out.push({ kind: 'read', tool: 'search_files', args: { query }, label: `● Searching "${query}" in workspace` });
  }
  if (/isi |isinya|baca|read|tampilkan|content|apa isi|inspect|periksa|lihat/i.test(prompt) && (fileTok || quoted)) {
    const first = (fileTok && fileTok[0]) || quoted[1];
    if (!out.some((o) => o.tool === 'read_file' && o.args.path === first))
      out.push({ kind: 'read', tool: 'read_file', args: { path: first }, label: `● Reading ${first}` });
    // "Baca A dan B": one read intent per additional file token (cap 5 total).
    if (/dan|and|,/i.test(prompt)) {
      for (const f of fileToks.slice(1, 5)) {
        if (!out.some((o) => o.args && o.args.path === f))
          out.push({ kind: 'read', tool: 'read_file', args: { path: f }, label: `● Reading ${f}` });
      }
    }
  }
  if (/file apa|apa saja|yang ada di|list|daftar|folder|direktori|directory|isi folder|isi direktori/i.test(prompt)) {
    const dm = prompt.match(/(?:folder|direktori|directory)\s+["“”']?([\w\-./\\]+)["“”']?/i);
    let p = (dm && dm[1]) || (quoted && quoted[1]) || '.';
    if (/^(folder|direktori|directory|di|\.)$/i.test(p)) {
      const di = prompt.match(/\bdi\s+["“”']?([\w\-./\\]+)["“”']?/i);
      p = (di && !/^(folder|direktori|directory)$/i.test(di[1]) && di[1]) || '.';
    }
    out.push({ kind: 'read', tool: 'list_directory', args: { path: p }, label: `● Listing ${p}` });
  }
  // Drop a search intent that merely echoes a mutation target (e.g. "Buat file
  // notes.txt berisi..." matched "berisi"): it adds noise, not signal.
  const mutPaths = new Set();
  for (const o of out) {
    if (o.kind === 'mutation') {
      if (o.args.path) mutPaths.add(o.args.path);
      if (o.args.src) mutPaths.add(o.args.src);
      if (o.args.dst) mutPaths.add(o.args.dst);
    }
  }
  return out.filter((o) => o.tool !== 'search_files' || ![...mutPaths].some((p) => o.args.query.includes(p.replace(/^[./\\]+/, ''))));
}

function wsOf(workspace, cwd) {
  if (workspace && typeof workspace.listDirectory === 'function') return workspace;
  return createWorkspace(workspace || cwd);
}

function lastFence(text) {
  const re = /```(?:\w+)?\r?\n([\s\S]*?)```/g;
  let m, last = null;
  while ((m = re.exec(text || ''))) last = m[1];
  return last == null ? null : last.replace(/\s+$/, '');
}

async function streamModel(localCtx, messages, { maxTokens, signal, onToken, debugLog }) {
  const local = require('./local.cjs');
  return local.localChatStream({
    endpoint: localCtx.endpoint, model: localCtx.modelId, messages,
    maxTokens, signal, onToken,
    onReasoning: debugLog ? (t) => debugLog('[reasoning] ' + t) : null,
  });
}

const SAFE_READONLY_CMDS = new Set(['node --version', 'npm --version', 'git status', 'dir', 'ls']);

// Execute ONE intent end-to-end. Approvals via onApproval(req)->{approved,approveAll}.
// Session {approveAll} persists approve-all-for-session. Returns step result.
async function execIntent(intent, ctx) {
  const { ws, emit, localCtx, signal, onToken, debugLog, mode, approval, session, onApproval, taskPrompt } = ctx;
  const needApproval = approval !== 'full-auto' && !session.approveAll;

  const askApproval = async (req) => {
    emit({ type: 'approval', text: '○ Waiting for approval' });
    if (!needApproval) return { approved: true };
    if (!onApproval) return { approved: false, noHandler: true };
    const r = await onApproval(req);
    if (r && r.approveAll) session.approveAll = true;
    return r || { approved: false };
  };

  // ---- read tools (Plan + Act) ----
  if (intent.kind === 'read') {
    emit({ type: 'tool', text: intent.label });
    let res;
    try {
      if (intent.tool === 'read_file') res = ws.readFile(intent.args.path, {});
      else if (intent.tool === 'list_directory') res = ws.listDirectory(intent.args.path);
      else res = ws.searchFiles(intent.args.query, { signal });
    } catch (e) { res = { ok: false, error: `tool failed: ${e.message}` }; }
    if (res && res.cancelled) return { intent, cancelled: true };
    return { intent, toolResult: res };
  }

  // ---- mutations + commands require Act (PLAN_MUTATION=BLOCKED always) ----
  if (mode === 'Plan')
    return { intent, blocked: true, answer: `Plan mode is read-only — "${intent.tool}" needs Act mode (Tab). Nothing was changed.` };

  // ---- command ----
  if (intent.kind === 'command') {
    const display = intent.args.display;
    const analysis = shell.analyzeCommand(display);
    const safe = SAFE_READONLY_CMDS.has(display.trim());
    emit({ type: 'tool', text: intent.label + (analysis.dangerous ? `  ⚠ ${analysis.hits.join(', ')}` : '') });
    if (needApproval && !safe) {
      const a = await askApproval({ kind: 'command', title: `Proposed command: ${display}`, detail: `Command:\n${display}\n\nWorking directory:\n${ws.root}${analysis.dangerous ? `\n\n⚠ Dangerous pattern: ${analysis.hits.join(', ')}\nThis will NOT run silently — approval required.` : ''}`, command: display });
      if (a.noHandler) return { intent, needsApproval: true };
      if (!a.approved) return { intent, rejected: true, answer: 'Command rejected — nothing ran.' };
    }
    emit({ type: 'tool', text: `● Running ${display}… (Esc cancels)` });
    const res = await shell.run({
      ws, exe: intent.args.exe, args: intent.args.args, cwdRel: '.', timeoutMs: 120000, signal,
      onData: (d) => emit({ type: 'output', text: `[${d.stream}] ${d.text.slice(0, 500)}` }),
    });
    if (res.cancelled) return { intent, cancelled: true, answer: '(command cancelled — owned process killed, runtime untouched)' };
    if (!res.ok) return { intent, toolResult: res, answer: `Command failed to start: ${res.error}` };
    emit({ type: 'tool', text: res.exitCode === 0 ? `✓ Exit ${res.exitCode}` : `✗ Exit ${res.exitCode}` });
    return { intent, toolResult: res };
  }

  // ---- file mutations: model proposes content, local diff is truth ----
  const mutate = require('./mutate.cjs');
  let proposal = null;
  if (intent.tool === 'edit_file' || intent.tool === 'create_file') {
    const target = intent.args.path;
    let current = null;
    if (intent.tool === 'edit_file') {
      const r = ws.resolveInside(target);
      if (!r.ok) return { intent, answer: `Cannot edit: ${r.error}`, toolResult: r };
      try {
        const raw = fs.readFileSync(r.full);
        if (raw.includes(0)) return { intent, answer: `BINARY_MUTATION_BLOCKED: ${target} is binary`, toolResult: { ok: false } };
        current = raw.toString('utf8');
      } catch { return { intent, answer: `Cannot edit: file not found: ${target}`, toolResult: { ok: false } }; }
    }
    emit({ type: 'tool', text: intent.label });
    const ask = intent.tool === 'edit_file'
      ? `Task: ${taskPrompt}\n\nCurrent content of ${target}:\n\`\`\`\n${current.slice(0, 8000)}\n\`\`\`\n\nOutput ONLY the complete new file content inside one \`\`\` fence. No explanations outside the fence.`
      : `Task: ${taskPrompt}\n\nCreate new file ${target}. Output ONLY the complete file content inside one \`\`\` fence. No explanations outside the fence.`;
    const prop = await streamModel(localCtx, [
      { role: 'system', content: 'You are BotConnector, a local coding assistant. Output ONLY complete file content in one triple-backtick fence. Never output diffs or explanations outside the fence.' },
      { role: 'user', content: ask },
    ], { maxTokens: 2048, signal, onToken: null, debugLog });
    if (!prop.ok) return { intent, answer: prop.reason === 'cancelled' ? '(cancelled — runtime untouched)' : prop.reason, failed: true };
    const content = lastFence(prop.content);
    if (content == null) return { intent, answer: 'Model did not return file content in a fence — nothing changed.', failed: true };
    proposal = intent.tool === 'edit_file'
      ? mutate.buildEditProposal(ws, target, content)
      : mutate.buildCreateProposal(ws, target, content);
  } else if (intent.tool === 'delete_file') {
    emit({ type: 'tool', text: intent.label });
    proposal = mutate.buildDeleteProposal(ws, intent.args.path);
  } else if (intent.tool === 'rename_file') {
    emit({ type: 'tool', text: intent.label });
    proposal = mutate.buildRenameProposal(ws, intent.args.src, intent.args.dst);
  }
  if (!proposal || !proposal.ok)
    return { intent, answer: `Cannot propose ${intent.tool}: ${(proposal && proposal.error) || 'invalid intent'}`, failed: true, toolResult: proposal };

  const detail = proposal.kind === 'edit' ? proposal.diffText
    : proposal.kind === 'create' ? `Create ${proposal.path} (${proposal.content.split('\n').length} lines):\n\n${proposal.content.slice(0, 3000)}${proposal.content.length > 3000 ? '\n… (truncated preview)' : ''}`
    : proposal.kind === 'delete' ? `Delete ${proposal.path} (${proposal.bytes} bytes)\n(Reversible: moved to workspace trash on apply; hash verified before delete.)`
    : `Rename ${proposal.path} → ${proposal.dest}`;
  emit({ type: 'tool', text: `● Proposed ${proposal.kind} ${proposal.path}` });
  const a = await askApproval({ kind: proposal.kind, title: `Proposed ${proposal.kind}: ${proposal.path}`, detail, proposal });
  if (a.noHandler) return { intent, needsApproval: true, proposal };
  if (!a.approved) return { intent, rejected: true, answer: 'Rejected — nothing changed.' };

  let applied;
  try {
    if (proposal.kind === 'edit') applied = mutate.applyEdit(ws, proposal);
    else if (proposal.kind === 'create') applied = mutate.applyCreate(ws, proposal);
    else if (proposal.kind === 'delete') applied = mutate.applyDelete(ws, proposal);
    else applied = mutate.applyRename(ws, proposal);
  } catch (e) { applied = { ok: false, error: `apply failed: ${e.message}` }; }
  if (!applied.ok) return { intent, answer: `Apply aborted: ${applied.error}`, failed: true, stale: applied.stale };
  emit({ type: 'tool', text: `✓ Applied ${proposal.kind} ${proposal.path}` });
  return { intent, toolResult: applied, proposal };
}

// Single user message → possibly one tool + grounded model answer.
// `history`: prior {role,content} turns for session resume (additive, opt-in
// — omitted or empty behaves exactly as before). Bounded here to keep prompt
// size sane; the caller (sessions.cjs) also bounds what it persists.
async function runTurn({ prompt, mode, approval, model, tools, cwd, workspace = null, onEvent, localCtx = null, onToken = null, signal = null, debugLog = null, maxTokens = 512, onApproval = null, session = null, history = [], taskKind = 'chat', systemInstruction = null }) {
  const emit = (t) => onEvent && onEvent(t);
  const sess = session || { approveAll: false };
  const userTokens = context.estimateTokens(prompt);
  emit({ type: 'tool', text: `● Building context (~${userTokens} tokens)` });
  const intents = taskKind === 'review' ? [] : detectIntents(prompt);
  const primary = intents[0] || null;
  // Explicit route names — generic text is NEVER "analyze". Only workspace
  // routes may demand tool evidence; direct chat must stay tool-free.
  const ROUTE_OF = {
    read_file: 'workspace_read', list_directory: 'workspace_read',
    search_files: 'workspace_search', edit_file: 'workspace_mutation',
    create_file: 'workspace_mutation', delete_file: 'workspace_mutation',
    rename_file: 'workspace_mutation', run_command: 'command',
  };
  const route = primary ? (ROUTE_OF[primary.tool] || 'direct') : 'direct';
  const plannedOp = taskKind === 'review' ? 'review' : (primary ? primary.tool : 'direct');
  emit({ type: 'tool', text: `● Routing → ${route} (${model.name} · ${model.locality})` });

  const mutating = primary && (primary.kind === 'mutation' || primary.kind === 'command');
  const decision = gate({ mode, approval, op: mutating ? (primary.kind === 'command' ? 'run' : 'edit') : plannedOp });
  if (!decision.allowed && !decision.needsApproval)
    return { answer: decision.reason, blocked: true, op: plannedOp, route };
  if (decision.needsApproval && !localCtx) {
    emit({ type: 'approval', text: `○ Waiting for approval (${plannedOp})` });
    return { answer: null, needsApproval: true, op: plannedOp, route, reason: decision.reason };
  }

  const ws = wsOf(workspace, cwd);
  if (!localCtx) {
    // Offline acceptance path (unchanged Phase-1B behavior).
    let result = null;
    try {
      if (plannedOp === 'search' || plannedOp === 'search_files') result = ws.searchFiles(prompt.split(/\s+/).pop() || '');
      else result = { op: plannedOp, note: 'analysis complete (stub model)' };
    } catch (e) { result = { error: e.message }; }
    emit({ type: 'tool', text: `● Result received` });
    return { answer: `(${mode}) ${model.name}: processed “${prompt.slice(0, 80)}” → ${plannedOp} done.`, result, op: plannedOp, route };
  }

  if (taskKind === 'review') {
    emit({ type: 'tool', text: `● Reviewing with ${localCtx.friendly || model.name}…` });
    const r = await streamModel(localCtx, [
      { role: 'system', content: systemInstruction || 'You are BotConnector performing a read-only code review. Prioritize correctness, regressions, security, data-loss risk, missing tests, and material performance issues. Be concise and do not propose edits.' },
      { role: 'user', content: prompt },
    ], { maxTokens: Math.max(maxTokens, 1024), signal, onToken, debugLog });
    if (!r.ok) return { answer: r.reason === 'cancelled' ? '(cancelled — runtime untouched)' : r.reason, failed: r.reason !== 'cancelled', cancelled: r.reason === 'cancelled', op: plannedOp, route };
    emit({ type: 'tool', text: `● Review result received (${r.finish || 'done'})` });
    return { answer: r.content || '(empty review result)', result: { op: plannedOp }, op: plannedOp, route, streamed: true, firstTokenAt: r.firstTokenAt };
  }

  const ctx = { ws, emit, localCtx, signal, onToken, debugLog, mode, approval, session: sess, onApproval, taskPrompt: prompt };
  let step = null;
  if (primary && (primary.kind === 'read' || primary.kind === 'mutation' || primary.kind === 'command')) {
    step = await execIntent(primary, ctx);
    if (step.cancelled) return { answer: step.answer || '(cancelled — runtime untouched)', cancelled: true, op: plannedOp, route };
    if (step.blocked) return { answer: step.answer, blocked: true, op: plannedOp, route };
    if (step.needsApproval) return { answer: null, needsApproval: true, op: plannedOp, route, proposal: step.proposal };
    if (step.rejected) return { answer: step.answer, op: plannedOp, route, tool: primary.tool };
    if (step.failed && step.answer && !step.toolResult) return { answer: step.answer, failed: true, op: plannedOp, route };
  } else {
    emit({ type: 'tool', text: `● Querying local model (${localCtx.friendly || model.name})…` });
  }

  // Final model call. Workspace routes stay strictly grounded in tool JSON;
  // the direct route uses a tool-free prompt and MUST NOT demand tool JSON.
  const evidence = step && step.toolResult ? `\n\nTool ${primary.tool} result (JSON):\n${JSON.stringify(step.toolResult).slice(0, 6000)}` : '';
  // AGENTS.md rules (global to project) reach the model on the direct route; they never override the permission gate.
  const agentsMd = projectInstructions.promptBlock((typeof workspace === 'string' && workspace) || cwd || process.cwd(), { nCtx: localCtx && localCtx.nCtx });
  const baseSystem = evidence
    ? 'You are BotConnector, a helpful local AI assistant. Answer ONLY from the tool result JSON below. Quote paths, line numbers, exit codes faithfully. If the result is an error, report it plainly.'
    : 'You are BotConnector, a helpful local AI assistant running on the user\u2019s own machine. Answer the user directly and concisely. No tools or workspace access exist in this conversation \u2014 do not ask for tool output, file contents, or JSON; just answer from your own knowledge.';
  const system = !evidence && agentsMd ? [baseSystem, agentsMd].join('\n\n') : baseSystem;
  const historyMsgs = (history || []).slice(-12).map((m) => ({ role: m.role, content: m.content }));
  const r = await streamModel(localCtx, [
    { role: 'system', content: system },
    ...historyMsgs,
    { role: 'user', content: `${prompt}${evidence}` },
  ], { maxTokens: Math.max(maxTokens, 1024), signal, onToken, debugLog });
  if (!r.ok) return { answer: r.reason === 'cancelled' ? '(cancelled — runtime untouched)' : r.reason, failed: r.reason !== 'cancelled', cancelled: r.reason === 'cancelled', op: plannedOp, route };
  emit({ type: 'tool', text: `● Result received (${r.finish || 'done'})` });
  return { answer: r.content || '(empty response)', result: (step && step.toolResult) || { op: plannedOp }, op: plannedOp, route, streamed: true, firstTokenAt: r.firstTokenAt, tool: primary ? primary.tool : null, toolCalls: step && step.toolResult ? 1 : 0 };
}

// Bounded multi-tool task: executes detected intents in order (max 20 tool
// turns), then one final model summary over all step results.
async function runTask({ task, mode, approval, model, cwd, workspace = null, onEvent, localCtx, signal = null, debugLog = null, onApproval = null, maxToolTurns = MAX_TOOL_TURNS }) {
  const emit = (t) => onEvent && onEvent(t);
  const sess = { approveAll: false };
  const ws = wsOf(workspace, cwd);
  const intents = detectIntents(task);
  // Safe execution order regardless of mention order: reads → mutations → commands.
  const rank = { read: 0, mutation: 1, command: 2 };
  intents.sort((a, b) => (rank[a.kind] - rank[b.kind]) || 0);
  const ctx = { ws, emit, localCtx, signal, onToken: null, debugLog, mode, approval, session: sess, onApproval, taskPrompt: task };
  const steps = [];
  let turns = 0;
  for (const intent of intents) {
    if (turns >= maxToolTurns) {
      emit({ type: 'tool', text: `○ Tool-turn limit (${maxToolTurns}) reached — stopping safely` });
      break;
    }
    turns++;
    const step = await execIntent(intent, ctx);
    steps.push(step);
    if (step.cancelled || step.blocked) break;
    if (step.needsApproval || step.rejected) break; // surface to caller; nothing applied on reject
  }
  const evidence = steps.map((s, i) =>
    `Step ${i + 1} (${(s.intent && s.intent.tool) || '?'}): ${JSON.stringify(s.toolResult || s.answer || (s.rejected ? 'rejected by user' : 'n/a')).slice(0, 3000)}`).join('\n');
  const summarize = (suffix, tokens) => streamModel(localCtx, [
    { role: 'system', content: 'You are BotConnector, a helpful local AI assistant. Summarize what was done from the step results: files read/changed (with paths), approvals, command exit codes. Be concise and faithful.' },
    { role: 'user', content: `Original task: ${task}\n\nStep results:\n${evidence}${suffix}` },
  ], { maxTokens: tokens, signal, onToken: null, debugLog });
  let r = await summarize('', 1024);
  if ((!r.ok && r.reason !== 'cancelled') || !(r.content || '').trim()) {
    // Bounded retry: small reasoning models sometimes spend the whole budget
    // thinking and emit no content. One retry with explicit brevity nudge.
    r = await summarize('\n\nJawab singkat dalam 3 kalimat.', 2048);
  }
  return { steps, turnsUsed: turns, limit: maxToolTurns, answer: r.ok ? r.content : r.reason, session: sess };
}

module.exports = { runTurn, runTask, detectIntent, detectIntents, execIntent, MAX_TOOL_TURNS };
