// Pure view renderers — no I/O, no timers. Used by the live TUI AND the
// acceptance snapshots. Every screen ends with the same compact status bar
// so the model/project/context picture never disappears.
'use strict';
const theme = require('./theme.cjs');
const layout = require('./layout.cjs');
const activityMod = require('./activity.cjs');
const doctor = require('../doctor.cjs');

function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const gb = n / 1e9;
  return gb >= 1 ? `${gb.toFixed(gb >= 10 ? 0 : 1)}GB` : `${Math.round(n / 1e6)}MB`;
}

function friendlyProject(s) {
  return s.project || (s.workspace ? s.workspace.split(/[\\/]/).pop() : 'workspace');
}

function accelLabel(m) {
  if (m.locality !== 'Local') return '';
  return m.backend && /vulkan|cuda|rocm|gpu|metal/i.test(m.backend) ? 'GPU' : 'CPU';
}

// ---- status bar: one compact line, no duplicate fields, responsive ----
function statusBar(s) {
  const m = s.model;
  const pct = Math.max(0, Math.min(999, Math.round(((s.usedTokens || 0) / (s.runtime.nCtx || 1)) * 100)));
  const modelSeg = m.locality === 'Local'
    ? `${m.name} · Local${accelLabel(m) ? ' ' + accelLabel(m) : ''}`
    : `${m.name} · Cloud`;
  if (layout.isNarrow())
    return layout.truncate(`${modelSeg} · ${s.mode} · ${pct}%`, layout.width() - 2);
  const projectSeg = `${friendlyProject(s)} · ${s.mode}`;
  return [modelSeg, projectSeg, `Context ${pct}%`].join('     ');
}

function wrapText(text, w) {
  w = Math.max(20, w);
  const out = [];
  for (const para of String(text == null ? '' : text).split('\n')) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? line + ' ' + word : word;
      if (next.length > w) { if (line) out.push(line); line = word; }
      else line = next;
    }
    if (line) out.push(line);
  }
  return out;
}

