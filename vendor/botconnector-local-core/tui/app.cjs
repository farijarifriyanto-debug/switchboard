// Interactive TUI shell — canonical integration. Alternate screen, raw
// keypress events (no polling), human-friendly tool activity, permission
// gates, real first-run setup, real session persistence, real settings
// through canonical Store, real runtime start/stop through canonical
// ownership lock. Terminal-native, single Node process.
'use strict';
const path = require('path');
const readline = require('readline');
const state = require('../state.cjs');
const views = require('./views.cjs');
const loop = require('../agent/loop.cjs');
const tools = require('../agent/tools.cjs');
const ctxGuard = require('../agent/context.cjs');
const local = require('../agent/local.cjs');
const modelSource = require('./model-source.cjs');
const firstRun = require('./first-run.cjs');
const doctorMod = require('../doctor.cjs');
const sessions = require('../sessions.cjs');
const projects = require('../projects.cjs');
const { scanInstalled } = require('../runtime/installed.cjs');
const llama = require('../runtime/llama.cjs');
const { readOwnership, statePath, pidAlive, releaseOwnership } = require('../runtime/ownership.cjs');
const { createCommandRegistry } = require('../registry/commands.cjs');
const agentRegistry = require('../registry/agents.cjs');
const toolRegistry = require('../registry/tools.cjs');
const diffRegistry = require('../registry/diff.cjs');
const mcpRegistry = require('../registry/mcp.cjs');
const journal = require('../agent/journal.cjs');
const { createWorkspace } = require('../agent/tools.cjs');
const shellTool = require('../agent/shell.cjs');
const viewport = require('./viewport.cjs');
const review = require('./review.cjs');
const integrationModule = require('../registry/integrations.cjs');

const ALT_ON = '\x1b[?1049h\x1b[H';
const ALT_OFF = '\x1b[?1049l';
const CLEAR = '\x1b[2J\x1b[H';
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';

