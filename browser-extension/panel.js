// Switchboard Browser Companion — Side Panel Controller (Chrome & Edge)
// Connects to Switchboard agent harness, streams SSE chat, controls browser tools,
// manages permission modes, records/replays workflows, and inspects DOM/logs.

const $ = (id) => document.getElementById(id);

let currentSessionId = null;
let activeRunAbortController = null;
let lastPrompt = '';
let isRunning = false;
let isRecording = false;
let currentTab = null;
let bridgeUrl = 'http://127.0.0.1:7778';
let companionToken = '';
let tokenUsage = { prompt: 0, completion: 0 };
let recordedWorkflowSteps = [];

// -----------------------------------------------------------------------------
// UI Utilities & Theme
// -----------------------------------------------------------------------------
function setBadge(state, label) {
  const badge = $('companion-badge');
  badge.className = `badge ${state}`;
  badge.textContent = label;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('sb_theme', theme);
}

$('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// Tab navigation
document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const target = $(btn.getAttribute('data-tab'));
    if (target) target.classList.add('active');
  });
});

// -----------------------------------------------------------------------------
// Tab & State Synchronization
// -----------------------------------------------------------------------------
async function refreshActiveTab() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_GET_CAPTURE' });
    if (res?.ok && res.data) {
      currentTab = res.data;
      $('active-tab-title').textContent = currentTab.title || 'Untitled';
      $('active-tab-origin').textContent = currentTab.origin || currentTab.url || 'None';

      const { approvedOrigins = [], permissionMode = 'ask_every_time' } = await chrome.storage.local.get([
        'approvedOrigins',
        'permissionMode',
      ]);
      const isAllowed = approvedOrigins.includes(currentTab.origin);
      $('site-permission-status').textContent = isAllowed
        ? `Approved (${permissionMode})`
        : `Read-only / Unapproved (${permissionMode})`;
      $('approved-origins-view').textContent = approvedOrigins.join('\n') || 'None';
    } else {
      $('active-tab-title').textContent = 'No active capture';
      $('active-tab-origin').textContent = 'Click "Capture" on an HTTP(S) tab.';
    }
  } catch (err) {
    $('active-tab-title').textContent = 'Error: ' + err.message;
  }
}

// -----------------------------------------------------------------------------
// Switchboard Host Connection & Pairing
// -----------------------------------------------------------------------------
async function loadStoredConfig() {
  const stored = await chrome.storage.local.get(['bridgeUrl', 'companionToken', 'permissionMode', 'workflowSteps']);
  if (stored.bridgeUrl) bridgeUrl = stored.bridgeUrl;
  if (stored.companionToken) companionToken = stored.companionToken;
  if (stored.permissionMode) $('permission-mode-select').value = stored.permissionMode;
  if (Array.isArray(stored.workflowSteps)) {
    recordedWorkflowSteps = stored.workflowSteps;
    renderWorkflowSteps();
  }
  $('bridge-url-input').value = bridgeUrl;
  $('bridge-token-input').value = companionToken;
}

let bridgeCommandAbort = null;

function startBridgeCommandListener() {
  if (bridgeCommandAbort) bridgeCommandAbort.abort();
  const controller = new AbortController();
  bridgeCommandAbort = controller;
  const endpoint = bridgeUrl;
  const token = companionToken;
  (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(endpoint + '/api/browser-companion/events', {
          headers: { authorization: 'Bearer ' + token },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error('Bridge events HTTP ' + response.status);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const kind = frame.match(/(?:^|\n)event: ([^\n]+)/)?.[1];
            const raw = frame.match(/(?:^|\n)data: ([^\n]+)/)?.[1];
            if (kind !== 'command' || !raw) continue;
            const command = JSON.parse(raw);
            let result, ok = true, error;
            try {
              const reply = await chrome.runtime.sendMessage({
                type: 'SWITCHBOARD_EXECUTE_TOOL', tool: command.tool, args: command.args || {},
              });
              if (!reply?.ok) throw new Error(reply?.error || 'Browser tool rejected');
              result = reply;
            } catch (e) { ok = false; error = String(e?.message || e); }
            await fetch(endpoint + '/api/browser-companion/response', {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
              body: JSON.stringify({ id: command.id, ok, ...(ok ? { result } : { error }) }),
              signal: controller.signal,
            });
          }
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        $('bridge-diagnostics').textContent = 'Bridge reconnecting: ' + String(error?.message || error);
      }
      if (!controller.signal.aborted) await new Promise(r => setTimeout(r, 1200));
    }
  })();
}