function visibleLength(text) {
  return String(text == null ? '' : text).replace(/\x1b\[[0-9;]*m/g, '').length;
}

// ---- home: one persistent bottom composer, a top-filling scrollback of
// the real conversation (sess.messages), compact (unboxed) message
// presentation, and a single-line footer. No right sidebar by default —
// this is a deliberate, spec-driven replacement of the earlier two-input,
// permanent-sidebar layout (see PHASE: BOTCONNECTOR TUI UX POLISH). ----

const COMPOSER_PLACEHOLDER = 'Ask anything…  @ files  / commands';

// Compact chat line: a colored role label, then the wrapped content
// indented under it — no border. Borders stay reserved for approvals/
// diffs/commands/errors, which already have their own dedicated views.
function renderMessage(role, content, w) {
  const label = role === 'user' ? 'You' : 'BotConnector';
  const color = role === 'user' ? theme.cyan : theme.green;
  const out = [color(label)];
  for (const l of wrapText(content, w)) out.push('  ' + l);
  out.push('');
  return out;
}

// One compact footer line: mode, model+accel, raw context usage, cost —
// each field appears exactly once (no duplication with the header).
function homeFooter(s) {
  const m = s.model;
  const modelSeg = m.locality === 'Local'
    ? `${m.name} · Local${accelLabel(m) ? ' ' + accelLabel(m) : ''}`
    : `${m.name} · Cloud`;
  const costSeg = m.locality === 'Local' ? 'Local' : (m.cost || '—');
  const parts = [s.mode, modelSeg, `Context ${s.usedTokens || 0}/${s.runtime.nCtx || 0}`, costSeg];
  return layout.truncate(parts.join('  │  '), layout.width() - 2);
}

// Builds the full home frame once (lines + where the real terminal cursor
// belongs) so `home()` (string, for every existing caller) and
// `homeCursor()` (row/col, for the live TUI only) never compute the
// layout two different ways and drift apart.
function buildHomeFrame(s, sess, activity = [], answer = '', opts = {}) {
  const w = layout.width();
  const rows = (process.stdout && process.stdout.rows) || 24;
  const narrow = layout.isNarrow();
  const contentWidth = Math.max(20, w - 4);
  const m = s.model;

  // ---- header: 2 compact lines, no decorative chrome ----
  const headerLeft = `${friendlyProject(s)} · ${s.mode}`;
  const headerRight = `${m.name} · ${m.locality === 'Local' ? 'Local' : 'Cloud'}`;
  const header2 = narrow ? layout.truncate(headerLeft, w - 2) : layout.spread(headerLeft, headerRight, w - 2);

  // ---- composer: the one and only input surface, pinned to the bottom ----
  const boxWidth = Math.max(10, w - 2);
  const innerW = Math.max(4, boxWidth - 4);
  const composerTop = '┌' + '─'.repeat(Math.max(0, boxWidth - 2)) + '┐';
  const composerBottom = '└' + '─'.repeat(Math.max(0, boxWidth - 2)) + '┘';
  let composerContent, cursorTextLen;
  if (!s.input) {
    composerContent = [theme.dim(layout.pad(COMPOSER_PLACEHOLDER, innerW))];
    cursorTextLen = 0;
  } else {
    const wrapped = wrapText(s.input, innerW);
    composerContent = wrapped.slice(-6).map((line) => layout.pad(line, innerW));
    cursorTextLen = wrapped.length ? wrapped[wrapped.length - 1].length : 0;
  }

  // ---- conversation body: real transcript from sess.messages, compact.
  // `conversationViewport.offset` is the zero-based rendered-line index of
  // the first visible conversation row. It is deliberately a rendered-line
  // offset (not a message index), because wrapping and activity lines can
  // make one message occupy several rows. `atBottom` is the live-follow
  // mode; when true the offset is derived from the current body height.
  const messages = (sess && sess.messages) || [];
  const hasAny = messages.length || opts.pendingPrompt || answer || (activity && activity.length);
  const body = [];
  if (!hasAny) {
    body.push('What do you want to build?');
    body.push('');
  } else {
    for (const msg of messages) body.push(...renderMessage(msg.role, msg.content, contentWidth));
    if (opts.pendingPrompt) {
      body.push(...renderMessage('user', opts.pendingPrompt, contentWidth));
      if (opts.generating) {
        const lines = activityMod.humanize(activity || [], { debug: opts.debug || (s.settings && (s.settings.debugMode || s.settings.showDetails)) }).slice(-4);
        for (const l of lines) body.push('  ' + theme.dim(l));
        if (lines.length) body.push('');
      }
      if (answer) body.push(...renderMessage('assistant', answer, contentWidth));
    }
  }

  const topBlock = ['', '  ' + theme.bold('BotConnector AI'), '  ' + theme.dim(header2), ''];
  const popoverLines = opts.composerPopover ? composerPopover(opts.composerPopover) : [];
  const bottomBlockLen = 1 + popoverLines.length + 1 + composerContent.length + 1 + 1 + 1; // blank+popover+top+content+bottom+blank+footer
  const viewport = opts.conversationViewport || {};
  const showUnseen = viewport.atBottom === false && Number(viewport.unseenOutputCount || 0) > 0;
  const indicatorRows = showUnseen ? 1 : 0;
  const availableBodyRows = Math.max(3, rows - topBlock.length - bottomBlockLen - indicatorRows);
  const conversationMaxStart = Math.max(0, body.length - availableBodyRows);
  const conversationStart = viewport.atBottom === false
    ? Math.min(conversationMaxStart, Math.max(0, Number(viewport.offset) || 0))
    : conversationMaxStart;
  const bodyDisplay = body.slice(conversationStart, conversationStart + availableBodyRows);
  while (bodyDisplay.length < availableBodyRows) bodyDisplay.push('');
  const bodyLines = bodyDisplay.map((l) => (l ? '  ' + l : ''));
  if (conversationMaxStart > 0) {
    // A one-column scrollbar belongs to the conversation body only. It is
    // omitted when all rendered rows fit, preserving the accepted composer
    // width and the narrow-terminal layout.
    const thumbRows = Math.max(1, Math.round(availableBodyRows * availableBodyRows / body.length));
    const thumbStart = Math.round((availableBodyRows - thumbRows) * conversationStart / conversationMaxStart);
    for (let i = 0; i < bodyLines.length; i++) {
      const marker = i >= thumbStart && i < thumbStart + thumbRows ? '┃' : '│';
      bodyLines[i] += ' '.repeat(Math.max(1, w - 1 - visibleLength(bodyLines[i]))) + theme.dim(marker);
    }
  }

  const L = [...topBlock, ...bodyLines, ''];
  if (showUnseen) L.splice(L.length - 1, 0, '  ' + theme.dim(`↓ ${viewport.unseenOutputCount} new line${viewport.unseenOutputCount === 1 ? '' : 's'}`));
  if (popoverLines.length) L.push(...popoverLines);
  L.push('  ' + composerTop);
  const cursorRow = L.length + composerContent.length; // the last content row always holds the cursor
  for (const c of composerContent) L.push('  │ ' + c + ' │');
  L.push('  ' + composerBottom);
  L.push('');
  L.push('  ' + theme.dim(homeFooter(s)));

  const cursorCol = 5 + cursorTextLen; // 2 margin + '│ ' (2) + chars typed so far, 1-indexed
  return {
    lines: L, cursorRow, cursorCol,
    conversationBodyLength: body.length,
    conversationStart,
    conversationMaxStart,
    availableBodyRows,
  };
}

// Shared contextual suggestion layer for the persistent composer. It is
// deliberately part of the home frame rather than a replacement screen, so
// the transcript and the canonical composer cursor remain intact.
function composerPopover(p = {}) {
  const items = p.filtered || p.items || [];
  const rows = (process.stdout && process.stdout.rows) || 24;
  const maxRows = Math.max(1, Math.min(p.maxRows || 8, rows <= 24 ? 5 : rows <= 30 ? 6 : 8));
  const outerWidth = Math.min(Math.max(24, layout.width() - 2), 72);
  const innerWidth = Math.max(20, outerWidth - 4);
  const contentWidth = innerWidth - 2;
  const box = (text) => '  │ ' + layout.pad(layout.truncate(text, contentWidth), contentWidth) + ' │';
  const L = ['  ┌' + '─'.repeat(innerWidth) + '┐', box(p.title || 'Commands')];

  if (!items.length) {
    L.push(box('No matches'));
  } else {
    const count = Math.min(maxRows, items.length);
    const selectedIndex = Math.max(0, Math.min(p.index || 0, items.length - 1));
    const start = Math.min(Math.max(0, selectedIndex - count + 1), Math.max(0, items.length - count));
    for (let n = 0; n < count; n++) {
      const i = start + n;
      const it = items[i];
      const selected = i === selectedIndex;
      const name = it.name || it.label || '';
      const detail = it.description || [it.provider, it.status, it.detail].filter(Boolean).join('   ');
      const nameWidth = Math.min(12, Math.max(8, contentWidth - 18));
      const row = (selected ? '> ' : '  ') + layout.pad(name, nameWidth) + (detail ? ' ' + detail : '');
      L.push(box(row));
    }
  }
  L.push('  └' + '─'.repeat(innerWidth) + '┘');
  return L;
}

function home(s, sess, activity = [], answer = '', opts = {}) {
  return buildHomeFrame(s, sess, activity, answer, opts).lines.join('\n');
}

// Real-terminal cursor position for the home screen's composer (1-indexed
// row/col) — the live TUI moves the actual terminal cursor here after
// every redraw so it never gets stranded on a bygone `>` prompt line.
function homeCursor(s, sess, activity = [], answer = '', opts = {}) {
  const { cursorRow, cursorCol } = buildHomeFrame(s, sess, activity, answer, opts);
  return { row: cursorRow, col: cursorCol };
}

// ---- generic list picker (model / project / palette / sessions) ----
function picker(s, p) {
  const items = p.filtered || p.items || [];
  const L = ['', '  ' + theme.bold(p.title)];
  if (p.showFilter) L.push('  ' + theme.dim('Search: ') + (p.filter || theme.dim('type to filter')));
  L.push('');
  if (!items.length) L.push('  ' + theme.dim('No matches'));
  items.forEach((it, i) => {
    const cursor = i === p.index ? '›' : ' ';
    const mark = it.active ? '●' : ' ';
    const left = `${cursor} ${mark} ${it.label}`;
    const right = [it.provider, it.status].filter(Boolean).join('   ');
    L.push('  ' + layout.spread(left, right, layout.width() - 2));
    if (it.detail && i === p.index) L.push('      ' + theme.dim(it.detail));
    if (it.disabled && i === p.index && it.disabledReason) L.push('      ' + theme.dim(it.disabledReason));
  });
  L.push('');
  L.push('  ' + (p.hint || 'Up/Down move · Enter select · Esc cancel'));
  L.push('');
  L.push('  ' + statusBar(s));
  return L.join('\n');
}

function diffView(s, d = {}) {
  const L = ['', '  ' + theme.bold('Changes'), ''];
  if (!d.ok) {
    L.push('  ' + theme.dim(d.error || 'Not a Git repository'));
    L.push(''); L.push('  Esc close'); L.push(''); L.push('  ' + statusBar(s));
    return L.join('\n');
  }
  L.push('  ' + theme.dim(`All [${d.files?.length || 0}]   Staged   Unstaged   Untracked`));
  L.push('  ' + theme.dim('A/S/U/N filter · Up/Down move · Enter open · Esc close'));
  L.push('');
  if (!d.files?.length) L.push('  ' + theme.dim('Working tree clean.'));
  else d.files.forEach((f, i) => {
    const mark = i === (d.index || 0) ? '›' : ' ';
    const stat = `+${f.added || 0} -${f.removed || 0}`;
    L.push(`  ${mark} ${f.code} ${layout.truncate(f.path, Math.max(12, layout.width() - 22))}  ${theme.dim(stat)}`);
  });
  L.push(''); L.push('  ' + statusBar(s));
  return L.join('\n');
}

function diffDetailView(s, d = {}) {
  const file = d.files?.[d.index || 0];
  const L = ['', '  ' + theme.bold('Diff')];
  if (file) {
    L.push('', '  ' + file.path, '');
    const lines = String(file.patch || 'No patch available').split(/\r?\n/).slice(0, Math.max(8, ((process.stdout && process.stdout.rows) || 24) - 8));
    for (const line of lines) L.push('  ' + (line.startsWith('+') ? theme.green(line) : line.startsWith('-') ? theme.red(line) : theme.dim(line)));
  } else L.push('', '  ' + theme.dim('No file selected'));
  L.push('', '  Esc back · Up/Down file', '', '  ' + statusBar(s));
  return L.join('\n');
}

function mcpDetailView(s, server = {}) {
  const L = ['', '  ' + theme.bold('MCP server'), ''];
  if (server.name) {
    const row = (k, v) => L.push('  ' + layout.spread(k, String(v == null || v === '' ? '—' : v), layout.width() - 2));
    row('Name', server.name); row('Transport', server.transport || 'stdio'); row('Command', server.command);
    row('Status', server.enabled === false ? 'Disabled' : 'Configured');
    row('Tools', (server.allowedTools || []).join(', ') || 'none allowlisted');
    row('Resources', 'not reported by current TUI client'); row('Prompts', 'not reported by current TUI client');
    row('Scope', server.provenance || 'user settings');
    if (server.notes) { L.push('', '  ' + theme.dim(server.notes)); }
  } else L.push('  ' + theme.dim('No MCP server selected'));
  L.push('', '  Esc back', '', '  ' + statusBar(s));
  return L.join('\n');
}

function integrationDetailView(s, integration = {}, actions = []) {
  const row = (k, v) => '  ' + layout.spread(k, String(v == null || v === '' ? '—' : v), layout.width() - 2);
  const L = ['', '  ' + theme.bold(integration.name || 'Integration'), ''];
  L.push(row('Status', integration.status || 'Unknown'));
  L.push(row('Executable', integration.executable || 'not found'));
  L.push(row('Protocol', integration.protocol || '—'));
  L.push(row('Model', integration.model || s.model.name || 'Auto'));
  L.push(row('Endpoint', integration.endpoint || 'BotConnector gateway'));
  L.push(row('Workspace', s.workspace || 'current project'));
  if (integration.disabledReason) L.push('', '  ' + theme.dim(integration.disabledReason));
  if (integration.description) L.push('', '  ' + theme.dim(integration.description));
  L.push('', '  ' + theme.bold('Actions'));
  (actions.length ? actions : [{ label: 'Launch', _launchAction: 'launch' }]).forEach((item, i) => {
    L.push(`  ${i === (integration.index || 0) ? '›' : ' '} ${item.label}${item.detail ? '  ' + theme.dim(item.detail) : ''}${item.disabled ? '  ' + theme.dim(item.disabledReason || 'disabled') : ''}`);
  });
  L.push('', '  Up/Down move · Enter select · Esc back', '', '  ' + statusBar(s));
  return L.join('\n');
}

function sessionTimelineView(s, sess, t = {}) {
  const rows = t.messages || [];
  const L = ['', '  ' + theme.bold(`Timeline · ${sess.title || 'Session'}`), ''];
  if (sess.parentSessionId) L.push('  ' + theme.dim(`Fork of ${sess.parentSessionId} at ${sess.forkedFromMessageId || 'current'}`), '');
  if (!rows.length) L.push('  ' + theme.dim('No messages in this session.'));
  const max = Math.max(6, ((process.stdout && process.stdout.rows) || 24) - 9);
  const selected = Math.max(0, Math.min(t.index || 0, rows.length - 1));
  const start = Math.min(Math.max(0, selected - max + 1), Math.max(0, rows.length - max));
  for (let n = start; n < Math.min(rows.length, start + max); n++) {
    const m = rows[n]; const who = m.role === 'user' ? 'You' : 'BotConnector';
    const text = String(m.content || '').replace(/\s+/g, ' ').trim();
    L.push(`  ${n === selected ? '›' : ' '} #${n + 1}  ${layout.pad(who, 13)} ${layout.truncate(text, Math.max(18, layout.width() - 23))}`);
  }
  L.push('', '  Up/Down move · Enter jump · F fork · C copy · Esc composer', '', '  ' + statusBar(s));
  return L.join('\n');
}

function commandsView(s, commands = [], query = '') {
  const groups = new Map();
  for (const c of commands) { if (!groups.has(c.source)) groups.set(c.source, []); groups.get(c.source).push(c); }
  const L = ['', '  ' + theme.bold('Commands'), query ? `  ${theme.dim('Search: ' + query)}` : ''];
  const maxRows = Math.max(5, ((process.stdout && process.stdout.rows) || 24) - 9); let used = 0; let truncated = false;
  for (const [source, rows] of groups) {
    if (used >= maxRows) { truncated = true; break; }
    L.push('', '  ' + theme.cyan(source === 'PROJECT_COMMAND' ? 'Project' : source === 'SKILL' ? 'Skills' : source));
    for (const c of rows) {
      if (used >= maxRows) { truncated = true; break; }
      const left = `${c.slash}  ${c.title}`; const right = layout.truncate(c.description || '', Math.max(12, layout.width() - left.length - 8));
      L.push('    ' + layout.truncate(`${left}${right ? '  ' + right : ''}`, Math.max(20, layout.width() - 6))); used++;
    }
  }
  if (truncated) L.push('', '  ' + theme.dim('More commands available — type to search.'));
  L.push('', '  Type to search · Esc composer', '', '  ' + statusBar(s));
  return L.join('\n');
}

function textInputView(s, title, label, value, hint) {
  const prefix = `  ${label} `;
  return { screen: ['', '  ' + theme.bold(title), '', prefix + value, '', '  ' + theme.dim(hint || 'Enter confirm · Esc cancel'), '', '  ' + statusBar(s)].join('\n'), cursor: { row: 4, col: prefix.length + value.length + 1 } };
}

function choiceView(s, title, items, index = 0, hint = 'Up/Down move · Enter select · Esc cancel') {
  const L = ['', '  ' + theme.bold(title), ''];
  for (let i = 0; i < items.length; i++) L.push(`  ${i === index ? '›' : ' '} ${items[i].label || items[i]}${items[i].detail ? '  ' + theme.dim(items[i].detail) : ''}${items[i].disabled ? '  ' + theme.dim(items[i].disabledReason || 'disabled') : ''}`);
  L.push('', '  ' + hint, '', '  ' + statusBar(s));
  return L.join('\n');
}

// ---- approvals: diff / create / delete / rename / command ----
function renderDiffLines(body) {
  const out = [];
  for (const l of String(body || '').split('\n')) {
    if (l.startsWith('--- a/') || l.startsWith('+++ b/')) continue;
    if (/^\(-?\d+ \/ \+?\d+ lines\)$/.test(l) || /more diff lines\)$/.test(l)) { out.push(theme.dim(l)); continue; }
    if (l.startsWith('-')) out.push(theme.red(l));
    else if (l.startsWith('+')) out.push(theme.green(l));
    else out.push(theme.dim(l));
  }
  return out;
}

