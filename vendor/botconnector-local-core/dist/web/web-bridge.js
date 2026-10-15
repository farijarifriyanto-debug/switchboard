// Replaces Electron's contextBridge/ipcRenderer with plain fetch()/SSE calls
// against the local `botconnector ui` HTTP server (webui/server.cjs).
// desktop.js is loaded unmodified after this file and only ever talks to
// window.botconnector — this file exists purely to give that same object an
// HTTP transport instead of an IPC one, so no view code changes.
(() => {
  // The page's CSP is style-src 'self' (blocks inline style="" attributes
  // AND element.style.cssText/property assignments alike — confirmed live).
  // Every rule this file's own UI bolt-ons need lives in this external,
  // same-origin stylesheet instead, so nothing here needs 'unsafe-inline'.
  const styleLink = document.createElement('link');
  styleLink.rel = 'stylesheet';
  styleLink.href = 'web-bridge.css';
  document.head.appendChild(styleLink);

  let sessionSecret = null;
  const sessionReady = fetch('/api/session', { credentials: 'omit' })
    .then(r => r.json())
    .then(j => { sessionSecret = j.secret; })
    .catch(e => { console.error('BotConnector UI: failed to establish local session', e); });

  async function call(path, { method = 'GET', body } = {}) {
    await sessionReady;
    const headers = { 'X-BotConnector-Session': sessionSecret || '' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'omit' });
    let data = null;
    try { data = await res.json(); } catch { /* empty body is fine for e.g. DELETE */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed: ${res.status}`);
    return data;
  }
  const get = (p) => call(p);
  const post = (p, body = {}) => call(p, { method: 'POST', body });
  const del = (p) => call(p, { method: 'DELETE' });

  // ---------- server-sent event bus (download/runtime-install progress) ----------
  const listeners = { 'download:progress': new Set(), 'runtime:install-progress': new Set() };
  sessionReady.then(() => {
    if (!sessionSecret) return;
    const es = new EventSource(`/api/events?s=${encodeURIComponent(sessionSecret)}`);
    es.onmessage = (ev) => {
      try {
        const { type, payload } = JSON.parse(ev.data);
        for (const cb of (listeners[type] || [])) cb(payload);
      } catch {}
    };
  });
  function on(type, cb) { listeners[type].add(cb); return () => listeners[type].delete(cb); }

  // ---------- chat streaming (fetch-based SSE consumption; POST, not GET, so EventSource can't be used) ----------
  const chatListeners = { delta: new Set(), reasoning: new Set(), toolcall: new Set(), toolresult: new Set(), done: new Set(), error: new Set() };
  function onChat(kind, cb) { chatListeners[kind].add(cb); return () => chatListeners[kind].delete(cb); }
  async function streamChat({ requestId, messages, options }) {
    await sessionReady;
    const res = await fetch('/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BotConnector-Session': sessionSecret || '' }, body: JSON.stringify({ requestId, messages, options }), credentials: 'omit' });
    if (!res.ok || !res.body) { for (const cb of chatListeners.error) cb({ requestId, error: `stream failed: ${res.status}` }); return; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split('\n\n'); buf = frames.pop() || '';
      for (const frame of frames) {
        const line = frame.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
        try {
          const msg = JSON.parse(line.slice(5).trim());
          const kind = msg.type?.replace('chat:', '');
          for (const cb of (chatListeners[kind] || [])) cb(msg);
        } catch {}
      }
    }
  }

  window.botconnector = {
    overview: () => get('/api/overview'),
    openExternal: (u) => { try { window.open(u, '_blank', 'noopener,noreferrer'); } catch {} return Promise.resolve(true); },

    getSettings: () => get('/api/settings'),
    setSettings: (v) => post('/api/settings', v),
    setHfToken: (t) => post('/api/settings/hf-token', { token: t }),
    ensureApiToken: () => post('/api/settings/api-token'),
    clearApiToken: () => del('/api/settings/api-token'),
    pickModelsDir: () => post('/api/settings/models-dir'),

    cloudStatus: () => get('/api/cloud/status'),
    cloudSetKey: (p) => post('/api/cloud/key', p),
    cloudRemoveKey: (provider) => del(`/api/cloud/key/${encodeURIComponent(provider)}`),
    cloudModels: (o) => post('/api/cloud/models', o || {}),
    cloudUsage: () => get('/api/cloud/usage'),
    cloudBudgetSet: (p) => post('/api/cloud/budget', p),
    cloudChat: (p) => post('/api/cloud/chat', p),

    mcpList: () => get('/api/mcp'),
    mcpSave: (c) => post('/api/mcp', c),
    mcpRemove: (id) => del(`/api/mcp/${encodeURIComponent(id)}`),
    mcpTest: (id) => post(`/api/mcp/${encodeURIComponent(id)}/test`),
    mcpInvoke: ({ id, tool, args }) => post(`/api/mcp/${encodeURIComponent(id)}/invoke`, { tool, args }),

    searchModels: (i) => post('/api/models/search', i),
    modelDetails: (id) => post('/api/models/details', { id }),
    installedModels: () => get('/api/models/installed'),
    revealModel: (p) => post('/api/models/reveal', { path: p }),
    deleteModel: (dir) => post('/api/models/delete', { dir }),
    downloadModel: (p) => post('/api/models/download', p),

    downloads: () => get('/api/downloads'),
    pauseDownload: (id) => post(`/api/downloads/${encodeURIComponent(id)}/pause`),
    resumeDownload: (id) => post(`/api/downloads/${encodeURIComponent(id)}/resume`),
    cancelDownload: (id) => post(`/api/downloads/${encodeURIComponent(id)}/cancel`),
    onDownloadProgress: (cb) => on('download:progress', cb),

    pickBinary: () => post('/api/dialog/file', { title: 'Choose llama-server.exe', filterName: 'llama-server', extensions: ['exe'] }),
    pickModel: () => post('/api/dialog/file', { title: 'Choose a GGUF model', filterName: 'GGUF', extensions: ['gguf'] }),
    latestRuntime: () => get('/api/runtime/latest'),
    resolveRuntime: (c) => post('/api/runtime/resolve', c),
    verifyRuntime: () => get('/api/runtime/verify'),
    managedRuntime: () => get('/api/runtime/managed-status'),
    installRuntime: (c) => post('/api/runtime/install', c),
    startRuntime: (c) => post('/api/runtime/start', c),
    startInstalled: (c) => post('/api/runtime/start-installed', c),
    stopRuntime: () => post('/api/runtime/stop'),
    runtimeStatus: () => get('/api/runtime/status'),
    runtimeLogs: () => get('/api/runtime/logs'),
    onRuntimeInstallProgress: (cb) => on('runtime:install-progress', cb),

    chat: (m) => post('/api/chat/complete', m),
    pickImage: () => post('/api/chat/pick-image'),
    streamChat: (p) => { streamChat(p); },
    onChatDelta: (cb) => onChat('delta', cb),
    onChatReasoning: (cb) => onChat('reasoning', cb),
    onChatToolCall: (cb) => onChat('toolcall', cb),
    onChatToolResult: (cb) => onChat('toolresult', cb),
    onChatDone: (cb) => onChat('done', cb),
    onChatError: (cb) => onChat('error', cb),

    quit: () => post('/api/quit'),

    agentTask: (p) => post('/api/agent/task', p),
    agentApply: (p) => post('/api/agent/apply', p),
  };

  // ---------- portable-only "Quit BotConnector" control ----------
  // Electron has no equivalent of this: its window close / Alt+F4 already
  // ends the whole app. A browser tab close must NOT stop the background
  // core (other tabs, or a deliberate "leave it running" choice, are valid)
  // — quitting the core process is only ever a deliberate, explicit action.
  // Injected here (not in desktop.js/index.html) so the shared renderer
  // stays byte-identical between Electron and the portable build; this is
  // pure DOM bolt-on, added once the page's own script has finished
  // rendering the sidebar it attaches to.
  function injectQuitControl() {
    const host = document.querySelector('.side-bottom');
    if (!host || document.getElementById('bcQuitBtn')) return;
    // In-page confirm, not window.confirm(): a native dialog blocks the
    // page's own render/script thread until dismissed, which is both a
    // jarring UX pattern and unreliable to drive from automated tooling.
    const btn = document.createElement('button');
    btn.id = 'bcQuitBtn';
    btn.textContent = '⏻ Quit BotConnector';
    const confirmRow = document.createElement('div');
    confirmRow.id = 'bcQuitConfirm';
    confirmRow.hidden = true;
    const msg = document.createElement('div');
    msg.className = 'bc-msg';
    msg.textContent = 'Stop the local server and any running local model?';
    const yesBtn = document.createElement('button');
    yesBtn.textContent = 'Yes, quit';
    const noBtn = document.createElement('button');
    noBtn.textContent = 'Cancel';
    confirmRow.appendChild(msg);
    confirmRow.appendChild(yesBtn);
    confirmRow.appendChild(noBtn);
    btn.onclick = () => { btn.hidden = true; confirmRow.hidden = false; };
    noBtn.onclick = () => { confirmRow.hidden = true; btn.hidden = false; };
    yesBtn.onclick = async () => {
      yesBtn.disabled = true; noBtn.disabled = true;
      msg.textContent = 'Stopping…';
      try {
        await window.botconnector.quit();
      } catch (e) {
        console.error('quit failed', e);
      }
      document.body.innerHTML = '';
      const overlay = document.createElement('div');
      overlay.className = 'bc-stopped-overlay';
      overlay.textContent = 'BotConnector has stopped. You can close this tab.';
      document.body.appendChild(overlay);
    };
    host.appendChild(btn);
    host.appendChild(confirmRow);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectQuitControl);
  else injectQuitControl();

  // ---------- minimal first-run experience ----------
  // One screen, three choices, done — not a wizard. Persisted via the same
  // settings.json every other interface already reads/writes
  // (firstRunCompleted/firstRunMode), so it never shows twice unless the
  // user deliberately reopens it from Settings.
  function fmtGb(n) { return (n == null ? '—' : `${n} GB`); }
  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    for (const c of children || []) node.appendChild(c);
    return node;
  }
  async function maybeShowFirstRun(force) {
    let settings, overview;
    try {
      settings = await window.botconnector.getSettings();
      if (!force && settings.firstRunCompleted) return;
      overview = await window.botconnector.overview();
    } catch (e) { console.error('first-run: could not load state', e); return; }
    const hw = overview.hardware || {};
    const gpu = (hw.nvidia || [])[0];
    const runtimeInstalled = Boolean(overview.managedRuntime && overview.managedRuntime.installed);
    const ramGb = hw.ramGb;
    const localLooksViable = typeof ramGb === 'number' && ramGb >= 8;
    const recommendation = localLooksViable ? 'local' : 'cloud';

    const specs = el('div', { className: 'bc-specs' }, [
      el('div', { innerHTML: `<span>RAM</span><br><b>${fmtGb(ramGb)}</b>` }),
      el('div', { innerHTML: `<span>GPU / VRAM</span><br><b>${gpu ? `${gpu.name} · ${fmtGb(gpu.memoryGb)}` : 'Not detected'}</b>` }),
      el('div', { innerHTML: `<span>Local runtime</span><br><b>${runtimeInstalled ? 'Installed' : 'Not installed yet'}</b>` }),
    ]);
    const autoBtn = el('button', { id: 'bcFrAuto', className: 'primary', textContent: `Auto — Recommended (${recommendation === 'local' ? 'Local AI' : 'Cloud AI'} looks like the best fit for this PC)` });
    const localBtn = el('button', { id: 'bcFrLocal', textContent: 'Local AI' });
    const cloudBtn = el('button', { id: 'bcFrCloud', textContent: 'Cloud AI' });
    const card = el('div', { className: 'bc-card' }, [
      el('h2', { textContent: 'BotConnector' }),
      el('p', { className: 'bc-sub', textContent: 'Detected on this PC' }),
      specs,
      el('p', { className: 'bc-choose-label', textContent: 'How do you want to use BotConnector?' }),
      el('p', { className: 'bc-explain', innerHTML: "<b>Local AI</b> runs on this PC's own CPU/GPU — no per-message cost, but it uses your own hardware's compute and power, and performance depends on this machine. It is not a cloud service.<br><b>Cloud AI</b> sends prompts to a hosted provider you configure (your own API key); pricing/free-tier terms follow that provider." }),
      el('div', { className: 'bc-choices' }, [autoBtn, localBtn, cloudBtn]),
      el('p', { className: 'bc-note', textContent: 'You can change this anytime from Settings.' }),
    ]);
    const backdrop = el('div', { id: 'bcFirstRun' }, [card]);
    document.body.appendChild(backdrop);

    async function choose(mode, view) {
      try { await window.botconnector.setSettings({ firstRunCompleted: true, firstRunMode: mode }); } catch (e) { console.error(e); }
      backdrop.remove();
      if (typeof window.navigate === 'function') window.navigate(view);
    }
    autoBtn.onclick = () => choose('auto', recommendation === 'local' ? 'runtime' : 'cloud');
    localBtn.onclick = () => choose('local', 'runtime');
    cloudBtn.onclick = () => choose('cloud', 'cloud');
  }
  function injectReopenSetupLink() {
    const panel = document.querySelector('#view-settings .two-col');
    if (!panel || document.getElementById('bcReopenSetup')) return;
    const reopenBtn = el('button', { className: 'ghost top-gap-small', id: 'bcReopenSetup', textContent: 'Reopen setup' });
    const article = el('article', { className: 'panel' }, [
      el('span', { className: 'kicker', textContent: 'SETUP' }),
      el('h2', { textContent: 'First-run setup' }),
      el('p', { className: 'technical-note', textContent: "Re-detect this PC's hardware and choose Local AI / Cloud AI / Auto again." }),
      reopenBtn,
    ]);
    panel.appendChild(article);
    reopenBtn.onclick = () => maybeShowFirstRun(true);
  }
  sessionReady.then(() => {
    maybeShowFirstRun(false);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectReopenSetupLink);
    else injectReopenSetupLink();
  });

  // ---------- minimal browser Agent view (Section 5) ----------
  // Reuses existing desktop.css classes (.panel/.button-row/.log-box/etc.)
  // wherever they already fit, so this needs no new stylesheet rules.
  // Deliberately minimal per product decision: one prompt in, one proposal
  // (diff or command) out, approve/reject, apply, plain result — no
  // multi-step task timeline, no session resume across a restart.
  function injectAgentView() {
    if (document.getElementById('view-agent')) return;
    const main = document.querySelector('main');
    const sidebarNav = document.querySelector('.sidebar nav');
    if (!main || !sidebarNav) return;

    const navBtn = el('button', { textContent: '⚙ Agent (browser)' });
    navBtn.dataset.view = 'agent';
    sidebarNav.appendChild(navBtn);

    const workspaceInput = el('input', { id: 'bcAgentWorkspace', placeholder: 'C:\\path\\to\\your\\project' });
    const promptInput = el('textarea', { id: 'bcAgentPrompt', rows: 3, placeholder: 'e.g. Add a subtract function to src/math.js and export it' });
    const sendBtn = el('button', { className: 'primary', id: 'bcAgentSend', textContent: 'Send' });
    const status = el('div', { className: 'inline-status', id: 'bcAgentStatus' });
    const askPanel = el('article', { className: 'panel' }, [
      el('label', { textContent: 'Workspace folder' }, [workspaceInput]),
      el('label', { textContent: 'What do you want the agent to do?' }, [promptInput]),
      el('div', { className: 'button-row' }, [sendBtn]),
      status,
    ]);

    const approvalTitle = el('h3', { id: 'bcAgentApprovalTitle', textContent: 'Proposed change' });
    const diffBox = el('pre', { className: 'log-box', id: 'bcAgentDiff' });
    const approveBtn = el('button', { className: 'primary', id: 'bcAgentApprove', textContent: 'Approve' });
    const rejectBtn = el('button', { className: 'danger', id: 'bcAgentReject', textContent: 'Reject' });
    const approvalPanel = el('article', { className: 'panel top-gap', id: 'bcAgentApprovalPanel', hidden: true }, [
      approvalTitle, diffBox, el('div', { className: 'button-row' }, [approveBtn, rejectBtn]),
    ]);

    const resultBox = el('pre', { className: 'log-box', id: 'bcAgentResult' });
    const resultPanel = el('article', { className: 'panel top-gap', id: 'bcAgentResultPanel', hidden: true }, [
      el('h3', { textContent: 'Result' }), resultBox,
    ]);

    const section = el('section', { id: 'view-agent', className: 'view' }, [
      el('div', { className: 'section-head' }, [
        el('div', {}, [
          el('span', { className: 'kicker', textContent: 'NATIVE AGENT' }),
          el('h2', { textContent: 'Agent (browser)' }),
          el('p', { textContent: 'Reads/edits files and runs commands in the workspace you point it at. Every file change or command needs your approval before anything happens.' }),
        ]),
      ]),
      askPanel, approvalPanel, resultPanel,
    ]);
    main.appendChild(section);

    navBtn.onclick = () => { if (typeof window.navigate === 'function') window.navigate('agent'); };

    let currentTaskId = null;
    function resetPanels() { approvalPanel.hidden = true; resultPanel.hidden = true; currentTaskId = null; }
    function showResult(answer) { resultBox.textContent = answer || '(no answer)'; resultPanel.hidden = false; approvalPanel.hidden = true; }

    sendBtn.onclick = async () => {
      const workspace = workspaceInput.value.trim();
      const prompt = promptInput.value.trim();
      if (!workspace) { status.textContent = 'Enter a workspace folder first.'; return; }
      if (!prompt) { status.textContent = 'Describe what you want the agent to do.'; return; }
      resetPanels();
      sendBtn.disabled = true;
      status.textContent = 'Working…';
      try {
        const r = await window.botconnector.agentTask({ prompt, workspace });
        if (r.status === 'needsApproval') {
          currentTaskId = r.taskId;
          approvalTitle.textContent = r.kind === 'command' ? 'Proposed command' : `Proposed ${r.kind}`;
          diffBox.textContent = r.detail;
          approvalPanel.hidden = false;
          status.textContent = 'Review before approving.';
        } else {
          showResult(r.answer);
          status.textContent = r.blocked ? 'Blocked.' : r.failed ? 'Failed.' : 'Done.';
        }
      } catch (e) {
        status.textContent = `Error: ${e.message || e}`;
      } finally {
        sendBtn.disabled = false;
      }
    };
    approveBtn.onclick = async () => {
      if (!currentTaskId) return;
      approveBtn.disabled = true; rejectBtn.disabled = true;
      status.textContent = 'Applying…';
      try {
        const r = await window.botconnector.agentApply({ taskId: currentTaskId, approved: true });
        showResult(r.answer);
        status.textContent = r.failed ? 'Apply failed.' : 'Applied.';
      } catch (e) {
        status.textContent = `Error: ${e.message || e}`;
      } finally {
        approveBtn.disabled = false; rejectBtn.disabled = false;
      }
    };
    rejectBtn.onclick = async () => {
      if (!currentTaskId) return;
      approveBtn.disabled = true; rejectBtn.disabled = true;
      try {
        const r = await window.botconnector.agentApply({ taskId: currentTaskId, approved: false });
        showResult(r.answer);
        status.textContent = 'Rejected.';
      } catch (e) {
        status.textContent = `Error: ${e.message || e}`;
      } finally {
        approveBtn.disabled = false; rejectBtn.disabled = false;
      }
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectAgentView);
  else injectAgentView();
})();