async function connectToSwitchboard() {
  bridgeUrl = $('bridge-url-input').value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:7778';
  companionToken = $('bridge-token-input').value.trim();
  $('bridge-diagnostics').textContent = `Connecting to ${bridgeUrl}...`;

  try {
    // 1. Handshake / Pairing with Switchboard
    const pairRes = await fetch(`${bridgeUrl}/api/browser-companion/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: companionToken }),
    });

    if (!pairRes.ok) {
      const err = await pairRes.json().catch(() => ({ error: pairRes.statusText }));
      throw new Error(`Pairing failed (${pairRes.status}): ${err.error || 'Check host URL and token'}`);
    }

    const pairData = await pairRes.json();
    companionToken = pairData.token;
    await chrome.storage.local.set({ bridgeUrl, companionToken, bridgeConnected: true });

    startBridgeCommandListener();
    setBadge('connected', 'Connected');
    $('bridge-diagnostics').textContent = `Successfully paired with Switchboard!\nMode: ${pairData.mode}\nApproved origins: ${pairData.approvedOrigins.length}`;

    // 2. Fetch available models from Switchboard
    await fetchAvailableModels();
  } catch (err) {
    setBadge('disconnected', 'Disconnected');
    $('bridge-diagnostics').textContent = `Connection error:\n${err.message}\n\nTroubleshooting:\n- Make sure Switchboard is running (e.g. "sbx web" or host active)\n- Verify port matches (default 7778)\n- Check that loopback host 127.0.0.1 is accessible`;
  }
}

async function fetchAvailableModels() {
  try {
    const res = await fetch(`${bridgeUrl}/api/state`, {
      headers: companionToken ? { authorization: `Bearer ${companionToken}` } : {},
    });
    if (res.ok) {
      const state = await res.json();
      if (Array.isArray(state.models) && state.models.length > 0) {
        const select = $('model-select');
        select.innerHTML = '';
        state.models.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m.provider && m.provider !== 'default' ? `${m.provider}::${m.id}` : m.id;
          opt.textContent = `${m.id}${m.providerName ? ` · ${m.providerName}` : ''}`;
          select.appendChild(opt);
        });
      }
    }
  } catch (_) {}
}

$('connect-bridge-btn').addEventListener('click', () => connectToSwitchboard());
$('disconnect-bridge-btn').addEventListener('click', async () => {
  if (bridgeCommandAbort) bridgeCommandAbort.abort();
  bridgeCommandAbort = null;
  await chrome.storage.local.set({ bridgeConnected: false });
  setBadge('disconnected', 'Disconnected');
  $('bridge-diagnostics').textContent = 'Disconnected from Switchboard.';
});

// -----------------------------------------------------------------------------
// Agent Chat Loop & SSE Streaming
// -----------------------------------------------------------------------------
function appendMessage(role, text) {
  const list = $('messages-list');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
  return div;
}

function appendToolCard(toolName, args) {
  const list = $('messages-list');
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.textContent = `🔧 ${toolName}: ${JSON.stringify(args)}`;
  list.appendChild(card);
  list.scrollTop = list.scrollHeight;
  return card;
}

async function sendInstruction(promptText) {
  const prompt = promptText || $('prompt-input').value.trim();
  if (!prompt || isRunning) return;

  lastPrompt = prompt;
  $('prompt-input').value = '';
  appendMessage('user', prompt);

  isRunning = true;
  setBadge('running', 'Running');
  $('send-btn').disabled = true;
  $('stop-btn').disabled = false;
  $('retry-btn').disabled = true;

  const model = $('model-select').value;
  const preset = $('preset-select').value;

  activeRunAbortController = new AbortController();
  const assistantMsg = appendMessage('assistant', '');

  try {
    // Sync current browser tab state to Switchboard before turn starts
    await syncCurrentTabToBridge();

    const response = await fetch(`${bridgeUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(companionToken ? { authorization: `Bearer ${companionToken}` } : {}),
      },
      body: JSON.stringify({
        prompt,
        model,
        preset,
        sessionId: currentSessionId,
      }),
      signal: activeRunAbortController.signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(`Agent error (${response.status}): ${err.error || 'Request failed'}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('data: ')) {
          try {
            const ev = JSON.parse(line.slice(6));
            handleAgentEvent(ev, assistantMsg);
          } catch (_) {}
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      assistantMsg.textContent += '\n[⏹ Stopped by user]';
    } else {
      assistantMsg.textContent += `\n[⚠️ Error: ${err.message}]`;
    }
  } finally {
    isRunning = false;
    setBadge('connected', 'Connected');
    $('send-btn').disabled = false;
    $('stop-btn').disabled = true;
    $('retry-btn').disabled = false;
    activeRunAbortController = null;
    await refreshActiveTab();
    await refreshAuditLog();
  }
}

function handleAgentEvent(ev, assistantMsg) {
  if (ev.type === 'session') {
    currentSessionId = ev.sessionId;
  } else if (ev.type === 'text' || ev.type === 'chunk') {
    assistantMsg.textContent += ev.content || ev.text || '';
    $('messages-list').scrollTop = $('messages-list').scrollHeight;
  } else if (ev.type === 'tool' || ev.type === 'tool_call') {
    appendToolCard(ev.name || ev.tool, ev.args || {});
  } else if (ev.type === 'approval_request') {
    showApprovalBanner(ev);
  } else if (ev.type === 'usage' || ev.usage) {
    const u = ev.usage || ev;
    tokenUsage.prompt += Number(u.promptTokens || u.inputTokens || 0);
    tokenUsage.completion += Number(u.completionTokens || u.outputTokens || 0);
    const cost = ((tokenUsage.prompt * 0.15 + tokenUsage.completion * 0.6) / 1_000_000).toFixed(4);
    $('token-usage-bar').textContent = `Tokens: ${tokenUsage.prompt} in / ${tokenUsage.completion} out · Est. cost: $${cost}`;
  }
}

async function syncCurrentTabToBridge() {
  if (!currentTab) return;
  try {
    const { approvedOrigins = [], permissionMode = 'ask_every_time' } = await chrome.storage.local.get([
      'approvedOrigins',
      'permissionMode',
    ]);
    await fetch(`${bridgeUrl}/api/browser-companion/status`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(companionToken ? { authorization: `Bearer ${companionToken}` } : {}),
      },
      body: JSON.stringify({
        activeTab: {
          id: currentTab.id,
          title: currentTab.title,
          url: currentTab.url,
          auditedOrigin: currentTab.origin,
        },
        approvedOrigins,
        mode: permissionMode,
      }),
    });
  } catch (_) {}
}

$('send-btn').addEventListener('click', () => sendInstruction());
$('prompt-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendInstruction();
  }
});

$('stop-btn').addEventListener('click', async () => {
  if (activeRunAbortController) {
    activeRunAbortController.abort();
  }
  if (currentSessionId) {
    try {
      await fetch(`${bridgeUrl}/api/runs/${encodeURIComponent(currentSessionId)}/cancel`, {
        method: 'POST',
        headers: companionToken ? { authorization: `Bearer ${companionToken}` } : {},
      });
    } catch (_) {}
  }
});

$('retry-btn').addEventListener('click', () => {
  if (lastPrompt) sendInstruction(lastPrompt);
});

// -----------------------------------------------------------------------------
// Approval Banner
// -----------------------------------------------------------------------------
let pendingApprovalResolver = null;

function showApprovalBanner(details) {
  $('approval-desc').textContent = `Action: "${details.tool || 'Browser action'}" on ${details.origin || currentTab?.origin || 'site'}`;
  $('approval-banner').classList.add('visible');
}

function settleApproval(decision) {
  $('approval-banner').classList.remove('visible');
  if (pendingApprovalResolver) {
    pendingApprovalResolver(decision);
    pendingApprovalResolver = null;
  }
}

$('btn-approve-once').addEventListener('click', () => settleApproval('approved'));
$('btn-approve-session').addEventListener('click', () => settleApproval('approved_session'));
$('btn-reject').addEventListener('click', () => settleApproval('rejected'));

// -----------------------------------------------------------------------------
// Inspector & Tools Tab
// -----------------------------------------------------------------------------
$('toolbar-capture-btn').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_REFRESH_CAPTURE' });
  if (res?.ok) {
    await refreshActiveTab();
    renderSnapshotData(res.data);
  }
});

$('refresh-dom-btn').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_REFRESH_CAPTURE' });
  if (res?.ok) {
    await refreshActiveTab();
    renderSnapshotData(res.data);
  }
});

function renderSnapshotData(data) {
  if (!data) return;
  const elements = data.elements || [];
  $('dom-elements-view').textContent =
    elements.map((e) => `${e.ref} <${e.tag}> "${e.text}" [${e.selector}]`).join('\n') || 'No interactive elements detected.';
  $('untrusted-text-view').value = data.text || '';
}

$('capture-screenshot-btn').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_CAPTURE_SCREENSHOT', quality: 65 });
  if (res?.ok && res.dataUrl) {
    $('screenshot-preview').src = res.dataUrl;
    $('screenshot-preview').style.display = 'block';
  } else {
    alert(res?.error || 'Screenshot capture failed');
  }
});

$('list-tabs-btn').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_LIST_TABS' });
  if (res?.ok) {
    $('dom-elements-view').textContent =
      res.tabs.map((t) => `[Tab ${t.id}] ${t.title} (${t.url})${t.active ? ' *ACTIVE*' : ''}`).join('\n') ||
      'No accessible tabs.';
  }
});

$('show-console-logs-btn').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({
    type: 'SWITCHBOARD_EXECUTE_TOOL',
    tool: 'browser_console_logs',
    args: { level: 'all' },
  });
  $('logs-view').style.display = 'block';
  $('logs-view').textContent =
    res?.logs?.map((l) => `[${l.level.toUpperCase()}] ${l.message}`).join('\n') || 'No console logs captured.';
});

$('show-network-errors-btn').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({
    type: 'SWITCHBOARD_EXECUTE_TOOL',
    tool: 'browser_network_errors',
    args: {},
  });
  $('logs-view').style.display = 'block';
  $('logs-view').textContent =
    res?.errors?.map((e) => `[ERR] ${e.url} (status ${e.status})`).join('\n') || 'No network errors recorded.';
});

// -----------------------------------------------------------------------------
// Workflows Tab (Record, Edit, Replay, Schedule)
// -----------------------------------------------------------------------------
function renderWorkflowSteps() {
  const container = $('workflow-steps-list');
  container.innerHTML = '';
  if (recordedWorkflowSteps.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:11px">No workflow steps recorded yet.</div>';
    $('replay-workflow-btn').disabled = true;
    return;
  }
  $('replay-workflow-btn').disabled = false;

  recordedWorkflowSteps.forEach((step, idx) => {
    const item = document.createElement('div');
    item.className = 'step-item';
    item.innerHTML = `
      <span><strong>#${idx + 1}</strong> ${step.action} <code>${step.selector || step.url || ''}</code></span>
      <button class="danger" style="padding:2px 6px;font-size:10px" data-idx="${idx}">✕</button>
    `;
    item.querySelector('button').addEventListener('click', async () => {
      recordedWorkflowSteps.splice(idx, 1);
      await chrome.storage.local.set({ workflowSteps: recordedWorkflowSteps });
      renderWorkflowSteps();
    });
    container.appendChild(item);
  });
}

$('record-workflow-btn').addEventListener('click', () => {
  isRecording = !isRecording;
  if (isRecording) {
    $('record-workflow-btn').textContent = '⏹ Stop Recording';
    $('record-workflow-btn').className = 'danger';
    $('replay-progress-bar').textContent = 'Recording interactions on active tab...';
  } else {
    $('record-workflow-btn').textContent = '⏺ Start Recording';
    $('record-workflow-btn').className = 'secondary';
    $('replay-progress-bar').textContent = 'Recording stopped.';
  }
});

$('replay-workflow-btn').addEventListener('click', async () => {
  if (recordedWorkflowSteps.length === 0) return;
  $('replay-workflow-btn').disabled = true;
  $('cancel-replay-btn').disabled = false;
  $('replay-progress-bar').textContent = 'Replaying workflow...';

  const res = await chrome.runtime.sendMessage({
    type: 'SWITCHBOARD_WORKFLOW_REPLAY',
    steps: recordedWorkflowSteps,
  });

  $('replay-workflow-btn').disabled = false;
  $('cancel-replay-btn').disabled = true;

  if (res?.ok) {
    $('replay-progress-bar').textContent = `Replay completed successfully (${res.results.length} steps)!`;
  } else {
    $('replay-progress-bar').textContent = `Replay finished with failures or was stopped.`;
  }
  await refreshAuditLog();
});

$('cancel-replay-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'SWITCHBOARD_WORKFLOW_CANCEL' });
  $('replay-progress-bar').textContent = 'Replay stopped.';
});

$('export-workflow-btn').addEventListener('click', () => {
  const sanitized = recordedWorkflowSteps.map((step) => {
    const isSensitive = step.selector && (step.selector.includes('password') || step.selector.includes('cc-'));
    return isSensitive ? { ...step, value: '[REDACTED]' } : step;
  });
  const json = JSON.stringify({ version: 1, steps: sanitized }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `switchboard-workflow-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('clear-workflow-btn').addEventListener('click', async () => {
  if (confirm('Clear all recorded workflow steps?')) {
    recordedWorkflowSteps = [];
    await chrome.storage.local.set({ workflowSteps: [] });
    renderWorkflowSteps();
  }
});

$('btn-schedule-wf').addEventListener('click', async () => {
  const cron = $('wf-schedule-cron').value.trim();
  if (!cron) return alert('Enter a valid cron expression.');
  try {
    const res = await fetch(`${bridgeUrl}/api/browser-companion/workflow/schedule`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(companionToken ? { authorization: `Bearer ${companionToken}` } : {}),
      },
      body: JSON.stringify({
        name: `browser-task-${Date.now()}`,
        cron,
        prompt: `Execute browser workflow steps: ${JSON.stringify(recordedWorkflowSteps)}`,
      }),
    });
    if (res.ok) {
      alert('Workflow scheduled in Switchboard automations!');
    } else {
      alert('Failed to schedule workflow: ' + res.statusText);
    }
  } catch (err) {
    alert('Error scheduling: ' + err.message);
  }
});

// -----------------------------------------------------------------------------
// Security & Audit Tab
// -----------------------------------------------------------------------------
$('permission-mode-select').addEventListener('change', async (e) => {
  const mode = e.target.value;
  await chrome.storage.local.set({ permissionMode: mode });
  await syncCurrentTabToBridge();
  await refreshActiveTab();
});

$('allow-current-origin-btn').addEventListener('click', async () => {
  if (!currentTab?.origin) return;
  const { approvedOrigins = [] } = await chrome.storage.local.get('approvedOrigins');
  if (!approvedOrigins.includes(currentTab.origin)) {
    approvedOrigins.push(currentTab.origin);
    await chrome.storage.local.set({ approvedOrigins });
    await syncCurrentTabToBridge();
    await refreshActiveTab();
  }
});

$('revoke-current-origin-btn').addEventListener('click', async () => {
  if (!currentTab?.origin) return;
  const { approvedOrigins = [] } = await chrome.storage.local.get('approvedOrigins');
  const updated = approvedOrigins.filter((o) => o !== currentTab.origin);
  await chrome.storage.local.set({ approvedOrigins: updated });
  await syncCurrentTabToBridge();
  await refreshActiveTab();
});

async function refreshAuditLog() {
  const res = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_GET_AUDIT_LOG' });
  const tbody = $('audit-table-body');
  tbody.innerHTML = '';
  const list = res?.auditLog || [];
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No actions logged yet.</td></tr>';
    return;
  }
  list.slice(0, 50).forEach((entry) => {
    const tr = document.createElement('tr');
    const time = new Date(entry.timestamp).toLocaleTimeString();
    tr.innerHTML = `
      <td>${time}</td>
      <td><strong>${entry.tool}</strong></td>
      <td>${entry.selector || entry.url || entry.action || '-'}</td>
      <td>${entry.decision}</td>
      <td style="color:${entry.status === 'success' ? 'var(--success)' : 'var(--danger)'}">${entry.status}</td>
    `;
    tbody.appendChild(tr);
  });
}

$('refresh-audit-btn').addEventListener('click', refreshAuditLog);
$('clear-audit-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_CLEAR_AUDIT_LOG' });
  await refreshAuditLog();
});

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------
(async function init() {
  const savedTheme = localStorage.getItem('sb_theme') || 'dark';
  applyTheme(savedTheme);
  await loadStoredConfig();
  await refreshActiveTab();
  await refreshAuditLog();
  // Auto connect if token stored
  if (companionToken) {
    connectToSwitchboard();
  }
})();