function fullDiffBody(proposal) {
  if (!proposal || !proposal.diff || !proposal.diff.hunks) return null;
  return proposal.diff.hunks.map((h) => `${h.t} ${h.text}`).join('\n');
}

function parseCommandBody(body) {
  const cmdM = String(body || '').match(/Command:\n([^\n]*)/);
  const cwdM = String(body || '').match(/Working directory:\n([^\n]*)/);
  const dangerM = String(body || '').match(/⚠[^\n]*/);
  return { cmd: cmdM ? cmdM[1] : '', cwd: cwdM ? cwdM[1] : '', danger: dangerM ? dangerM[0] : null };
}

// title/body come straight from the agent loop's approval request — this is
// the presentation boundary that turns them into the boxed approval UX.
function approvalDetail(s, title, body, isCommand, opts = {}) {
  const L = [''];
  if (isCommand) {
    const { cmd, cwd, danger } = parseCommandBody(body);
    L.push('  BotConnector wants to run:');
    L.push('');
    L.push('    ' + theme.bold(cmd || title));
    L.push('');
    L.push('  in ' + (cwd || friendlyProject(s)));
    if (danger) {
      L.push('');
      L.push('  ' + theme.red(theme.bold('⚠ ' + danger.replace(/^⚠\s*/, ''))));
      L.push('  ' + theme.red('This looks destructive — read carefully before running.'));
    }
    L.push('');
    L.push('  [Y] Run    [N] Cancel    [A] Run all remaining this task');
  } else if (/^--- a\//m.test(body || '')) {
    const useFull = opts.full && fullDiffBody(opts.proposal);
    L.push('  ' + theme.bold((opts.proposal && opts.proposal.path) || title.replace(/^Proposed \w+:\s*/, '')));
    L.push('');
    for (const l of renderDiffLines(useFull || body)) L.push('  ' + l);
    L.push('');
    L.push('  Apply this change?');
    L.push('');
    L.push(opts.full
      ? '  [Y] Apply    [N] Reject    [V] Compact view'
      : '  [Y] Apply    [N] Reject    [V] View full diff');
  } else if (/^Create /.test(body || '')) {
    const [header, ...rest] = String(body).split('\n\n');
    L.push('  ' + theme.bold(header));
    L.push('');
    for (const l of rest.join('\n\n').split('\n').slice(0, 20)) L.push('  ' + theme.green('+ ' + l));
    L.push('');
    L.push('  Create this file?');
    L.push('');
    L.push('  [Y] Apply    [N] Reject    [A] Approve all remaining this task');
  } else {
    L.push('  ' + theme.bold(title));
    L.push('');
    for (const l of String(body || '').split('\n')) L.push('  ' + l);
    L.push('');
    L.push('  [Y] Apply    [N] Reject    [A] Approve all remaining this task');
  }
  L.push('');
  L.push('  ' + theme.dim('(nothing changes until you approve)'));
  L.push('');
  L.push('  ' + statusBar(s));
  return L.join('\n');
}