async function runTui(opts = {}) {
  const s = state.load();
  s.input = '';
  s.workspace = opts.workspace || opts.cwd || process.cwd();
  s.project = path.basename(s.workspace) || s.workspace;
  let debug = opts.debug || process.argv.includes('--debug') || s.settings.debugMode;
  const log = (...a) => { if (debug) require('fs').appendFileSync('botconnector-debug.log', a.join(' ') + '\n'); };

  projects.touch(s.workspace);
  let sess = await sessions.create({ project: s.project, model: s.model, mode: s.mode });

  let pendingWarning = null;
  const g = ctxGuard.guard({ nCtx: s.runtime.nCtx, plannedUserTokens: 3000 });
  if (!g.ok) pendingWarning = g.warning;

  const out = process.stdout;
  const canRaw = out.isTTY && process.stdin.isTTY;
  if (!canRaw) {
    console.log(views.home(s, sess));
    if (pendingWarning) console.log(pendingWarning);
    return;
  }
  process.stdout.write(ALT_ON + MOUSE_ON);
  const restore = () => process.stdout.write(MOUSE_OFF + ALT_OFF);
  process.on('exit', restore);
  process.on('SIGINT', () => { restore(); process.exit(0); });

  let activity = [];
  let answer = '';
  let pendingPrompt = '';
  let overlay = null;
  let pickerState = null;
  let slashMenuOpen = false;
  let slashSelectionIndex = 0;
  let approvalReq = null, approvalResolve = null;
  let diffFull = false;
  let doctorResult = null, doctorDetails = false;
  let statusExtra = {};
  let errorState = null;
  let pendingGuard = null;
  let ctxFullShown = false;
  let firstRunHw = null, firstRunRec = null, firstRunResolved = null, firstRunError = null;
  let firstRunProgressState = { pct: 0, downloadedBytes: 0, totalBytes: 0, status: '' };
  let firstRunJobId = null;
  let runtimeStoppedInfo = null;
  const taskSession = { approveAll: false };
  let generating = false, genAbort = null;
  let activeSkill = null;
  let diffState = null;
  let mcpState = null;
  let timelineState = null;
  let reviewState = null;
  let reviewAbort = null;
  let reviewWatchdog = null;
  let reviewCancelRequested = false;
  let commandRegistry;
  let integrationRegistry;
  let launchDetailIntegration = null;
  // The offset is the zero-based rendered-line index at the top of the
  // conversation viewport. It is not a message index: wrapped messages and
  // streaming activity can occupy multiple rows. At bottom means live-follow.
  let conversationScrollOffset = 0;
  let conversationAtBottom = true;
  let unseenOutputCount = 0;
  let conversationBodyLength = 0;
  let conversationMaxStart = 0;
  let conversationViewportRows = 1;

  function resetConversationViewport() {
    conversationScrollOffset = 0;
    conversationAtBottom = true;
    unseenOutputCount = 0;
    conversationBodyLength = 0;
    conversationMaxStart = 0;
  }

  function renderHome(composerPopover) {
    const composerOpts = {
      debug, generating, pendingPrompt, composerPopover,
      conversationViewport: {
        offset: conversationScrollOffset,
        atBottom: conversationAtBottom,
        unseenOutputCount,
      },
    };
    let frame = views.homeFrame(s, sess, activity, answer, composerOpts);
    // New streamed/rendered rows accumulate below a scrolled viewport. Rebuild
    // once after accounting for them so the indicator appears in the same
    // frame as the new output without moving the viewport.
    if (!conversationAtBottom && frame.conversationBodyLength > conversationBodyLength) {
      unseenOutputCount += frame.conversationBodyLength - conversationBodyLength;
      composerOpts.conversationViewport.unseenOutputCount = unseenOutputCount;
      frame = views.homeFrame(s, sess, activity, answer, composerOpts);
    }
    if (conversationAtBottom) unseenOutputCount = 0;
    conversationScrollOffset = frame.conversationStart;
    conversationBodyLength = frame.conversationBodyLength;
    conversationMaxStart = frame.conversationMaxStart;
    conversationViewportRows = frame.availableBodyRows;
    return { screen: frame.lines.join('\n'), cursor: views.homeCursor(s, sess, activity, answer, composerOpts) };
  }

  const draw = () => {
    let screen;
    let cursor = null;
    if (overlay === 'composer-picker') {
      ({ screen, cursor } = renderHome(pickerState));
    } else if (overlay === 'picker') screen = views.picker(s, pickerState);
    else if (overlay === 'diff') screen = views.diffView(s, diffState);
    else if (overlay === 'diff-detail') screen = views.diffDetailView(s, diffState);
    else if (overlay === 'mcp-detail') screen = views.mcpDetailView(s, mcpState);
    else if (overlay === 'timeline') screen = views.sessionTimelineView(s, sess, timelineState || {});
    else if (overlay === 'commands') screen = views.commandsView(s, commandRegistry ? commandRegistry.filter(timelineState?.query || '') : [], timelineState?.query || '');
    else if (overlay === 'choice' && pickerState?.kind === 'launch-detail') screen = views.integrationDetailView(s, { ...pickerState.integration, index: pickerState.index, model: s.model.name, endpoint: 'BotConnector gateway' }, pickerState.filtered || pickerState.items || []);
    else if (overlay === 'choice') screen = views.choiceView(s, pickerState.title, pickerState.filtered || pickerState.items || [], pickerState.index || 0, pickerState.hint);
    else if (overlay === 'text-input') ({ screen, cursor } = views.textInputView(s, pickerState.title, pickerState.label, s.input, pickerState.hint));
    else if (overlay === 'review') screen = renderReview();
    else if (overlay === 'project-browse') ({ screen, cursor } = renderProjectBrowse());
    else if (overlay === 'settings-edit') ({ screen, cursor } = renderSettingsEdit());
    else if (overlay === 'approve-diff' && approvalReq) screen = views.approvalDetail(s, approvalReq.title, approvalReq.detail, false, { proposal: approvalReq.proposal, full: diffFull });
    else if (overlay === 'approve-command' && approvalReq) screen = views.approvalDetail(s, approvalReq.title, approvalReq.detail, true);
    else if (overlay === 'context-needs-larger') screen = views.contextNeedsLarger(s, pendingGuard, recommendCtxK(pendingGuard.required));
    else if (overlay === 'context-full') screen = views.contextGettingFull(s);
    else if (overlay === 'doctor') screen = views.doctorSummary(s, doctorResult || {}, { details: doctorDetails });
    else if (overlay === 'settings') screen = views.settingsView(s);
    else if (overlay === 'status') screen = views.statusView(s, statusExtra);
    else if (overlay === 'error') screen = views.errorView(s, errorState);
    else if (overlay === 'runtime-stopped') screen = renderRuntimeStopped();
    else if (overlay === 'first-run-recommend') screen = renderFirstRunRecommend();
    else if (overlay === 'first-run-progress') screen = renderFirstRunProgress();
    else if (overlay === 'first-run-done') screen = renderFirstRunDone();
    else if (overlay === 'first-run-failed') screen = views.firstRunFailed(s, firstRunError);
    else {
      const composerPopover = slashMenuOpen ? {
          type: 'command', title: 'Commands', items: applySlashFilter(), index: slashSelectionIndex,
        } : null;
      ({ screen, cursor } = renderHome(composerPopover));
    }
    // Move the REAL terminal cursor into whichever input surface is live,
    // instead of leaving it wherever the last printed character happened
    // to land (previously: always after the footer, i.e. nowhere near the
    // composer). Every overlay branch above either supplies its own
    // {screen, cursor} or falls through with cursor=null (no live input
    // on that screen), so this always reflects the truth.
    out.write(CLEAR + screen + (cursor ? `\x1b[${cursor.row};${cursor.col}H` : ''));
  };

  // A single-line labeled prompt used by the two small ad-hoc dialogs
  // below (folder path / settings key=value) — same idea as the home
  // composer: one clearly-labeled input surface, cursor parked right
  // after the typed text, never a bare standalone `>`.
  function labeledPromptLine(label, value) {
    const prefix = '  ' + label + ' ';
    return { line: prefix + value, col: prefix.length + value.length + 1 };
  }

  function renderProjectBrowse() {
    const p = labeledPromptLine('Path:', s.input);
    const lines = ['', '  Open project', '', '  Enter a folder path:', '', p.line, '', '  Enter confirm · Esc cancel', '', '  ' + views.statusBar(s)];
    return { screen: lines.join('\n'), cursor: { row: 6, col: p.col } };
  }

  function renderSettingsEdit() {
    const p = labeledPromptLine('Setting:', s.input);
    const lines = [
      '', '  Change a setting',
      '', '  theme <auto|dark|light>   language <system|en|id>   context <auto|manual>   debug <on|off>',
      '', p.line,
      '', '  Enter apply · Esc cancel',
      '', '  ' + views.statusBar(s),
    ];
    return { screen: lines.join('\n'), cursor: { row: 6, col: p.col } };
  }

  function renderRuntimeStopped() {
    const L = ['', '  Local AI is stopped.', ''];
    if (runtimeStoppedInfo && runtimeStoppedInfo.busyOwner) L.push(`  Owned by ${runtimeStoppedInfo.busyOwner} — stop it there first.`, '');
    L.push('  [S] Start    [M] Change model    [D] Details    [Esc] Close');
    L.push('', '  ' + views.statusBar(s));
    return L.join('\n');
  }

  function renderFirstRunRecommend() {
    if (!firstRunRec || !firstRunRec.recommendation) {
      return ['', '  No suitable local model found for this hardware.', '', '  [N] Use cloud instead    [Esc] Cancel', '', '  ' + views.statusBar(s)].join('\n');
    }
    const m = firstRunRec.recommendation.model;
    const hw = firstRunRec.hardware;
    const sizeNote = firstRunResolved ? `~${firstRunResolved.group.size ? (firstRunResolved.group.size / 1e9).toFixed(1) + 'GB' : m.download_size_gb + 'GB'}` : `~${m.download_size_gb}GB (checking exact size…)`;
    return [
      '', '  Recommended for your machine',
      '', `  ${m.name}  (${sizeNote})`,
      `  ${m.category} · ${firstRunRec.recommendation.fit.label}`,
      `  Detected: ${hw.ramGb}GB RAM · ${hw.cpu.trim()}${hw.nvidia.length ? ' · ' + hw.nvidia[0].name : ''}`,
      `  Acceleration: ${hw.nvidia.length ? 'CUDA (NVIDIA)' : 'Vulkan (auto-selected if available, else CPU)'}`,
      '', '  This downloads once, to your BotConnector models folder. Nothing downloads until you approve.',
      '', '  [Y] Download    [A] See alternatives    [N] Use cloud instead    [Esc] Cancel',
      '', '  ' + views.statusBar(s),
    ].join('\n');
  }

  function renderFirstRunProgress() {
    const p = firstRunProgressState;
    const pct = p.pct || (p.totalBytes ? Math.round((p.downloadedBytes / p.totalBytes) * 100) : 0);
    const fmtB = (n) => !n ? '0MB' : (n / 1e9 >= 1 ? (n / 1e9).toFixed(1) + 'GB' : Math.round(n / 1e6) + 'MB');
    return [
      '', `  ${p.status === 'installing-runtime' ? 'Installing runtime…' : `Downloading ${firstRunRec.recommendation.model.name}… ${pct}%`}`,
      '', '  ' + '█'.repeat(Math.round(pct / 100 * 30)) + '░'.repeat(30 - Math.round(pct / 100 * 30)),
      p.status !== 'installing-runtime' ? `  ${fmtB(p.downloadedBytes)} / ${fmtB(p.totalBytes)}` : `  ${p.note || ''}`,
      '', '  Esc cancel',
      '', '  ' + views.statusBar(s),
    ].join('\n');
  }

  function renderFirstRunDone() {
    return [
      '', '  Model ready — starting chat…',
      '', `  ${firstRunRec.recommendation.model.name}`,
      '', '  Enter continue',
      '', '  ' + views.statusBar(s),
    ].join('\n');
  }

  function recommendCtxK(requiredTokens) {
    const tiers = [4, 8, 16, 32, 64];
    const needK = (requiredTokens || 0) / 1024;
    return tiers.find((k) => k >= needK) || Math.ceil(needK);
  }

  function relTime(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function applyFilter(ps) {
    const f = (ps.filter || '').toLowerCase();
    ps.filtered = !f ? ps.items : ps.items.filter((it) => (it.label + ' ' + (it.provider || '')).toLowerCase().includes(f));
    if (ps.index >= ps.filtered.length) ps.index = Math.max(0, ps.filtered.length - 1);
  }

  function applySlashFilter() {
    const commands = commandRegistry ? commandRegistry.filter(s.input.slice(1)) : [];
    slashSelectionIndex = Math.min(slashSelectionIndex, Math.max(0, commands.length - 1));
    return commands.map((command) => ({
      name: command.slash,
      description: command.description + (command.available === false ? ` · ${command.disabledReason}` : ''),
      disabled: command.available === false,
      _command: command,
    }));
  }

  function openSlashMenu() {
    commandRegistry.refresh();
    slashMenuOpen = true;
    slashSelectionIndex = 0;
    draw();
  }

  async function persistSettings() { await state.save(s); }

  function setMode(newMode) {
    if (s.mode === newMode) { draw(); return; }
    s.mode = newMode;
    persistSettings();
    activity.push(`✓ Switched to ${newMode} mode`);
    draw();
  }

  function showPermissionsInfo() {
    answer = `Approval: ${s.approval} · Shift+Tab toggles ask ↔ full-auto (full-auto is explicit opt-in).`;
    draw();
  }

  async function doNew() {
    activity = []; answer = ''; s.usedTokens = 0; ctxFullShown = false;
    sess = await sessions.create({ project: s.project, model: s.model, mode: s.mode });
    resetConversationViewport();
    draw();
  }

  function maybeShowContextFull() {
    const pct = (s.usedTokens || 0) / (s.runtime.nCtx || 1);
    if (pct >= 0.8 && !ctxFullShown && overlay === null) {
      ctxFullShown = true;
      overlay = 'context-full';
    }
  }

  function showError(err) {
    errorState = Object.assign({ showDetails: false }, err);
    overlay = 'error';
    draw();
  }

  function setProject(p) {
    s.workspace = p;
    s.project = path.basename(p) || p;
    projects.touch(p);
    commandRegistry = createCommandRegistry({ workspace: s.workspace, gitAvailable: diffRegistry.isGitRepository(s.workspace), journalStatus: () => journal.status({ workspace: s.workspace, sessionId: sess.id }), mcpPrompts: () => mcpRegistry.listConfigured(s.store).flatMap((server) => Array.isArray(server.prompts) ? server.prompts.map((prompt) => ({ ...prompt, server: server.name })) : []) });
    integrationRegistry = integrationModule.createIntegrationRegistry({ cwd: s.workspace, env: process.env, platform: process.platform });
    activity.push(`✓ Project: ${s.project}`);
  }

  function openPalette() {
    commandRegistry.refresh();
    const commands = commandRegistry.filter('', { includeDisabled: true });
    pickerState = {
      kind: 'palette', title: 'Command Palette', showFilter: true, filter: '', index: 0,
      items: commands.map((c) => ({ label: c.title, detail: c.slash + (c.available === false ? ` · ${c.disabledReason}` : ''), disabled: c.available === false, _command: c })),
      hint: 'Type to search · Up/Down move · Enter run · Esc cancel',
    };
    applyFilter(pickerState);
    overlay = 'picker'; draw();
  }

  async function openModelPicker({ contextual = false } = {}) {
    pickerState = { kind: 'model', type: 'model', title: 'Select model', index: 0, contextual, items: [{ label: 'Loading…', disabled: true }], hint: 'Up/Down move · Enter select · Esc cancel' };
    applyFilter(pickerState);
    overlay = contextual ? 'composer-picker' : 'picker'; draw();
    const mine = pickerState;
    const { items } = await modelSource.listModels(s);
    if (pickerState !== mine) return;
    mine.items = items.concat([{ label: 'Find more models…', detail: 'Search Hugging Face (botconnector models search)', disabled: false, _findMore: true }]);
    applyFilter(mine);
    if ((overlay === 'picker' || overlay === 'composer-picker') && pickerState === mine) draw();
  }

  function openProjectPicker({ contextual = false } = {}) {
    const recent = projects.load().filter((p) => p.path !== s.workspace);
    pickerState = {
      kind: 'project', type: 'project', title: 'Open project', index: 0, contextual,
      items: [
        { label: 'Current folder', detail: s.workspace, provider: 'Current', active: true, _action: { type: 'set', path: s.workspace } },
        ...recent.map((p) => ({ label: p.name, detail: p.path, provider: 'Recent', _action: { type: 'set', path: p.path } })),
        { label: 'Browse / enter a path…', _action: { type: 'browse' } },
      ],
      hint: 'Up/Down move · Enter open · Esc cancel',
    };
    applyFilter(pickerState);
    overlay = contextual ? 'composer-picker' : 'picker'; draw();
  }

  function openSessions({ contextual = false } = {}) {
    const list = sessions.list();
    pickerState = {
      kind: 'sessions', type: 'sessions', title: 'Sessions', index: 0, contextual,
      items: list.length
        ? list.map((sx) => ({ label: sx.title, provider: sx.project, status: relTime(sx.lastUsed), detail: `${sx.messageCount} messages · model: ${(sx.model && sx.model.name) || '—'}${sx.parentSessionId ? ' · fork' : ''}`, _action: sx.id, _session: sx }))
        : [{ label: 'No sessions yet', disabled: true }],
      hint: list.length ? 'Enter resume · R rename · F fork · E export · Del delete · Esc close' : 'Esc close',
    };
    applyFilter(pickerState);
    overlay = contextual ? 'composer-picker' : 'picker'; draw();
  }

  function openSettings() { overlay = 'settings'; draw(); }

  function openAgents({ contextual = false } = {}) {
    pickerState = { kind: 'agents', type: 'agents', title: 'Agents', index: 0, contextual,
      items: agentRegistry.discover({ projectRoot: s.workspace }).map((a) => ({ label: a.name, provider: a.mode, detail: a.description, _agent: a })),
      hint: 'Up/Down move · Enter select · Esc close' };
    applyFilter(pickerState); overlay = contextual ? 'composer-picker' : 'picker'; draw();
  }

  function openSkills({ contextual = false } = {}) {
    const rows = commandRegistry.skills();
    pickerState = { kind: 'skills', type: 'skills', title: 'Skills', index: 0, contextual,
      items: rows.length ? rows.map((skill) => ({ label: skill.name, provider: skill.scope, detail: skill.description, _skill: skill })) : [{ label: 'No skills discovered', disabled: true }],
      hint: rows.length ? 'Enter activate · Esc close' : 'Esc close' };
    applyFilter(pickerState); overlay = contextual ? 'composer-picker' : 'picker'; draw();
  }

  function openTools({ contextual = false } = {}) {
    const rows = toolRegistry.discover({ mcp: openMcpConfigs() });
    pickerState = { kind: 'tools', type: 'tools', title: 'Available tools', index: 0, contextual,
      items: rows.map((tool) => ({ label: tool.name, provider: tool.source, detail: tool.description, _tool: tool })),
      hint: 'Esc close' };
    applyFilter(pickerState); overlay = contextual ? 'composer-picker' : 'picker'; draw();
  }

  function openFilePicker() {
    const ws = createWorkspace(s.workspace);
    const result = ws.listDirectory('.');
    const rows = result.ok ? result.entries.map((entry) => ({ label: entry.name + (entry.type === 'dir' ? '/' : ''), provider: entry.type, _file: entry.name })) : [];
    pickerState = { kind: 'files', type: 'files', title: 'Files and context', index: 0, contextual: true,
      items: rows.length ? rows : [{ label: 'No files found', disabled: true }], hint: 'Enter attach path · Esc close' };
    applyFilter(pickerState); overlay = 'composer-picker'; draw();
  }

  function openDiff() {
    diffState = diffRegistry.collect(s.workspace, 'all');
    overlay = 'diff'; draw();
  }

  function openMcpConfigs() {
    return mcpRegistry.listConfigured(s.store);
  }

  function openMcp() {
    const rows = openMcpConfigs();
    pickerState = { kind: 'mcp', type: 'mcp', title: 'MCP servers', index: 0,
      items: rows.length ? rows.map((server) => ({ label: server.name, provider: server.transport || 'stdio', status: server.status, detail: `${server.command} · tools ${server.toolsCount}`, _mcp: server })) : [{ label: mcpRegistry.zeroState().label, detail: mcpRegistry.zeroState().action, disabled: true }],
      hint: 'Enter details · Space toggle · R reconnect · A add · D remove · L auth · Esc close' };
    applyFilter(pickerState); overlay = 'picker'; draw();
  }

  function openLaunch({ contextual = true } = {}) {
    integrationRegistry = integrationRegistry || integrationModule.createIntegrationRegistry({ cwd: s.workspace, env: process.env, platform: process.platform });
    const rows = integrationRegistry.list();
    pickerState = { kind: 'launch', type: 'launch', title: 'Launch', index: 0, contextual,
      items: rows.map((entry) => ({ label: entry.name, provider: entry.category, status: entry.status, detail: entry.description, _integration: entry, disabled: !entry.launchable && entry.status !== integrationModule.STATUS.READY, disabledReason: entry.disabledReason })),
      hint: 'Up/Down move · Enter details · M model · C configure · I install info · Esc back' };
    applyFilter(pickerState); overlay = contextual ? 'composer-picker' : 'picker'; draw();
  }

  function openLaunchDetails(entry) {
    launchDetailIntegration = entry;
    const actions = [
      { label: 'Launch', detail: entry.executable ? 'Start with a process-scoped BotConnector endpoint' : 'Executable not found', _launchAction: 'launch', disabled: !entry.executable || !entry.launchable, disabledReason: entry.disabledReason || 'Install the integration first' },
      { label: 'Choose model', detail: 'Use the existing BotConnector model registry', _launchAction: 'model', disabled: !entry.launchable },
      { label: 'Configure', detail: entry.id === 'opencode' ? 'Backup and update only the BotConnector provider block' : 'No persistent adapter is available', _launchAction: 'configure', disabled: entry.id !== 'opencode' },
      { label: 'Install instructions', detail: 'Show the official installation path; no silent install', _launchAction: 'install' },
      { label: 'Restore original config', detail: 'Restore only fields previously changed by BotConnector', _launchAction: 'restore', disabled: entry.id !== 'opencode' },
    ];
    pickerState = { kind: 'launch-detail', title: entry.name, integration: entry, index: 0, items: actions, hint: 'Up/Down move · Enter select · M model · C configure · I install · Esc back' };
    applyFilter(pickerState); overlay = 'choice'; draw();
  }

  async function runLaunchAction(entry, action) {
    if (action === 'model') { launchDetailIntegration = entry; overlay = null; pickerState = null; await openModelPicker({ contextual: false }); return; }
    if (action === 'install') { answer = `${entry.name}: no silent installer is registered. Install it from the official documentation${entry.docsUrl ? `: ${entry.docsUrl}` : '.'}`; overlay = null; pickerState = null; draw(); return; }
    if (action === 'configure') {
      if (entry.id !== 'opencode') { answer = `${entry.name} has no persistent BotConnector configuration adapter.`; overlay = null; pickerState = null; draw(); return; }
      try { const model = integrationModule.resolveAutoModel({ requested: 'auto', store: s.store }); const result = await integrationRegistry.configureOpenCode({ cwd: s.workspace, endpoint: 'http://127.0.0.1:11435', modelId: model.id, modelName: s.model.name, env: process.env }); answer = result.ok ? `✓ ${entry.name} configured. Original saved locally at ${result.backupPath}.` : `✗ ${result.reason}`; }
      catch (e) { answer = `✗ Configuration failed: ${e.message}`; }
      overlay = null; pickerState = null; draw(); return;
    }
    if (action === 'restore') {
      const result = await integrationRegistry.restoreIntegration({ id: entry.id, cwd: s.workspace, env: process.env }); answer = result.ok ? `✓ Restored ${entry.name} configuration.` : `✗ ${result.reason}`; overlay = null; pickerState = null; draw(); return;
    }
    if (action !== 'launch') return;
    if (entry.id === 'terminal') { answer = 'Already running in the BotConnector Terminal integration.'; overlay = null; pickerState = null; draw(); return; }
    const wasRaw = process.stdin.isRaw;
    try {
      try { process.stdin.setRawMode(false); } catch {}
      process.stdin.pause(); restore();
      const model = integrationModule.resolveAutoModel({ requested: 'auto', store: s.store });
      const result = await integrationModule.launchIntegration(entry, { cwd: s.workspace, endpoint: 'http://127.0.0.1:11435', modelId: model.id, requestedModel: 'auto', modelName: s.model.name, env: process.env });
      answer = result.ok ? `✓ ${entry.name} exited cleanly.` : `✗ ${result.reason || `${entry.name} exited with ${result.exitCode}`}`;
    } catch (e) { answer = `✗ Launch failed: ${e.message}`; }
    finally { process.stdout.write(ALT_ON + MOUSE_ON); process.stdin.resume(); try { process.stdin.setRawMode(wasRaw); } catch {}; overlay = null; pickerState = null; draw(); }
  }

  async function toggleMcp(server) {
    const rows = openMcpConfigs().map((row) => row.id === server.id ? { ...row, enabled: row.enabled === false } : row);
    await s.store.set('mcpServers', rows);
    openMcp();
  }

  function openMcpAdd() {
    pickerState = { kind: 'mcp-add', title: 'Add MCP server', label: 'stdio name command:', hint: 'Example: context7 npx -y @upstash/context7-mcp · Enter save · Esc cancel' };
    s.input = ''; overlay = 'text-input'; draw();
  }

  async function addMcp(value) {
    const bits = String(value || '').trim().split(/\s+/);
    if (bits.length < 2) { answer = '✗ Enter a server name and executable command.'; overlay = null; draw(); return; }
    const name = bits.shift(); const command = bits.shift();
    const checked = mcpRegistry.validateConfig({ id: name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'), name, transport: 'stdio', command, args: bits, enabled: true });
    if (!checked.ok) answer = `✗ ${checked.error}`;
    else { const rows = openMcpConfigs().filter((r) => r.id !== checked.config.id); rows.push(checked.config); await s.store.set('mcpServers', rows); answer = `✓ MCP server ${name} added. Use /mcp to inspect it.`; }
    overlay = null; s.input = ''; draw();
  }

  async function reconnectMcp(server) {
    if (server.transport && server.transport !== 'stdio') { answer = `MCP ${server.name}: ${server.transport} reconnect is not available in the canonical TUI runtime yet.`; openMcp(); return; }
    try {
      const { createMcpClients } = require('../runtime/mcp.cjs');
      const client = createMcpClients([server])[0];
      const listed = await client.listTools(); await client.stop();
      const rows = openMcpConfigs().map((r) => r.id === server.id ? { ...r, status: 'Connected', tools: listed.map((t) => t.name) } : r);
      await s.store.set('mcpServers', rows); answer = `✓ MCP ${server.name} connected (${listed.length} tools).`;
    } catch (e) { answer = `✗ MCP ${server.name} reconnect failed: ${e.message}`; }
    openMcp();
  }

  async function removeMcp(server) {
    const rows = openMcpConfigs().filter((r) => r.id !== server.id); await s.store.set('mcpServers', rows);
    answer = `✓ Removed MCP server ${server.name}.`; openMcp();
  }

  function openTimeline() {
    timelineState = { messages: sessions.timeline(sess), index: 0 };
    overlay = 'timeline'; draw();
  }

  function openFork() {
    pickerState = { kind: 'fork-choice', title: 'Fork session', index: 0, items: [
      { label: 'Fork current session', detail: 'Copy the complete persisted transcript', _fork: null },
      { label: 'Fork from message…', detail: 'Choose a timeline boundary', _timeline: true },
    ], hint: 'Up/Down move · Enter select · Esc composer' };
    applyFilter(pickerState); overlay = 'choice'; draw();
  }

  function openRename(args = []) {
    const direct = args.join(' ').trim();
    if (direct) return renameSession(direct);
    pickerState = { kind: 'rename', title: 'Rename session', label: 'Title:', hint: 'Enter save · Esc cancel' };
    s.input = sess.title === 'New session' ? '' : sess.title;
    overlay = 'text-input'; draw();
  }

  async function renameSession(title) {
    try { await sessions.rename(sess, title); answer = `✓ Session renamed to “${sess.title}”`; }
    catch (e) { answer = `✗ ${e.message}`; }
    s.input = ''; overlay = null; draw();
  }

  function openExport() {
    pickerState = { kind: 'export', title: 'Export session', index: 0, items: [
      { label: 'Markdown', detail: 'Readable transcript', _format: 'markdown' },
      { label: 'JSON', detail: 'Safe structural metadata', _format: 'json' },
      { label: 'Sanitized JSON', detail: 'Credentials and secret fields redacted', _format: 'sanitized-json' },
    ], hint: 'Enter export · Esc cancel' };
    applyFilter(pickerState); overlay = 'choice'; draw();
  }

  function openInit() {
    const fs = require('fs'); const file = path.join(s.workspace, 'AGENTS.md');
    const exists = fs.existsSync(file);
    pickerState = { kind: 'init', title: exists ? 'Project instructions found' : 'Initialize project instructions', index: 0,
      items: exists ? [{ label: 'Inspect AGENTS.md', detail: 'Open a read-only preview', _init: 'inspect' }, { label: 'Update AGENTS.md', detail: 'Append a BotConnector section after confirmation', _init: 'update' }] : [{ label: 'Create AGENTS.md', detail: 'Create a minimal project instruction template', _init: 'create' }],
      hint: 'Enter select · Esc cancel' };
    applyFilter(pickerState); overlay = 'choice'; draw();
  }

  function openConnect() {
    let providers = [];
    try {
      const { CredentialManager, PROVIDERS } = require('../runtime/credentials.cjs');
      const cm = new CredentialManager({ store: s.store, env: process.env });
      providers = PROVIDERS.map((id) => ({ label: id, detail: cm.public()[id]?.configured ? `Configured via ${cm.public()[id].source}` : 'Not configured', _provider: id }));
    } catch { providers = []; }
    pickerState = { kind: 'connect', title: 'Connect provider', index: 0, items: providers.length ? providers : [{ label: 'No providers registered', disabled: true }], hint: 'Enter details · Esc cancel' };
    applyFilter(pickerState); overlay = 'choice'; draw();
  }

  function openCommands(query = '') {
    commandRegistry.refresh(); timelineState = { query: String(query || '') };
    overlay = 'commands'; draw();
  }

  function openCompact() {
    const estimate = (sess.messages || []).reduce((n, m) => n + Math.ceil(String(m.content || '').length / 4), 0);
    const keep = Math.min(12, sess.messages.length);
    pickerState = { kind: 'compact', title: 'Compact session context', index: 0, items: [
      { label: 'Compact now', detail: `${estimate} tokens estimated before · retain ${keep} recent messages`, _compact: true },
      { label: 'Cancel', detail: 'Keep the current context unchanged', _cancel: true },
    ], hint: 'Enter confirm · Esc cancel' };
    applyFilter(pickerState); overlay = 'choice'; draw();
  }

  function renderReview() {
    const r = reviewState || {};
    const L = ['', '  ' + views.statusBar(s), '', '  ' + (r.title || 'Review'), ''];
    if (r.phase === 'COLLECTING_DIFF') L.push('  Collecting working changes…');
    else if (r.phase === 'PREPARING_REVIEW') L.push(`  Reviewing ${r.files || 0} files…`);
    else if (r.phase === 'GENERATING_REVIEW') {
      L.push(`  Generating review with ${r.model || s.model.name}…`);
      if (r.answer) L.push('', ...String(r.answer).split(/\r?\n/).map((line) => '  ' + line));
    }
    else if (r.phase === 'COMPLETE') { L.push('  Review complete', '', ...String(r.answer || '').split(/\r?\n/).map((line) => '  ' + line)); }
    else if (r.phase === 'CANCELLED') L.push('  Review cancelled. The runtime is still available.');
    else if (r.error) { L.push('  ' + r.error); if (r.phase === 'FAILED') L.push('', '  R retry · Esc close'); }
    else if (r.answer) for (const line of String(r.answer).split(/\r?\n/)) L.push('  ' + line);
    else L.push('  ' + (r.empty ? 'No changes to review.' : 'Select a review scope.'));
    L.push('', '  Esc close', '', '  ' + views.statusBar(s));
    return L.join('\n');
  }

  const reviewTrace = (stateName, details = {}) => {
    if (debug) log('review-trace', JSON.stringify({ state: stateName, at: Date.now(), ...details }));
  };

  async function runReview(view = 'all') {
    reviewCancelRequested = false;
    reviewAbort = new AbortController();
    reviewState = { title: `Review · ${view}`, phase: 'COLLECTING_DIFF', running: true };
    overlay = 'review'; draw();
    reviewTrace('REVIEW_DIFF_COLLECTION_START', { scope: view });
    const collected = diffRegistry.collect(s.workspace, view);
    reviewTrace('REVIEW_DIFF_COLLECTION_DONE', { ok: !!collected.ok, files: collected.files ? collected.files.length : 0 });
    if (!collected.ok) { reviewState = { title: 'Review', scope: view, phase: 'FAILED', error: collected.error }; generating = false; reviewAbort = null; draw(); return; }
    if (!collected.files.length) { reviewState = { title: 'Review', scope: view, phase: 'COMPLETE', empty: true }; generating = false; reviewAbort = null; draw(); return; }
    try {
      reviewState = { title: `Review · ${view}`, phase: 'PREPARING_REVIEW', running: true, files: collected.files.length };
      draw();
      const resolved = await local.resolveEndpoint();
      const found = await local.discoverLocalModel({ endpoint: resolved.endpoint, timeoutMs: 2500 });
      if (!found.ok) throw new Error('No active model/runtime is available for AI review.');
      // Match normal chat's active-model resolution before entering the shared
      // turn pipeline. No provider or review-specific model is selected here.
      s.model = { ...s.model, name: found.friendly, locality: 'Local', provider: 'llama.cpp', cost: '$0.00' };
      s.modelId = found.id;
      if (found.nCtx) s.runtime.nCtx = found.nCtx;
      const payload = review.buildReviewPrompt(collected.files);
      const prompt = payload.prompt;
      const estimatedTokens = payload.estimatedTokens;
      const context = Number(s.runtime.nCtx) || 4096;
      const guard = review.guardPayload(payload, context);
      reviewTrace('REVIEW_PROMPT_READY', { files: payload.fileCount, chars: payload.chars, estimatedTokens, context, plannedContextAllowance: guard.plannedContextAllowance, model: found.id });
      if (!guard.ok) throw new Error(guard.reason);
      reviewState = { title: `Review · ${view}`, phase: 'GENERATING_REVIEW', running: true, files: collected.files.length, model: found.friendly, answer: '' };
      generating = true;
      draw();
      reviewTrace('REVIEW_DISPATCH_START', { model: found.id });
      let firstTokenLogged = false;
      reviewWatchdog = setTimeout(() => { reviewTrace('REVIEW_WATCHDOG_ABORT', { timeoutMs: 120000 }); try { reviewAbort.abort(); } catch {} }, 120000);
      const r = await loop.runTurn({
        prompt, taskKind: 'review',
        systemInstruction: 'You are BotConnector performing a read-only code review. Prioritize correctness, regressions, security, data-loss risk, missing tests, and material performance issues. Be concise and actionable. Do not propose edits or claim changes were made.',
        mode: s.mode, approval: s.approval, model: s.model, tools, cwd: process.cwd(), workspace: s.workspace,
        onEvent: (event) => { if (debug && event?.text) log('review-event', event.text); },
        localCtx: { endpoint: found.endpoint, modelId: found.id, friendly: found.friendly }, signal: reviewAbort.signal,
        maxTokens: 512, onToken: (token) => {
          if (!firstTokenLogged) { firstTokenLogged = true; reviewTrace('REVIEW_FIRST_TOKEN'); }
          reviewState.answer = (reviewState.answer || '') + token; draw();
        }, onApproval: null, session: taskSession, history: [], debugLog: debug ? log : null,
      });
      if (reviewWatchdog) clearTimeout(reviewWatchdog); reviewWatchdog = null;
      reviewTrace('REVIEW_STREAM_END', { ok: !r.failed, cancelled: !!r.cancelled, contentChars: String(r.answer || '').length, reason: r.failed ? r.answer : null });
      if (r.cancelled || reviewCancelRequested) {
        reviewState = { title: `Review · ${view}`, scope: view, phase: 'CANCELLED' };
        return;
      }
      if (r.failed) throw new Error(r.answer || 'Review model request failed.');
      const result = r.answer || reviewState.answer || 'No review findings returned.';
      reviewTrace('REVIEW_PERSIST_START', { contentChars: result.length });
      await sessions.recordTurn(sess, { prompt: `/review ${view === 'all' ? 'working changes' : view + ' changes'}`, answer: result, project: s.project, model: s.model, mode: s.mode });
      reviewTrace('REVIEW_PERSIST_DONE', { messageCount: sess.messages.length });
      reviewState = { title: `Review · ${view}`, scope: view, phase: 'COMPLETE', answer: result };
      answer = result;
    } catch (e) {
      if (reviewWatchdog) clearTimeout(reviewWatchdog); reviewWatchdog = null;
      reviewState = { title: `Review · ${view}`, scope: view, phase: 'FAILED', error: e.message };
    } finally {
      generating = false; reviewAbort = null;
      reviewTrace('REVIEW_GENERATING_FALSE');
      if (overlay === 'review' && reviewState?.phase === 'COMPLETE') overlay = null;
      draw(); reviewTrace('REVIEW_REDRAW_DONE', { phase: reviewState?.phase });
    }
  }

  function openReview() {
    pickerState = { kind: 'review', title: 'Review', index: 0, items: [
      { label: 'Working changes', detail: 'Review unstaged and untracked changes', _review: 'all' },
      { label: 'Staged changes', detail: 'Review the staged Git patch', _review: 'staged' },
      { label: 'Commit…', detail: 'Commit selection requires an explicit Git commit id', disabled: true, disabledReason: 'Commit picker is not implemented in the TUI yet' },
      { label: 'Branch…', detail: 'Branch comparison requires an explicit branch', disabled: true, disabledReason: 'Branch picker is not implemented in the TUI yet' },
      { label: 'Pull request…', detail: 'Remote provider integration', disabled: true, disabledReason: 'No pull-request backend is configured' },
    ], hint: 'Enter review · Esc cancel' };
    applyFilter(pickerState); overlay = 'choice'; draw();
  }

  async function applyInit(action) {
    const fs = require('fs'); const file = path.join(s.workspace, 'AGENTS.md');
    try {
      if (action === 'inspect') { answer = fs.readFileSync(file, 'utf8').slice(0, 6000); }
      else if (action === 'create') { if (fs.existsSync(file)) throw new Error('AGENTS.md appeared; refusing to overwrite it.'); fs.writeFileSync(file, '# AGENTS.md\n\n## BotConnector\n\n- Keep changes scoped to the current task.\n- Run the project checks before handing work back.\n'); answer = '✓ Created AGENTS.md'; }
      else if (action === 'update') { const before = fs.readFileSync(file, 'utf8'); if (!before.includes('## BotConnector')) fs.writeFileSync(file, before.replace(/\s*$/, '\n\n## BotConnector\n\n- Keep changes scoped to the current task.\n- Run the project checks before handing work back.\n')); answer = '✓ AGENTS.md inspected; BotConnector section updated.'; }
    } catch (e) { answer = `✗ ${e.message}`; }
    overlay = null; draw();
  }

  async function openDoctor(showDetails) {
    doctorDetails = !!showDetails;
    overlay = 'doctor'; doctorResult = doctorResult || {}; draw();
    doctorResult = await doctorMod.check(s);
    if (overlay === 'doctor') draw();
  }

  async function openStatus() {
    overlay = 'status'; draw();
    const resolved = await local.resolveEndpoint().catch(() => ({ endpoint: local.DEFAULT_ENDPOINT }));
    const probe = await local.discoverLocalModel({ endpoint: resolved.endpoint, timeoutMs: 1200 }).catch(() => ({ ok: false }));
    statusExtra = { provider: s.model.provider, modelId: probe.ok ? probe.id : s.modelId, endpoint: resolved.endpoint };
    if (overlay === 'status') draw();
  }

  commandRegistry = createCommandRegistry({
    workspace: s.workspace,
    gitAvailable: diffRegistry.isGitRepository(s.workspace),
    journalStatus: () => journal.status({ workspace: s.workspace, sessionId: sess.id }),
    mcpPrompts: () => mcpRegistry.listConfigured(s.store).flatMap((server) => Array.isArray(server.prompts) ? server.prompts.map((prompt) => ({ ...prompt, server: server.name })) : []),
  });
  integrationRegistry = integrationModule.createIntegrationRegistry({ cwd: s.workspace, env: process.env, platform: process.platform });

  async function handlePickerSelect(ps, it) {
    if (ps.kind === 'fork-choice') {
      if (it._timeline) { overlay = 'timeline'; timelineState = { messages: sessions.timeline(sess), index: 0, forkMode: true }; draw(); return; }
      const child = await sessions.fork(sess, null); sess = child; resetConversationViewport(); s.input = ''; overlay = null; answer = `✓ Forked session ${child.id}`; draw(); return;
    }
    if (ps.kind === 'timeline-fork') {
      const child = await sessions.fork(sess, it._message.id); sess = child; resetConversationViewport(); s.input = ''; overlay = null; answer = `✓ Forked from message #${it._messageIndex + 1}`; draw(); return;
    }
    if (ps.kind === 'export') {
      try { const out = await sessions.exportSession(sess, it._format); answer = `✓ Exported session to ${out}`; }
      catch (e) { answer = `✗ Export failed: ${e.message}`; }
      overlay = null; draw(); return;
    }
    if (ps.kind === 'init') { await applyInit(it._init); return; }
    if (ps.kind === 'connect') {
      overlay = null;
      answer = `Provider ${it._provider}: configuration workflow not available in TUI yet. No credential was requested or stored.`;
      draw(); return;
    }
    if (ps.kind === 'mcp-remove') {
      if (it._confirm) await removeMcp(ps.server);
      else { overlay = 'picker'; openMcp(); }
      return;
    }
    if (ps.kind === 'session-remove') {
      if (it._confirm) { await sessions.remove(ps.sessionId); answer = '✓ Session deleted.'; }
      overlay = null; pickerState = null; openSessions(); return;
    }
    if (ps.kind === 'compact') {
      if (it._compact) {
        const result = await sessions.compact(sess);
        answer = result.ok ? `✓ Context compacted: ${result.sourceTokenEstimate} earlier tokens summarized; full history remains in /timeline.` : `○ ${result.reason}`;
      }
      overlay = null; draw(); return;
    }
    if (ps.kind === 'review') { reviewTrace('REVIEW_SCOPE_SELECTED', { scope: it._review }); await runReview(it._review); return; }
    if (ps.kind === 'launch') { openLaunchDetails(it._integration); return; }
    if (ps.kind === 'launch-detail') { await runLaunchAction(ps.integration, it._launchAction); return; }
    if (ps.kind === 'palette') {
      overlay = null; draw();
      if (it._command && it._command.available !== false) await runCommand(it._command, false);
      return;
    }

    if (ps.kind === 'model') {
      if (it._findMore) {
        overlay = null;
        answer = 'Search more models from a terminal: botconnector models search "<query>" — then botconnector get <repo>@QUANT, or pick it here next time it’s installed.';
        draw();
        return;
      }
      if (it.kind === 'auto') {
        s.model = { name: 'Auto', locality: 'Local', backend: 'auto', provider: 'routing', cost: '$0.00' };
        s.modelId = null;
      } else if (it.kind === 'local' && it.selectable) {
        s.model = { name: it.label, locality: 'Local', backend: s.runtime.backend, provider: 'llama.cpp', cost: '$0.00' };
        s.modelId = it.modelPath;
      } else if (it.kind === 'ollama') {
        s.model = { name: it.label, locality: 'Local', backend: 'Ollama', provider: 'Ollama', cost: '$0.00' };
        s.modelId = it.id;
      } else if (it.kind === 'cloud') {
        s.model = { name: '<model>', locality: 'Cloud', backend: 'remote', provider: '<provider>', cost: '$...' };
        s.modelId = null;
      } else { overlay = null; draw(); return; }
      await persistSettings();
      activity.push(`✓ Model: ${s.model.name}`);
      overlay = null; draw();
      return;
    }

    if (ps.kind === 'project') {
      overlay = null;
      if (it._action.type === 'browse') { overlay = 'project-browse'; s.input = ''; draw(); return; }
      setProject(it._action.path);
      draw();
      return;
    }

    if (ps.kind === 'sessions') {
      overlay = null;
      const loaded = sessions.load(it._action);
      if (loaded) {
        sess = loaded;
        resetConversationViewport();
        s.project = loaded.project || s.project;
        if (loaded.model) s.model = loaded.model;
        if (loaded.mode) s.mode = loaded.mode;
        activity = [];
        answer = loaded.messages.length ? `Resumed "${loaded.title}" (${loaded.messages.length} messages).` : '';
        commandRegistry = createCommandRegistry({ workspace: s.workspace, gitAvailable: diffRegistry.isGitRepository(s.workspace), journalStatus: () => journal.status({ workspace: s.workspace, sessionId: sess.id }), mcpPrompts: () => mcpRegistry.listConfigured(s.store).flatMap((server) => Array.isArray(server.prompts) ? server.prompts.map((prompt) => ({ ...prompt, server: server.name })) : []) });
      }
      const recent = Array.isArray(s.store.get('tuiRecentModels')) ? s.store.get('tuiRecentModels') : [];
      if (s.modelId) await s.store.set('tuiRecentModels', [s.modelId, ...recent.filter((id) => id !== s.modelId)].slice(0, 8));
      draw();
      return;
    }

    if (ps.kind === 'agents') {
      overlay = null;
      if (it._agent) {
        if (it._agent.mode === 'Plan' || it._agent.mode === 'Act') setMode(it._agent.mode);
        else answer = `Agent ${it._agent.name} is discovered at ${it._agent.path}, but custom agent execution is not registered in this core.`;
      }
      draw(); return;
    }

    if (ps.kind === 'skills') {
      overlay = null; pickerState = null;
      if (it._skill) {
        activeSkill = it._skill;
        answer = `✓ Skill active: ${it._skill.name} (${it._skill.scope})`;
        activity.push(`✓ Skill available: ${it._skill.name}`);
      }
      draw(); return;
    }

    if (ps.kind === 'files') {
      overlay = null; pickerState = null;
      if (it._file) s.input = '@' + it._file;
      draw(); return;
    }

    if (ps.kind === 'mcp') {
      if (it._mcp) { mcpState = it._mcp; overlay = 'mcp-detail'; draw(); }
      return;
    }

    if (ps.kind === 'tools') { overlay = null; draw(); return; }

    overlay = null; draw();
  }

  async function beginFirstRunRecommend() {
    firstRunRec = await firstRun.recommend();
    firstRunResolved = null;
    overlay = 'first-run-recommend'; draw();
    if (firstRunRec.recommendation) {
      try { firstRunResolved = await firstRun.resolveDownloadable(firstRunRec.recommendation.model, firstRunRec.hardware); }
      catch (e) { firstRunResolved = null; }
      if (overlay === 'first-run-recommend') draw();
    }
  }

  function startFirstRunDownload() {
    if (!firstRunResolved) { firstRunError = 'Could not resolve a downloadable file for this model.'; overlay = 'first-run-failed'; draw(); return; }
    overlay = 'first-run-progress';
    firstRunProgressState = { pct: 0, downloadedBytes: 0, totalBytes: firstRunResolved.group.size, status: 'downloading' };
    draw();
    const dm = firstRun.makeDownloader({
      store: s.store,
      emit: (channel, payload) => {
        if (channel !== 'download:progress' || payload.id !== firstRunJobId) return;
        firstRunProgressState = { pct: payload.totalBytes ? Math.round((payload.downloadedBytes / payload.totalBytes) * 100) : 0, downloadedBytes: payload.downloadedBytes, totalBytes: payload.totalBytes, status: payload.status };
        if (overlay === 'first-run-progress') draw();
        if (payload.status === 'completed') afterDownloadComplete().catch((e) => { firstRunError = e.message; overlay = 'first-run-failed'; draw(); });
        else if (payload.status === 'failed') { firstRunError = payload.error || 'Download failed'; overlay = 'first-run-failed'; draw(); }
        else if (payload.status === 'cancelled') { overlay = null; draw(); }
      },
    });
    dm.start({ repoId: firstRunResolved.repoId, group: firstRunResolved.group, metadata: { capabilities: firstRunResolved.details.capabilities, pipeline_tag: firstRunResolved.details.pipeline_tag } })
      .then((job) => { firstRunJobId = job.id; });
    firstRunDownloadManager = dm;
  }
  let firstRunDownloadManager = null;

  async function afterDownloadComplete() {
    firstRunProgressState = { ...firstRunProgressState, status: 'installing-runtime', note: 'Setting up the local runtime…' };
    draw();
    const rt = await firstRun.ensureRuntimeInstalled({
      userDataDir: state.userDataDir(), backend: s.runtime.backend,
      emit: (ch, p) => { if (ch === 'runtime:install-progress') { firstRunProgressState = { ...firstRunProgressState, note: p.status || '' }; if (overlay === 'first-run-progress') draw(); } },
    });
    const installed = await scanInstalled(s.store.get('modelsDir'));
    const picked = installed.find((m) => m.repoId === firstRunResolved.repoId) || installed[installed.length - 1];
    const backend = rt.backend || (s.runtime.backend === 'auto' ? 'vulkan' : s.runtime.backend);
    const started = await firstRun.startRuntime({ binary: rt.binary, modelPath: picked.path, projector: picked.projector, backend, context: 8192, port: 11435 });
    s.runtime.backend = backend;
    await persistSettings();
    let ready = false;
    for (let i = 0; i < 45 && !ready; i++) {
      const r = await local.discoverLocalModel({ endpoint: 'http://127.0.0.1:11435/v1', timeoutMs: 2000 });
      if (r.ok) { ready = true; s.model = { name: r.friendly, locality: 'Local', backend, provider: 'llama.cpp', cost: '$0.00' }; s.modelId = r.id; if (r.nCtx) s.runtime.nCtx = r.nCtx; }
      else await new Promise((res) => setTimeout(res, 1500));
    }
    s.firstRunDone = true;
    await persistSettings();
    overlay = ready ? 'first-run-done' : 'first-run-failed';
    if (!ready) firstRunError = 'Runtime installed but did not become ready in time.';
    draw();
  }

  async function tryStartLastRuntime() {
    overlay = 'first-run-progress';
    firstRunRec = firstRunRec || { recommendation: { model: { name: s.model.name || 'local model' } } };
    firstRunProgressState = { status: 'installing-runtime', note: 'Checking managed runtime…' };
    draw();
    try {
      const owner = await readOwnership(statePath());
      if (owner && pidAlive(owner.childPid != null ? owner.childPid : owner.ownerPid) && owner.ownerType && owner.ownerType !== 'cli-tui') {
        runtimeStoppedInfo = { busyOwner: owner.ownerType };
        overlay = 'runtime-stopped'; draw(); return;
      }
      const installed = await scanInstalled(s.store.get('modelsDir'));
      const picked = installed.find((m) => m.path === s.modelId) || installed[0];
      if (!picked) { overlay = null; await openModelPicker(); answer = 'No local model installed yet — pick "Find more models…" or use /get from a terminal.'; draw(); return; }
      const rt = await firstRun.ensureRuntimeInstalled({ userDataDir: state.userDataDir(), backend: s.runtime.backend, emit: () => {} });
      const backend = rt.backend || (s.runtime.backend === 'auto' ? 'vulkan' : s.runtime.backend);
      await firstRun.startRuntime({ binary: rt.binary, modelPath: picked.path, projector: picked.projector, backend, context: s.runtime.nCtx || 8192, port: 11435 });
      let ready = false;
      for (let i = 0; i < 45 && !ready; i++) {
        const r = await local.discoverLocalModel({ endpoint: 'http://127.0.0.1:11435/v1', timeoutMs: 2000 });
        if (r.ok) { ready = true; s.model = { name: r.friendly, locality: 'Local', backend, provider: 'llama.cpp', cost: '$0.00' }; s.modelId = r.id; if (r.nCtx) s.runtime.nCtx = r.nCtx; }
        else await new Promise((res) => setTimeout(res, 1500));
      }
      overlay = null;
      activity.push(ready ? `✓ Local runtime started (${backend})` : '○ Runtime did not become ready in time');
      await persistSettings();
      draw();
    } catch (e) {
      showError({ title: 'Could not start the local runtime.', body: 'See details for the exact error.', actions: ['Choose another model'], raw: e.message, onAction: (n) => { overlay = null; if (n === 1) openModelPicker(); else draw(); } });
    }
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  if (!s.firstRunDone) {
    const resolved = await local.resolveEndpoint();
    const probe = await local.discoverLocalModel({ endpoint: resolved.endpoint, timeoutMs: 1200 });
    const installed = await scanInstalled(s.store.get('modelsDir')).catch(() => []);
    if (!probe.ok && installed.length === 0) {
      pickerState = views.firstRunWelcome();
      applyFilter(pickerState);
      pickerState.kind = 'first-run';
      overlay = 'picker';
    } else {
      s.firstRunDone = true; await persistSettings();
    }
  }
  if (overlay === null && pendingWarning) { pendingGuard = g; overlay = 'context-needs-larger'; }
  draw();
  // Recompute the whole frame on terminal resize (home's composer/footer
  // are pinned to actual rows/columns, not fixed offsets) so the layout —
  // and the composer's real cursor position — stay correct immediately,
  // not just after the next keypress.
  out.on('resize', () => draw());

  const scrollConversation = (action) => {
    const next = viewport.move(
      { offset: conversationScrollOffset, atBottom: conversationAtBottom },
      action,
      conversationMaxStart,
      conversationViewportRows,
    );
    conversationScrollOffset = next.offset;
    conversationAtBottom = next.atBottom;
    if (conversationAtBottom) unseenOutputCount = 0;
    draw();
  };

  // SGR mouse reporting is enabled only for this alternate-screen TUI. Wheel
  // events are handled separately from readline keypresses, so a wheel never
  // becomes an Up/Down edit or composer-history action. Popovers retain input
  // priority and therefore suppress conversation scrolling while open.
  process.stdin.on('data', (chunk) => {
    if (overlay !== null || slashMenuOpen) return;
    for (const direction of viewport.parseMouseWheel(chunk)) scrollConversation(direction);
  });

  const pushActivity = (t) => { activity.push(t.text || t); if (!debug) activity = activity.slice(-8); draw(); };

  const submit = async () => {
    const prompt = s.input.trim(); s.input = '';
    if (!prompt) { draw(); return; }
    if (prompt.startsWith('/')) return slash(prompt);
    if (prompt.startsWith('!')) return runShellPrefix(prompt.slice(1).trim());
    if (prompt.startsWith('@')) { activity.push(`● Reading ${prompt.slice(1)}`); draw(); return; }
    activity.push('● Contacting local runtime…'); draw();
    const resolved = await local.resolveEndpoint();
    const found = await local.discoverLocalModel({ endpoint: resolved.endpoint, timeoutMs: 5000 });
    if (!found.ok) {
      activity.pop();
      runtimeStoppedInfo = null;
      overlay = 'runtime-stopped';
      draw();
      return;
    }
    s.model = { name: found.friendly, locality: s.model.locality === 'Local' ? 'Local' : s.model.locality, backend: resolved.ownerType ? (statusExtra.backend || s.runtime.backend) : s.runtime.backend, provider: 'llama.cpp', cost: '$0.00' };
    s.modelId = found.id;
    if (found.nCtx) s.runtime.nCtx = found.nCtx;
    const need = ctxGuard.guard({ nCtx: s.runtime.nCtx, plannedUserTokens: ctxGuard.estimateTokens(prompt) });
    if (!need.ok && !s.contextBumpAcked[found.id]) {
      pendingGuard = need; overlay = 'context-needs-larger'; draw(); return;
    }
    generating = true;
    genAbort = new AbortController();
    answer = '';
    pendingPrompt = prompt;
    activity.push(`● Streaming from ${found.friendly}… (Esc cancels)`); draw();
    const history = sessions.historyFor(sess);
    const r = await loop.runTurn({
      prompt, mode: s.mode, approval: s.approval, model: s.model,
      tools, cwd: process.cwd(), workspace: s.workspace, onEvent: pushActivity,
      localCtx: { endpoint: found.endpoint, modelId: found.id, friendly: found.friendly },
      signal: genAbort.signal,
      debugLog: debug ? log : null,
      session: taskSession,
      history,
      onToken: (t) => { answer += t; draw(); },
      onApproval: (req) => new Promise((resolve) => {
        approvalReq = req; approvalResolve = resolve; diffFull = false;
        overlay = req.kind === 'command' ? 'approve-command' : 'approve-diff';
        draw();
      }),
    });
    generating = false; genAbort = null;
    s.usedTokens += ctxGuard.estimateTokens(prompt) + ctxGuard.estimateTokens(r.answer || '');
    if (r.cancelled) {
      answer = r.answer || '(cancelled)';
    } else if (r.failed) {
      showError({
        title: 'Local inference failed.', body: 'The local model could not complete this request.',
        actions: ['Retry'], raw: r.answer,
        onAction: (n) => { overlay = null; if (n === 1) { s.input = prompt; submit(); } else draw(); },
      });
    } else {
      if (!r.streamed) answer = r.answer;
      activity.push('✓ Response ready');
    }
    await sessions.recordTurn(sess, { prompt, answer: r.answer, project: s.project, model: s.model, mode: s.mode });
    if (r.result && r.result._mutation) {
      await journal.record(r.result._mutation, { workspace: s.workspace, sessionId: sess.id, messageId: sess.messages[sess.messages.length - 1]?.id });
    }
    pendingPrompt = '';
    maybeShowContextFull();
    await persistSettings(); draw();
  };

  async function runShellPrefix(command) {
    if (!command) { answer = 'Shell mode: type ! followed by a command.'; draw(); return; }
    const spec = shellTool.splitArgv(command);
    if (spec.needsShell || spec.error) {
      answer = spec.needsShell ? 'Shell syntax requires an explicit approved agent command; no command was run.' : spec.error;
      draw(); return;
    }
    const ws = createWorkspace(s.workspace);
    const intent = { kind: 'command', tool: 'run_command', args: { exe: spec.exe, args: spec.args, display: command }, label: `● Shell !${command}` };
    pendingPrompt = '!' + command; generating = true; activity.push(`● Shell command: ${command}`); draw();
    const r = await loop.execIntent(intent, {
      ws, emit: pushActivity, localCtx: null, signal: null, onToken: null, debugLog: debug ? log : null,
      mode: s.mode, approval: s.approval, session: taskSession,
      onApproval: (req) => new Promise((resolve) => { approvalReq = req; approvalResolve = resolve; overlay = 'approve-command'; draw(); }),
      taskPrompt: command,
    });
    generating = false; pendingPrompt = '';
    answer = r.answer || (r.toolResult ? `${r.toolResult.stdout || ''}${r.toolResult.stderr || ''}`.trim() || `Exit ${r.toolResult.exitCode}` : 'Shell command finished.');
    activity.push(r.rejected ? '✗ Shell command rejected' : '✓ Shell command complete');
    await sessions.recordTurn(sess, { prompt: '!' + command, answer, project: s.project, model: s.model, mode: s.mode });
    draw();
  }

  async function runCommand(command, { contextual = false, args = [] } = {}) {
    if (!command || command.available === false) { answer = command?.disabledReason || 'Command unavailable.'; draw(); return; }
    switch (command.handler) {
      case 'new': return doNew();
      case 'init': return openInit();
      case 'sessions': return openSessions({ contextual });
      case 'timeline': return openTimeline();
      case 'fork': return openFork();
      case 'rename': return openRename(args);
      case 'copy': {
        const copied = await sessions.copyToClipboard(sessions.markdown(sess));
        answer = copied.ok ? '✓ Session transcript copied to the clipboard.' : `✗ Clipboard unavailable: ${copied.error}`;
        draw(); return;
      }
      case 'export': return openExport();
      case 'project': return openProjectPicker({ contextual });
      case 'launch': return openLaunch({ contextual: true });
      case 'agents': return openAgents({ contextual });
      case 'skills': return openSkills({ contextual });
      case 'permissions': return showPermissionsInfo();
      case 'plan': return setMode('Plan');
      case 'act': return setMode('Act');
      case 'diff': return openDiff();
      case 'review': reviewTrace('REVIEW_COMMAND_SELECTED'); return openReview();
      case 'model': return openModelPicker({ contextual });
      case 'mcp': return openMcp();
      case 'tools': return openTools({ contextual });
      case 'editor': {
        const editor = process.env.EDITOR || process.env.VISUAL;
        if (!editor) { answer = 'EDITOR/VISUAL is not configured.'; draw(); return; }
        const parsed = shellTool.splitArgv(editor);
        if (parsed.needsShell || parsed.error) { answer = 'Configured editor cannot be launched safely.'; draw(); return; }
        try { require('child_process').spawn(parsed.exe, [...parsed.args, s.workspace], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); answer = `Opened ${parsed.exe}.`; }
        catch (e) { answer = `Could not open editor: ${e.message}`; }
        draw(); return;
      }
      case 'context': answer = `Context ${Math.round(((s.usedTokens || 0) / (s.runtime.nCtx || 1)) * 100)}% · runtime n_ctx=${s.runtime.nCtx}`; draw(); return;
      case 'compact': return openCompact();
      case 'thinking': s.settings.showThinking = !s.settings.showThinking; await persistSettings(); answer = `Thinking display: ${s.settings.showThinking ? 'On' : 'Off'} · reasoning is shown only when the active model exposes it.`; draw(); return;
      case 'details': s.settings.showDetails = !s.settings.showDetails; await persistSettings(); answer = `Tool details: ${s.settings.showDetails ? 'On' : 'Off'}`; draw(); return;
      case 'undo': {
        const r = await journal.undo({ workspace: s.workspace, sessionId: sess.id }); answer = r.ok ? '✓ Last BotConnector mutation undone.' : `✗ ${r.reason}`; draw(); return;
      }
      case 'redo': {
        const r = await journal.redo({ workspace: s.workspace, sessionId: sess.id }); answer = r.ok ? '✓ BotConnector mutation redone.' : `✗ ${r.reason}`; draw(); return;
      }
      case 'theme': answer = 'Only the default theme is currently installed.'; draw(); return;
      case 'commands': return openCommands();
      case 'connect': return openConnect();
      case 'status': return openStatus();
      case 'doctor': return openDoctor(false);
      case 'settings': return openSettings();
      case 'help': answer = 'Use / for contextual commands, @ for files, ! for approved shell commands, Ctrl+P for the global palette.'; draw(); return;
      case 'shell': answer = 'Shell mode: type ! followed by a command.'; draw(); return;
      case 'skill':
        activeSkill = command.skill;
        answer = `✓ Skill active: ${command.skill.name} (${command.skill.scope})`;
        activity.push(`✓ Skill available: ${command.skill.name}`); draw(); return;
      case 'project-command':
        s.input = command.body || '';
        return submit();
      default: answer = `No handler registered for ${command.slash}.`; draw();
    }
  }

  const slash = async (cmd, opts = {}) => {
    const contextual = !!opts.contextual;
    const parts = cmd.split(/\s+/);
    const command = commandRegistry.resolve(parts[0]);
    if (!command) { answer = 'Unknown command ' + parts[0] + ' — press Ctrl+P for the command palette.'; draw(); return; }
    if (command.handler === 'settings' && parts.length >= 3) await applySettingCommand(parts[1], parts.slice(2).join(' '));
    else if (command.handler === 'exit') { restore(); process.exit(0); }
    else if (command.handler === 'clear') { activity = []; answer = ''; draw(); }
    else if (command.handler === 'details') await runCommand(command, { contextual, args: parts.slice(1) });
    else if (command.handler === 'debug') { debug = !debug; s.settings.debugMode = debug; await persistSettings(); answer = 'Debug mode: ' + (debug ? 'on' : 'off'); draw(); }
    else await runCommand(command, { contextual, args: parts.slice(1) });
    log('slash', cmd);
  };

  async function executeSlashSelection() {
    const filtered = applySlashFilter();
    const selected = filtered[slashSelectionIndex];
    if (!selected || !selected._command) { draw(); return; }
    slashMenuOpen = false;
    // The selected command is an action, not a chat message. Clear the same
    // canonical composer before opening a contextual picker.
    s.input = '';
    draw();
    await runCommand(selected._command, { contextual: true });
  }

  async function applySettingCommand(key, value) {
    value = String(value || '').trim();
    const ok = (msg) => { answer = '✓ ' + msg; draw(); };
    const bad = (msg) => { answer = '✗ ' + msg; draw(); };
    if (key === 'theme') { if (!['auto', 'dark', 'light'].includes(value)) return bad('theme must be auto|dark|light'); s.settings.theme = value; await persistSettings(); return ok('theme set to ' + value); }
    if (key === 'language') { if (!['system', 'en', 'id'].includes(value)) return bad('language must be system|en|id'); s.settings.language = value; await persistSettings(); return ok('language set to ' + value); }
    if (key === 'context') { if (!['auto', 'manual'].includes(value)) return bad('context must be auto|manual'); s.settings.contextPreference = value; await persistSettings(); return ok('context preference set to ' + value); }
    if (key === 'debug') { if (!['on', 'off'].includes(value)) return bad('debug must be on|off'); s.settings.debugMode = value === 'on'; debug = s.settings.debugMode; await persistSettings(); return ok('debug ' + value); }
    if (key === 'approval') { if (!['ask', 'full-auto'].includes(value)) return bad('approval must be ask|full-auto'); s.approval = value; s.settings.approvalBehavior = value; await persistSettings(); return ok('approval set to ' + value); }
    return bad('unknown setting: ' + key);
  }

  process.stdin.on('keypress', async (ch, k = {}) => {
    log('key', JSON.stringify(k));

    if (overlay === 'timeline') {
      const ts = timelineState || { messages: [] }; const count = ts.messages.length;
      if (k.name === 'escape') { overlay = null; timelineState = null; draw(); return; }
      if (k.name === 'up') { ts.index = Math.max(0, (ts.index || 0) - 1); draw(); return; }
      if (k.name === 'down') { ts.index = Math.min(Math.max(0, count - 1), (ts.index || 0) + 1); draw(); return; }
      const c = (ch || '').toLowerCase(); const msg = ts.messages[ts.index || 0];
      if (msg && c === 'f') { const child = await sessions.fork(sess, msg.id); sess = child; resetConversationViewport(); overlay = null; timelineState = null; answer = `✓ Forked from message #${(ts.index || 0) + 1}`; draw(); return; }
      if (msg && c === 'c') { const copied = await sessions.copyToClipboard(`## ${msg.role === 'user' ? 'You' : 'BotConnector'}\n\n${msg.content}`); answer = copied.ok ? '✓ Selected message copied.' : `✗ Clipboard unavailable: ${copied.error}`; draw(); return; }
      if (k.name === 'return' && msg) {
        if (ts.forkMode) { const child = await sessions.fork(sess, msg.id); sess = child; resetConversationViewport(); answer = `✓ Forked from message #${(ts.index || 0) + 1}`; }
        else answer = `Timeline position #${(ts.index || 0) + 1} selected.`;
        overlay = null; timelineState = null; draw(); return;
      }
      return;
    }

    if (overlay === 'choice') {
      const ps = pickerState; const rows = ps.filtered || ps.items || [];
      if (k.name === 'escape') { overlay = null; pickerState = null; s.input = ''; draw(); return; }
      if (k.name === 'up') { ps.index = Math.max(0, ps.index - 1); draw(); return; }
      if (k.name === 'down') { ps.index = Math.min(Math.max(0, rows.length - 1), ps.index + 1); draw(); return; }
      if (ps.kind === 'launch-detail') {
        const c = (ch || '').toLowerCase();
        if (c === 'm') { await runLaunchAction(ps.integration, 'model'); return; }
        if (c === 'c') { await runLaunchAction(ps.integration, 'configure'); return; }
        if (c === 'i') { await runLaunchAction(ps.integration, 'install'); return; }
      }
      if (k.name === 'return') { const it = rows[ps.index]; if (it && !it.disabled) await handlePickerSelect(ps, it); return; }
      return;
    }

    if (overlay === 'text-input') {
      if (k.name === 'escape') { overlay = null; pickerState = null; s.input = ''; draw(); return; }
      if (k.name === 'return') { const value = s.input; s.input = ''; if (pickerState.kind === 'mcp-add') await addMcp(value); else await renameSession(value); return; }
      if (k.name === 'backspace') { s.input = s.input.slice(0, -1); draw(); return; }
      if (ch && ch.length === 1 && !k.ctrl && !k.meta) { s.input += ch; draw(); return; }
      return;
    }

    if (overlay === 'commands') {
      if (k.name === 'escape') { overlay = null; timelineState = null; draw(); return; }
      if (k.name === 'backspace') { timelineState.query = String(timelineState.query || '').slice(0, -1); draw(); return; }
      if (ch && ch.length === 1 && !k.ctrl && !k.meta) { timelineState.query = String(timelineState.query || '') + ch; draw(); return; }
      return;
    }

    if (overlay === 'review') {
      if (k.name === 'escape') {
        if (reviewState?.phase === 'GENERATING_REVIEW' && reviewAbort) {
          reviewCancelRequested = true;
          reviewAbort.abort();
          reviewState = { title: reviewState.title, phase: 'CANCELLED' };
          generating = false;
          overlay = null;
          answer = 'Review cancelled. The runtime is still available.';
          draw();
        } else { overlay = null; reviewState = null; draw(); }
      } else if ((ch || '').toLowerCase() === 'r' && reviewState?.phase === 'FAILED') {
        await runReview(reviewState.scope || 'all');
      }
      return;
    }

    // Contextual pickers share the canonical home frame and boxed composer.
    // Their arrows/Enter/Esc controls never create or focus another input.
    if (overlay === 'composer-picker') {
      const ps = pickerState;
      if (k.name === 'escape') { overlay = null; pickerState = null; draw(); return; }
      if (k.name === 'up') { ps.index = Math.max(0, ps.index - 1); draw(); return; }
      if (k.name === 'down') { ps.index = Math.min(Math.max(0, ps.filtered.length - 1), ps.index + 1); draw(); return; }
      if (k.name === 'return') {
        const it = ps.filtered[ps.index];
        if (!it || it.disabled) { draw(); return; }
        await handlePickerSelect(ps, it);
        return;
      }
      return;
    }

    // Slash search is a view of s.input, not a second palette query/input.
    // Esc preserves the typed command and Backspace closes at empty input.
    if (slashMenuOpen) {
      if (k.name === 'escape') { slashMenuOpen = false; draw(); return; }
      if (k.name === 'up') { slashSelectionIndex = Math.max(0, slashSelectionIndex - 1); draw(); return; }
      if (k.name === 'down') {
        const count = applySlashFilter().length;
        slashSelectionIndex = Math.min(Math.max(0, count - 1), slashSelectionIndex + 1);
        draw(); return;
      }
      if (k.name === 'return') { await executeSlashSelection(); return; }
      if (k.name === 'backspace') {
        s.input = s.input.slice(0, -1);
        if (!s.input) slashMenuOpen = false;
        draw(); return;
      }
      if (ch && ch.length === 1 && !k.ctrl && !k.meta) {
        s.input += ch;
        slashSelectionIndex = 0;
        draw(); return;
      }
      return;
    }

    // Conversation paging is available only on the home screen. Plain
    // Up/Down remain reserved for the composer and contextual pickers.
    if (overlay === null) {
      if (k.ctrl && k.name === 'home') { scrollConversation('home'); return; }
      if (k.ctrl && k.name === 'end') { scrollConversation('end'); return; }
      if (k.name === 'pageup') { scrollConversation('up'); return; }
      if (k.name === 'pagedown') { scrollConversation('down'); return; }
    }

    if (overlay === 'picker') {
      const ps = pickerState;
      if (k.name === 'escape') { overlay = null; draw(); return; }
      if (k.name === 'up') { ps.index = Math.max(0, ps.index - 1); draw(); return; }
      if (k.name === 'down') { ps.index = Math.min(Math.max(0, ps.filtered.length - 1), ps.index + 1); draw(); return; }
      if (ps.kind === 'mcp') {
        const it = ps.filtered[ps.index]; const c = (ch || '').toLowerCase();
        if (c === 'a') { openMcpAdd(); return; }
        if (it?._mcp && ch === ' ') { await toggleMcp(it._mcp); return; }
        if (it?._mcp && c === 'r') { await reconnectMcp(it._mcp); return; }
        if (it?._mcp && c === 'd') { pickerState = { kind: 'mcp-remove', title: `Remove ${it._mcp.name}?`, server: it._mcp, index: 0, items: [{ label: 'Remove server', detail: 'Delete only this MCP configuration', _confirm: true }, { label: 'Cancel' }], hint: 'Enter select · Esc cancel' }; applyFilter(pickerState); overlay = 'choice'; draw(); return; }
        if (it?._mcp && c === 'l') { answer = `Authentication for ${it._mcp.name} is not available in the canonical TUI; no credentials were requested.`; draw(); return; }
        return;
      }
      if (ps.kind === 'sessions' && k.name === 'delete') {
        const it = ps.filtered[ps.index];
        if (it && it._action) {
          const children = sessions.list().filter((x) => x.parentSessionId === it._action);
          pickerState = { kind: 'session-remove', title: `Delete ${it.label}?`, index: 0, sessionId: it._action, items: [{ label: 'Delete session', detail: children.length ? `${children.length} child session(s) will remain; their parent link will be retained.` : 'This removes only the selected session.', _confirm: true }, { label: 'Cancel' }], hint: 'Enter select · Esc cancel' };
          applyFilter(pickerState); overlay = 'choice'; draw();
        }
        return;
      }
      if (ps.kind === 'sessions') {
        const it = ps.filtered[ps.index]; const c = (ch || '').toLowerCase();
        if (it?._action && c === 'r') { const loaded = sessions.load(it._action); if (loaded) { sess = loaded; s.input = ''; overlay = null; await openRename([]); } return; }
        if (it?._action && c === 'f') { const loaded = sessions.load(it._action); if (loaded) { sess = loaded; overlay = null; openFork(); } return; }
        if (it?._action && c === 'e') { const loaded = sessions.load(it._action); if (loaded) { sess = loaded; overlay = null; openExport(); } return; }
      }
      if (k.name === 'return') {
        const it = ps.filtered[ps.index];
        if (ps.kind === 'first-run') {
          overlay = null;
          if (/recommended/i.test(it.label)) await beginFirstRunRecommend();
          else if (/another model/i.test(it.label)) await openModelPicker();
          else { s.firstRunDone = true; await persistSettings(); s.model = { name: '<model>', locality: 'Cloud', backend: 'remote', provider: '<provider>', cost: '$...' }; draw(); }
          return;
        }
        if (ps.kind === 'first-run-alt') {
          if (!it || !it._model) { overlay = 'first-run-recommend'; draw(); return; }
          firstRunRec = { ...firstRunRec, recommendation: { model: it._model, fit: { label: it.provider } } };
          overlay = 'first-run-recommend'; draw();
          firstRun.resolveDownloadable(it._model, firstRunRec.hardware)
            .then((resolved) => { firstRunResolved = resolved; if (overlay === 'first-run-recommend') draw(); })
            .catch(() => { firstRunResolved = null; });
          return;
        }
        if (!it || it.disabled) { draw(); return; }
        await handlePickerSelect(ps, it);
        return;
      }
      if (ps.showFilter) {
        if (k.name === 'backspace') { ps.filter = (ps.filter || '').slice(0, -1); applyFilter(ps); draw(); return; }
        if (ch && ch.length === 1 && !k.ctrl && !k.meta) { ps.filter = (ps.filter || '') + ch; applyFilter(ps); draw(); return; }
      }
      return;
    }

    if (overlay === 'diff') {
      if (k.name === 'escape') { overlay = null; diffState = null; draw(); return; }
      if (k.name === 'up' || (ch || '').toLowerCase() === 'k') { diffState.index = Math.max(0, (diffState.index || 0) - 1); draw(); return; }
      if (k.name === 'down' || (ch || '').toLowerCase() === 'j') { diffState.index = Math.min(Math.max(0, diffState.files.length - 1), (diffState.index || 0) + 1); draw(); return; }
      if (k.name === 'return') { if (diffState.files.length) overlay = 'diff-detail'; draw(); return; }
      const c = (ch || '').toLowerCase();
      if (c === 'a' || c === 's' || c === 'u') { diffState = diffRegistry.collect(s.workspace, c === 's' ? 'staged' : c === 'u' ? 'unstaged' : 'all'); draw(); return; }
      if (c === 'n') { diffState.index = Math.min(diffState.files.length - 1, (diffState.index || 0) + 1); draw(); return; }
      if (c === 'p') { diffState.index = Math.max(0, (diffState.index || 0) - 1); draw(); return; }
      return;
    }

    if (overlay === 'diff-detail') {
      if (k.name === 'escape') { overlay = 'diff'; draw(); return; }
      if (k.name === 'up' || (ch || '').toLowerCase() === 'k') { diffState.index = Math.max(0, (diffState.index || 0) - 1); draw(); return; }
      if (k.name === 'down' || (ch || '').toLowerCase() === 'j') { diffState.index = Math.min(Math.max(0, diffState.files.length - 1), (diffState.index || 0) + 1); draw(); return; }
      return;
    }

    if (overlay === 'mcp-detail') {
      if (k.name === 'escape') { overlay = 'picker'; draw(); return; }
      return;
    }

    if (overlay === 'project-browse') {
      if (k.name === 'escape') { overlay = null; s.input = ''; draw(); return; }
      if (k.name === 'return') {
        const p = s.input.trim(); s.input = '';
        const fs2 = require('fs');
        try {
          const st = fs2.statSync(p);
          if (st.isDirectory()) { setProject(p); overlay = null; }
          else showError({ title: 'Not a folder', body: p, actions: [] });
        } catch (e) { showError({ title: 'Folder not found', body: p, actions: [], raw: e.message }); }
        draw();
        return;
      }
      if (k.name === 'backspace') { s.input = s.input.slice(0, -1); draw(); return; }
      if (ch && ch.length === 1 && !k.ctrl && !k.meta) { s.input += ch; draw(); return; }
      return;
    }

    if (overlay === 'settings-edit') {
      if (k.name === 'escape') { overlay = null; s.input = ''; draw(); return; }
      if (k.name === 'return') {
        const [key, ...rest] = s.input.trim().split(/\s+/); s.input = ''; overlay = null;
        if (key) await applySettingCommand(key, rest.join(' '));
        else draw();
        return;
      }
      if (k.name === 'backspace') { s.input = s.input.slice(0, -1); draw(); return; }
      if (ch && ch.length === 1 && !k.ctrl && !k.meta) { s.input += ch; draw(); return; }
      return;
    }

    if (overlay === 'approve-diff' || overlay === 'approve-command') {
      const c = (ch || '').toLowerCase();
      const done = (verdict) => {
        const res = approvalResolve; approvalReq = null; approvalResolve = null; overlay = null; diffFull = false;
        activity.push(verdict.approved ? (verdict.approveAll ? '✓ Approved (all remaining this task)' : '✓ Approved') : '✗ Rejected — nothing changed.');
        draw();
        res(verdict);
      };
      if (overlay === 'approve-diff' && c === 'v') { diffFull = !diffFull; draw(); return; }
      if (k.name === 'escape' || c === 'n') done({ approved: false });
      else if (ch === 'A') done({ approved: true, approveAll: true });
      else if (k.name === 'return' || c === 'y') done({ approved: true });
      return;
    }

    if (overlay === 'context-needs-larger') {
      const c = (ch || '').toLowerCase();
      const modelKey = s.modelId || 'default';
      if (c === 'r') {
        const recK = recommendCtxK(pendingGuard.required);
        overlay = null; draw();
        try {
          const owner = await readOwnership(statePath());
          if (owner && pidAlive(owner.childPid != null ? owner.childPid : owner.ownerPid) && owner.ownerType !== 'cli-tui') {
            answer = `Local AI's context is managed by ${owner.ownerType} — open it there to increase context to ${recK}K.`;
          } else {
            const installed = await scanInstalled(s.store.get('modelsDir'));
            const picked = installed.find((m) => m.path === s.modelId) || installed[0];
            if (picked && owner) {
              if (llama.status().running) llama.stopLlama();
              await releaseOwnership(statePath()).catch(() => {});
              const rt = await firstRun.ensureRuntimeInstalled({ userDataDir: state.userDataDir(), backend: s.runtime.backend, emit: () => {} });
              await firstRun.startRuntime({ binary: rt.binary, modelPath: picked.path, projector: picked.projector, backend: owner.backend || 'vulkan', context: recK * 1024, port: 11435 });
              answer = `Restarted with ${recK}K context.`;
              s.runtime.nCtx = recK * 1024;
            } else {
              answer = `Restart BotConnector's local runtime with ${recK}K context (Desktop: Runtime settings, or CLI: botconnector server start <model> --ctx ${recK * 1024}).`;
            }
          }
        } catch (e) { answer = 'Could not restart automatically: ' + e.message; }
        s.contextBumpAcked[modelKey] = true; await persistSettings(); draw(); return;
      }
      if (c === 'c') { s.contextBumpAcked[modelKey] = true; overlay = null; await persistSettings(); draw(); return; }
      if (k.name === 'escape') { overlay = null; draw(); return; }
      return;
    }

    if (overlay === 'context-full') {
      const c = (ch || '').toLowerCase();
      if (c === 'c') { s.usedTokens = 0; ctxFullShown = false; overlay = null; activity.push('✓ Context reset'); await persistSettings(); draw(); return; }
      if (c === 'n') { await doNew(); overlay = null; draw(); return; }
      if (k.name === 'escape') { overlay = null; draw(); return; }
      return;
    }

    if (overlay === 'doctor') {
      const c = (ch || '').toLowerCase();
      if (c === 'd') { doctorDetails = !doctorDetails; draw(); return; }
      if (k.name === 'escape') { overlay = null; draw(); return; }
      return;
    }

    if (overlay === 'settings' || overlay === 'status') {
      if (k.name === 'escape') { overlay = null; draw(); return; }
      if (overlay === 'settings' && (ch || '').toLowerCase() === 'e') { overlay = 'settings-edit'; s.input = ''; draw(); return; }
      return;
    }

    if (overlay === 'error') {
      const c = (ch || '').toLowerCase();
      const n = ch && /[1-9]/.test(ch) ? Number(ch) : null;
      if (c === 'd') { errorState.showDetails = !errorState.showDetails; draw(); return; }
      if (k.name === 'escape') { overlay = null; draw(); return; }
      if (n && errorState.onAction) { errorState.onAction(n); return; }
      return;
    }

    if (overlay === 'runtime-stopped') {
      const c = (ch || '').toLowerCase();
      if (c === 's') { await tryStartLastRuntime(); return; }
      if (c === 'm') { overlay = null; await openModelPicker(); return; }
      if (c === 'd') { overlay = null; await openDoctor(true); return; }
      if (k.name === 'escape') { overlay = null; draw(); return; }
      return;
    }

    if (overlay === 'first-run-recommend') {
      const c = (ch || '').toLowerCase();
      if (c === 'y') { startFirstRunDownload(); return; }
      if (c === 'a' && firstRunRec.alternatives.length) {
        pickerState = {
          kind: 'first-run-alt', title: 'Alternatives', index: 0,
          items: firstRunRec.alternatives.map((a) => ({ label: a.model.name, provider: a.fit.label, status: `${a.model.download_size_gb}GB`, _model: a.model })),
          hint: 'Enter select · Esc back',
        };
        applyFilter(pickerState);
        overlay = 'picker'; draw();
        return;
      }
      if (c === 'n' || k.name === 'escape') { overlay = null; s.firstRunDone = true; await persistSettings(); s.model = { name: '<model>', locality: 'Cloud', backend: 'remote', provider: '<provider>', cost: '$...' }; draw(); return; }
      return;
    }
    if (overlay === 'first-run-progress') {
      if (k.name === 'escape') { if (firstRunDownloadManager && firstRunJobId) firstRunDownloadManager.cancel(firstRunJobId); overlay = null; draw(); return; }
      return;
    }
    if (overlay === 'first-run-done') {
      if (k.name === 'return' || k.name === 'escape') { overlay = null; draw(); return; }
      return;
    }
    if (overlay === 'first-run-failed') {
      const c = (ch || '').toLowerCase();
      if (c === 'r') { overlay = 'first-run-recommend'; draw(); return; }
      if (k.name === 'escape') { overlay = null; s.firstRunDone = true; await persistSettings(); draw(); return; }
      return;
    }

    if (k.ctrl && k.name === 'c') { restore(); process.exit(0); }
    else if (k.name === 'return') await submit();
    else if (k.name === 'escape') {
      if (generating && genAbort) { genAbort.abort(); activity.push('○ Cancelling… (runtime untouched)'); draw(); }
      else { s.input = ''; draw(); }
    }
    else if (k.name === 'tab' && k.shift) {
      s.approval = s.approval === 'ask' ? 'full-auto' : 'ask';
      s.settings.approvalBehavior = s.approval;
      activity.push(`✓ Approval: ${s.approval}` + (s.approval === 'full-auto' ? ' (explicit opt-in — recorded)' : ''));
      await persistSettings(); draw();
    }
    else if (k.name === 'tab') { setMode(s.mode === 'Plan' ? 'Act' : 'Plan'); }
    else if (k.ctrl && k.name === 'p') { openPalette(); }
    else if (k.name === 'backspace') { s.input = s.input.slice(0, -1); draw(); }
    else if (ch && ch.length === 1 && !k.ctrl && !k.meta) {
      const wasEmpty = !s.input;
      s.input += ch;
      // Windows readline may omit key.name for punctuation. Trigger after
      // committing the character so `/` follows the same path everywhere.
      if (wasEmpty && ch === '/') openSlashMenu();
      else if (wasEmpty && ch === '@') openFilePicker();
      else draw();
    }
  });

  // Keep this function from returning while the session is interactive.
  // Everything above only REGISTERS listeners (keypress, SIGINT) — it does
  // not block. Without this, the async function's implicit return resolves
  // the caller's `await runTui(...)` almost immediately, and
  // bin/botconnector.mjs's very next line is an unconditional
  // process.exit(0) — which fires before the terminal has rendered a
  // single frame. Every actual exit path already calls process.exit(0)
  // directly from inside a handler (Ctrl+C, /exit, the Exit menu item),
  // which terminates the process immediately regardless of this pending
  // promise, so this never delays a real exit by even one tick.
  //
  // This was invisible to every test this project has ever run against the
  // bare TUI: none of them attach a genuine TTY (piped/automated stdin
  // always takes the `!canRaw` fallback above, which is SUPPOSED to print
  // once and return). Found live, in a real Windows Terminal + PowerShell
  // session, run by a human — the alternate-screen-buffer switch this
  // function does right before setup even hid the symptom: entering and
  // then immediately exiting the alt-screen on a premature process.exit()
  // looks identical to "nothing happened," not a visible crash.
  await new Promise(() => {});
}

module.exports = { runTui };