// ---- context ----
function contextNeedsLarger(s, g, recommendedK) {
  const currentK = Math.round((g.nCtx / 1024) * 10) / 10;
  return [
    '',
    '  This model needs a larger working context for agent tasks.',
    '',
    `  Current: ${currentK}K   Recommended: ${recommendedK}K`,
    '',
    '  [R] How to get more context   [C] Continue anyway   [Esc] Cancel',
    '  (won\'t ask again for this model)',
    '',
    '  ' + statusBar(s),
  ].join('\n');
}

function contextGettingFull(s) {
  return [
    '',
    '  Context is getting full.',
    '  BotConnector can reset the working context for this session.',
    '',
    '  [C] Compact    [N] New session    [Esc] Dismiss',
    '',
    '  ' + statusBar(s),
  ].join('\n');
}

// ---- doctor ----
function doctorSummary(s, r, opts = {}) {
  const L = ['', '  ' + theme.bold('Doctor')];
  L.push('');
  for (const line of doctor.summaryLines(r)) {
    if (!line) { L.push(''); continue; }
    const ok = line.startsWith('✓');
    L.push('  ' + (ok ? theme.green(line) : line.startsWith('✗') ? theme.red(line) : line));
  }
  L.push('');
  if (opts.details) {
    L.push('  ' + theme.dim('Details'));
    for (const l of doctor.detailLines(r)) L.push('  ' + theme.dim(l));
    L.push('');
  } else {
    L.push('  ' + theme.dim('/details for exact runtime/model identifiers'));
  }
  L.push('  Esc close');
  L.push('');
  L.push('  ' + statusBar(s));
  return L.join('\n');
}

// ---- settings ----
function settingsView(s) {
  const st = s.settings;
  const rows = [
    ['Default model', s.model.name],
    ['Local runtime', s.runtime.backend],
    ['Context preference', st.contextPreference],
    ['Approval behavior', st.approvalBehavior],
    ['Language', st.language],
    ['Theme', st.theme],
    ['Debug mode', st.debugMode ? 'on' : 'off'],
  ];
  const L = ['', '  ' + theme.bold('Settings')];
  L.push('');
  for (const [k, v] of rows) L.push('  ' + layout.spread(k, String(v), layout.width() - 2));
  L.push('');
  L.push('  ' + theme.dim('Tab: Plan/Act · Shift+Tab: approval · /model: default model · /debug: toggle debug'));
  L.push('  Esc close');
  L.push('');
  L.push('  ' + statusBar(s));
  return L.join('\n');
}

// ---- status (live session picture; /status) ----
function statusView(s, extra = {}) {
  const row = (k, v) => '  ' + layout.spread(k, String(v == null ? '—' : v), layout.width() - 2);
  const L = ['', '  ' + theme.bold('Status'), ''];
  L.push(row('Model', s.model.name));
  L.push(row('Provider', s.model.locality === 'Local' ? (extra.provider || s.model.provider) : s.model.provider));
  L.push(row('Project', friendlyProject(s)));
  L.push(row('Mode', s.mode));
  L.push(row('Approval', s.approval));
  L.push(row('Context', `${s.usedTokens || 0} / ${s.runtime.nCtx} tokens`));
  if (extra.modelId) L.push(row('Model id', extra.modelId));
  if (extra.endpoint) L.push(row('Endpoint', extra.endpoint));
  L.push('');
  L.push('  Esc close');
  L.push('');
  L.push('  ' + statusBar(s));
  return L.join('\n');
}

// ---- errors: actionable, with raw detail on demand ----
function errorView(s, err) {
  const L = ['', '  ' + theme.bold(err.title)];
  L.push('');
  if (err.body) for (const l of String(err.body).split('\n')) L.push('  ' + l);
  L.push('');
  const actions = (err.actions || []).map((a, i) => `[${i + 1}] ${a}`).join('    ');
  L.push('  ' + actions + (actions ? '    ' : '') + '[D] Details');
  if (err.showDetails && err.raw) {
    L.push('');
    for (const l of String(err.raw).split('\n')) L.push('  ' + theme.dim(l));
  }
  L.push('');
  L.push('  ' + statusBar(s));
  return L.join('\n');
}

// ---- first run ----
function firstRunWelcome() {
  return {
    title: 'Welcome to BotConnector AI — set up your local AI',
    items: [
      { label: 'Use recommended model', detail: 'Auto-detects your hardware and downloads a small starter model' },
      { label: 'Choose another model', detail: 'Browse BotConnector Local / Ollama / Cloud' },
      { label: 'Use cloud', detail: 'Skip local setup for now' },
    ],
    index: 0,
    hint: 'Up/Down move · Enter select · Esc skip for now',
  };
}

function firstRunRecommend(s, hw, rec, bytes) {
  return [
    '', '  ' + theme.bold('Recommended for your machine'),
    '',
    `  ${rec.name}  (~${fmtBytes(bytes || rec.approxBytes)})`,
    `  Detected: ${hw.totalRamGB}GB RAM · ${hw.cores || '?'} cores · ${hw.platform}`,
    '',
    '  This downloads once, to your BotConnector models folder.',
    '  Nothing downloads until you approve.',
    '',
    '  [Y] Download    [N] Back',
    '',
    '  ' + statusBar(s),
  ].join('\n');
}

function firstRunProgress(s, rec, progress) {
  const pct = progress.pct || 0;
  return [
    '', `  Downloading ${rec.name}… ${pct}%`,
    '',
    '  ' + layout.bar(pct, 30),
    `  ${fmtBytes(progress.receivedBytes)} / ${fmtBytes(progress.totalBytes)}`,
    '',
    '  Esc cancel',
    '',
    '  ' + statusBar(s),
  ].join('\n');
}

function firstRunDone(s, rec, destPath) {
  return [
    '', '  ' + theme.green('✓ Downloaded'),
    '',
    `  ${rec.name}`,
    `  Saved to ${destPath}`,
    '',
    '  BotConnector\'s local runtime will use this the next time it loads a model.',
    '',
    '  Enter continue',
    '',
    '  ' + statusBar(s),
  ].join('\n');
}

function firstRunFailed(s, reason) {
  return [
    '', '  ' + theme.red('Download failed'),
    '',
    '  ' + reason,
    '',
    '  [R] Retry    [Esc] Back',
    '',
    '  ' + statusBar(s),
  ].join('\n');
}

module.exports = {
  home, homeCursor, homeFrame: buildHomeFrame, statusBar, picker, composerPopover, approvalDetail,
  diffView, diffDetailView, mcpDetailView, integrationDetailView, sessionTimelineView, commandsView,
  textInputView, choiceView,
  contextNeedsLarger, contextGettingFull,
  doctorSummary, settingsView, statusView, errorView,
  firstRunWelcome, firstRunRecommend, firstRunProgress, firstRunDone, firstRunFailed,
  fmtBytes, wrapText, friendlyProject,
};
