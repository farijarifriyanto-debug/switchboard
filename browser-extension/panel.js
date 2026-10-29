// Switchboard Browser Companion — Side Panel Controller (Chrome & Edge)
// Connects to Switchboard agent harness and relays browser tools,
// manages permission modes, records/replays workflows, and inspects DOM/logs.

const $ = (id) => document.getElementById(id);

let isRecording = false;
let currentTab = null;
let bridgeUrl = 'http://127.0.0.1:7778';
let companionToken = '';
// Where the panel's Ask APIs live. Updated from the paired server (the console
// may run on any `--port`); this default only applies to older servers.
let webOrigin = 'http://127.0.0.1:7777';
let recordedWorkflowSteps = [];

// -----------------------------------------------------------------------------
// UI utilities
// -----------------------------------------------------------------------------
function setBadge(state, label) {
  const badge = $('companion-badge');
  badge.className = `badge ${state}`;
  badge.textContent = label;
  const dot = $('conn-dot');
  if (dot) {
    const connected = state === 'connected';
    dot.classList.toggle('on', connected);
    dot.title = connected ? 'Terhubung' : 'Terputus';
    dot.setAttribute('aria-label', dot.title);
  }
}

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
    const res = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_ACTIVE_TAB' });
    if (res?.ok && res.tab) {
      currentTab = res.tab;
      $('active-tab-title').textContent = currentTab.title || 'Untitled';
      $('active-tab-origin').textContent = currentTab.origin || currentTab.url || 'None';
      const chip = $('tab-chip');
      if (chip) { $('tab-chip-title').textContent = currentTab.title || currentTab.origin || 'Tab aktif'; chip.hidden = false; }

      const access = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_SITE_ACCESS_STATUS', origin: currentTab.origin });
      // This indicator reports Chrome's site grant only; action approval is a separate policy.
      $('site-permission-status').textContent = access?.granted ? 'Allowed by Chrome' : 'Permission needed';
      $('approved-origins-view').textContent = (access?.origins || []).join('\n') || 'None';
    } else {
      $('active-tab-title').textContent = 'No active capture';
      if ($('tab-chip')) $('tab-chip').hidden = true;
      $('active-tab-origin').textContent = 'Select an HTTP(S) webpage, then refresh the tab.';
    }
  } catch (err) {
    $('active-tab-title').textContent = 'Error: ' + err.message;
  }
  await updateOverviewStatus();
}

// -----------------------------------------------------------------------------
// Switchboard Host Connection & Pairing
// -----------------------------------------------------------------------------
async function loadStoredConfig() {
  const stored = await chrome.storage.local.get(['bridgeUrl', 'companionToken', 'permissionMode', 'webOrigin', 'workflowSteps']);
  if (stored.bridgeUrl) bridgeUrl = stored.bridgeUrl;
  if (stored.companionToken) companionToken = stored.companionToken;
  const storedWebOrigin = normalizeWebOrigin(stored.webOrigin);
  if (storedWebOrigin) webOrigin = storedWebOrigin;
  const permissionMode = normalizePermissionMode(stored.permissionMode);
  $('permission-mode-select').value = permissionMode;
  if (stored.permissionMode !== permissionMode) await chrome.storage.local.set({ permissionMode });
  updatePermissionModeDescription(permissionMode);
  if (Array.isArray(stored.workflowSteps)) {
    recordedWorkflowSteps = stored.workflowSteps;
    renderWorkflowSteps();
  }
  const recording = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_WORKFLOW_RECORD_STATUS' }).catch(() => null);
  setWorkflowRecordingUi(recording?.recording === true);
  $('bridge-url-input').value = bridgeUrl;
  $('bridge-token-input').value = '';
}

// Pairing is performed by the background worker. The panel is not the transport.
async function refreshBridgeStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_BRIDGE_STATUS' });
    setBadge(status?.connected ? 'connected' : 'disconnected', status?.connected ? 'Connected' : 'Offline');
    if (status?.mode) {
      const serverMode = normalizePermissionMode(status.mode);
      $('permission-mode-select').value = serverMode;
      updatePermissionModeDescription(serverMode);
      await chrome.storage.local.set({ permissionMode: serverMode });
    }
    const serverWebOrigin = normalizeWebOrigin(status?.webOrigin);
    if (serverWebOrigin) webOrigin = serverWebOrigin;
    if (!status?.connected && status?.error) {
      $('bridge-diagnostics').textContent = status.error;
    }
  } catch (_) {
    setBadge('disconnected', 'Offline');
  }
}

async function connectToSwitchboard() {
  bridgeUrl = $('bridge-url-input').value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:7778';
  const code = $('bridge-token-input').value.trim();
  $('bridge-diagnostics').textContent = 'Connecting to the local Switchboard CLI…';
  $('connect-bridge-btn').disabled = true;
  try {
    const reply = await chrome.runtime.sendMessage({
      type: 'SWITCHBOARD_BRIDGE_CONNECT', url: bridgeUrl, code,
    });
    if (!reply?.ok) throw new Error(reply?.error || 'Pairing failed');
    const saved = await chrome.storage.local.get(['companionToken', 'webOrigin']);
    companionToken = saved.companionToken || '';
    const pairedWebOrigin = normalizeWebOrigin(saved.webOrigin);
    if (pairedWebOrigin) webOrigin = pairedWebOrigin;
    $('bridge-token-input').value = '';
    setBadge('connected', 'Connected');
    $('bridge-diagnostics').textContent = 'Paired successfully. This companion remains connected when its panel is closed.';
    await syncCurrentTabToBridge();
  } catch (error) {
    setBadge('disconnected', 'Offline');
    $('bridge-diagnostics').textContent = String(error?.message || error);
  } finally {
    $('connect-bridge-btn').disabled = false;
    await refreshBridgeStatus();
  }
}

$('connect-bridge-btn').addEventListener('click', connectToSwitchboard);
$('disconnect-bridge-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_BRIDGE_DISCONNECT' });
  setBadge('disconnected', 'Offline');
  $('bridge-diagnostics').textContent = 'Disconnected. Start Switchboard and pair again to resume browser control.';
});
setInterval(() => void refreshBridgeStatus(), 5_000);

// Browser prompts belong in Switchboard CLI or Web UI, not in the companion.

async function syncCurrentTabToBridge() {
  try {
    await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_BRIDGE_SYNC_STATUS' });
  } catch (_) {
    // The background worker retries when the local CLI becomes available.
  }
}

// -----------------------------------------------------------------------------
// Approval Banner
// -----------------------------------------------------------------------------
let pendingApprovalId = null;

function showApprovalBanner(details) {
  $('approval-desc').textContent = `Action: ${details.summary || details.tool || 'Browser action'} on ${details.origin || currentTab?.origin || 'site'}`;
  $('approval-banner').classList.add('visible');
  pendingApprovalId = details.id;
}

function approvalActionSummary(item) {
  const args = item.args && typeof item.args === 'object' ? item.args : {};
  const selector = String(args.selector || 'the selected element').slice(0, 180);
  switch (item.tool) {
    case 'browser_click': return `Click ${selector}`;
    case 'browser_type': return typeof args.text === 'string'
      ? `Enter ${args.text.length} characters into ${selector}`
      : `Enter text into ${selector}`;
    case 'browser_select': return `Choose an option in ${selector}`;
    case 'browser_download': return `Download from ${selector}`;
    case 'browser_navigate': {
      try {
        const url = new URL(String(args.url || ''));
        return `Navigate to ${url.origin}${url.pathname}`;
      } catch (_) { return 'Navigate to a website'; }
    }
    case 'browser_scroll': return `Scroll ${String(args.direction || 'down')}`;
    case 'browser_tab_create': return 'Open a new browser tab';
    case 'browser_tab_select': return 'Select a browser tab';
    default: return String(item.tool || 'Browser action');
  }
}

function approvalTargetOrigin(item, fallbackTab) {
  const args = item.args && typeof item.args === 'object' ? item.args : {};
  for (const candidate of [args.targetOrigin, fallbackTab?.origin]) {
    try {
      const url = new URL(String(candidate || ''));
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    } catch (_) { /* Continue to the next source, then show a neutral fallback. */ }
  }
  return 'site';
}

async function refreshActionApproval() {
  if (!activeTask || !activeTaskSession || !companionToken) return;
  try {
    const response = await fetch(webOrigin + '/api/approvals', {
      headers: { authorization: 'Bearer ' + companionToken },
    });
    if (!response.ok) return;
    const state = await response.json();
    const pending = (state.pending || []).find(item => item.sessionId === activeTaskSession);
    if (pending) showApprovalBanner({ id: pending.id, tool: pending.tool, summary: approvalActionSummary(pending), origin: approvalTargetOrigin(pending, currentTab) });
    else if (pendingApprovalId) {
      pendingApprovalId = null;
      $('approval-banner').classList.remove('visible');
    }
  } catch (_) {}
}

async function settleApproval(decision) {
  if (!pendingApprovalId || !companionToken) return;
  const id = pendingApprovalId;
  const buttons = ['btn-approve-once', 'btn-approve-session', 'btn-reject'].map($);
  buttons.forEach(button => { button.disabled = true; });
  try {
    const response = await fetch(webOrigin + '/api/approvals/' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + companionToken },
      body: JSON.stringify({ decision }),
    });
    if (!response.ok) throw new Error('Approval request is no longer pending.');
    pendingApprovalId = null;
    $('approval-banner').classList.remove('visible');
    taskStatus(decision === 'rejected' ? 'Action rejected.' : 'Action approved.');
  } catch (error) {
    taskStatus('Could not submit approval: ' + String(error?.message || error));
  } finally {
    buttons.forEach(button => { button.disabled = false; });
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
    const description = document.createElement('span');
    const label = document.createElement('strong');
    label.textContent = '#' + (idx + 1) + ' ';
    const target = document.createElement('code');
    target.textContent = String(step.selector || step.url || '');
    description.append(label, document.createTextNode(String(step.action || '') + ' '), target);
    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove workflow step ' + (idx + 1));
    remove.addEventListener('click', async () => {
      recordedWorkflowSteps.splice(idx, 1);
      await chrome.storage.local.set({ workflowSteps: recordedWorkflowSteps });
      renderWorkflowSteps();
    });
    item.append(description, remove);
    container.appendChild(item);
  });
}

function setWorkflowRecordingUi(enabled) {
  isRecording = enabled;
  $('record-workflow-btn').textContent = enabled ? '⏹ Hentikan rekaman' : '⏺ Rekam aksi agent';
  $('record-workflow-btn').className = enabled ? 'danger' : 'secondary';
  $('replay-progress-bar').textContent = enabled
    ? 'Merekam aksi agent yang berhasil. Ketikan dan data pribadi tidak disimpan.'
    : 'Status: Tidak merekam';
}
$('record-workflow-btn').addEventListener('click', async () => {
  const next = !isRecording;
  const result = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_WORKFLOW_RECORD_SET', enabled: next }).catch(() => null);
  if (!result?.ok) {
    $('replay-progress-bar').textContent = 'Gagal mengubah status rekaman.';
    return;
  }
  setWorkflowRecordingUi(result.recording);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.workflowSteps && Array.isArray(changes.workflowSteps.newValue)) {
    recordedWorkflowSteps = changes.workflowSteps.newValue;
    renderWorkflowSteps();
  }
});

$('replay-workflow-btn').addEventListener('click', async () => {
  if (recordedWorkflowSteps.length === 0) return;
  const clicks = recordedWorkflowSteps.filter(step => step.action === 'click').length;
  // Workflow replay does not run through the AI agent's action preflight.
  // Review mutating actions explicitly; Chrome host-site permissions remain mandatory.
  if (clicks && !confirm('Replay akan menjalankan ' + clicks + ' klik pada halaman browser. Tinjau daftar langkah dan pastikan situs serta targetnya benar. Lanjutkan?')) return;
  $('replay-workflow-btn').disabled = true;
  $('cancel-replay-btn').disabled = false;
  $('replay-progress-bar').textContent = 'Replaying workflow...';

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'SWITCHBOARD_WORKFLOW_REPLAY',
      steps: recordedWorkflowSteps,
    });
    if (res?.ok) {
      $('replay-progress-bar').textContent = `Replay berhasil (${res.results.length} langkah).`;
    } else {
      $('replay-progress-bar').textContent = res?.cancelled
        ? 'Replay dihentikan setelah aksi yang sedang berjalan.'
        : 'Replay gagal: ' + String(res?.error || res?.results?.find(s => s.status === 'failed')?.error || 'Langkah belum berhasil.');
    }
  } catch (error) {
    $('replay-progress-bar').textContent = 'Replay gagal: ' + String(error?.message || error);
  } finally {
    $('replay-workflow-btn').disabled = false;
    $('cancel-replay-btn').disabled = true;
    await refreshAuditLog();
  }
});

$('cancel-replay-btn').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_WORKFLOW_CANCEL' }).catch(() => null);
  $('replay-progress-bar').textContent = res?.ok
    ? 'Stop diminta. Aksi yang sudah berjalan tidak dapat dibatalkan.'
    : 'Gagal mengirim Stop.';
});

$('export-workflow-btn').addEventListener('click', () => {
  // Old stored workflows may contain typed values. Never export their raw
  // objects: require the same whitelist as imports and strip extra fields.
  let safeSteps;
  try {
    safeSteps = parseWorkflowImport({ version: 1, steps: recordedWorkflowSteps });
  } catch (error) {
    $('replay-progress-bar').textContent = 'Ekspor ditolak: ' + String(error?.message || error);
    return;
  }
  const json = JSON.stringify({ version: 1, steps: safeSteps }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `switchboard-workflow-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// Imported files are data, never commands. Apply strict bounds before writing
// to Chrome storage; replay still goes through Chrome's native site permission.
function parseWorkflowImport(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.steps) ||
      raw.steps.length < 1 || raw.steps.length > 50) throw new Error('Format workflow tidak valid (1–50 langkah).');
  return raw.steps.map((step, i) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('Langkah ' + (i + 1) + ' tidak valid.');
    if (step.action === 'navigate') {
      const url = new URL(String(step.url || ''));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error('URL langkah ' + (i + 1) + ' tidak aman untuk disimpan.');
      return { action: 'navigate', url: url.href };
    }
    if (step.action === 'click') {
      const selector = String(step.selector || '');
      if (!selector || selector.length > 500 || selector.startsWith('@') ||
          /password|passcode|credit|card|pay|order|checkout|purchase|buy|submit|delete|remove|transfer|withdraw|deposit|send|publish|subscribe|authori[sz]|grant|consent|approve|confirm|upload|download|log.?in|log.?out|token|secret/i.test(selector))
        throw new Error('Selector langkah ' + (i + 1) + ' tidak aman atau tidak stabil.');
      return { action: 'click', selector };
    }
    if (step.action === 'scroll') {
      const direction = String(step.direction || 'down');
      const amount = Number(step.amount || 600);
      const selector = String(step.selector || '');
      if (!['up', 'down', 'top', 'bottom'].includes(direction) ||
          !Number.isFinite(amount) || amount < 1 || amount > 3000 ||
          selector.length > 500 || selector.startsWith('@'))
        throw new Error('Scroll langkah ' + (i + 1) + ' tidak valid.');
      return { action: 'scroll', direction, amount, ...(selector ? { selector } : {}) };
    }
    // Typing, file downloads, credentials and arbitrary imported code are never replayed.
    throw new Error('Aksi langkah ' + (i + 1) + ' tidak didukung untuk impor.');
  });
}
$('import-workflow-btn').addEventListener('click', () => $('import-workflow-file').click());
$('import-workflow-file').addEventListener('change', async (event) => {
  const input = event.target;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    if (file.size > 64 * 1024) throw new Error('File melebihi 64 KB.');
    const steps = parseWorkflowImport(JSON.parse(await file.text()));
    recordedWorkflowSteps = steps;
    await chrome.storage.local.set({ workflowSteps: steps });
    renderWorkflowSteps();
    $('replay-progress-bar').textContent = steps.length + ' langkah berhasil diimpor. Tinjau sebelum replay.';
  } catch (error) {
    $('replay-progress-bar').textContent = 'Impor gagal: ' + String(error?.message || error);
  }
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
  const requested = normalizePermissionMode(e.target.value);
  e.target.value = requested;
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_SET_PERMISSION_MODE', mode: requested });
    if (!reply?.ok) throw new Error(reply?.error || 'The local Switchboard server did not accept the mode.');
    const mode = normalizePermissionMode(reply.mode);
    e.target.value = mode;
    await chrome.storage.local.set({ permissionMode: mode });
    updatePermissionModeDescription(mode);
    await refreshActiveTab();
  } catch (error) {
    $('bridge-diagnostics').textContent = String(error?.message || error);
    await refreshBridgeStatus();
  }
});

function normalizePermissionMode(value) {
  if (value === 'manual' || value === 'ask_every_time') return 'manual';
  if (value === 'auto' || value === 'auto_safe') return 'auto';
  if (value === 'skip') return 'skip';
  return 'auto';
}

/** Accept only the local console: plain HTTP on loopback (matches background.js). */
function normalizeWebOrigin(value) {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(value || '')) ? String(value) : '';
}

function updatePermissionModeDescription(mode) {
  const descriptions = {
    manual: 'Ask you to approve each browser action. Chrome still controls which sites the companion can access.',
    auto: 'Automatically screen page content and each action. Uncertain, sensitive, or protected actions may need your approval.',
    skip: 'Skip automatic checks. Explicit approval rules, prohibited-action blocks, and Chrome site permissions still apply.',
  };
  const description = $('permission-mode-description');
  if (description) description.textContent = descriptions[mode] || descriptions.auto;
}

function sitePattern(origin) {
  const url = new URL(origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin) throw new Error('Invalid site origin');
  return url.protocol + '//' + url.hostname + '/*';
}
// chrome.permissions.request MUST be invoked directly in a user gesture.
// The agent itself cannot grant site access.
function allowSiteFromClick(origin, button, feedback, once = false) {
  button.disabled = true;
  let permissionRequest;
  try {
    // This must be called synchronously in the button's user-gesture handler.
    permissionRequest = chrome.permissions.request({ origins: [sitePattern(origin)] });
  } catch (error) {
    permissionRequest = Promise.reject(error);
  }
  void Promise.resolve(permissionRequest).then(async (granted) => {
    if (!granted) {
      await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_SITE_APPROVAL_DENIED', origin });
      throw new Error('Chrome did not grant access to ' + origin);
    }
    const { pending } = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_PENDING_ACCESS' });
    if (pending?.origin === origin) {
      const result = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_SITE_APPROVAL_GRANTED', origin, once });
      if (!result?.ok) throw new Error(result?.error || 'Chrome site permission was not accepted');
    } else if (once) {
      await chrome.permissions.remove({ origins: [sitePattern(origin)] });
      throw new Error('The site request expired; its temporary Chrome permission was removed. Retry the browser action.');
    }
    await syncCurrentTabToBridge();
    await refreshActiveTab();
    await refreshPendingSite();
    feedback.textContent = once ? 'Allowed for this action. The Chrome permission will be removed afterward.' : 'Allowed by Chrome; the task is continuing.';
  }).catch(e => { feedback.textContent = 'Access error: ' + String(e.message || e); })
    .finally(() => { button.disabled = false; });
}
$('allow-current-origin-btn').addEventListener('click', () => {
  if (currentTab?.origin) allowSiteFromClick(currentTab.origin, $('allow-current-origin-btn'), $('site-request-feedback'));
});

$('revoke-current-origin-btn').addEventListener('click', async () => {
  if (!currentTab?.origin) return;
  await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_SITE_ACCESS_REVOKE', origin: currentTab.origin });
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
    const values = [time, entry.tool || '-', entry.selector || entry.url || entry.action || '-', entry.decision || '-', entry.status || '-'];
    values.forEach((value, i) => {
      const td = document.createElement('td');
      td.textContent = String(value);
      if (i === 4) td.style.color = entry.status === 'success' ? 'var(--success)' : 'var(--danger)';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  renderOverviewActivity(list);
}

$('refresh-audit-btn').addEventListener('click', refreshAuditLog);
$('clear-audit-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_CLEAR_AUDIT_LOG' });
  await refreshAuditLog();
});

// Agent action requests the *target* site, not necessarily the current tab.
let pendingOrigin = null;
async function refreshPendingSite() {
  try {
    const { pending } = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_PENDING_ACCESS' });
    pendingOrigin = pending?.origin || null;
    $('site-request').hidden = !pendingOrigin;
    if (pendingOrigin) $('site-request-desc').textContent =
      'Allow ' + pendingOrigin + ' for ' + (pending.tool || 'browser task') + '?';
  } catch (_) {}
}
$('site-request-allow').addEventListener('click', () => {
  if (pendingOrigin) allowSiteFromClick(pendingOrigin, $('site-request-allow'), $('site-request-feedback'));
});
$('site-request-once').addEventListener('click', () => {
  if (pendingOrigin) allowSiteFromClick(pendingOrigin, $('site-request-once'), $('site-request-feedback'), true);
});
$('site-request-deny').addEventListener('click', async () => {
  if (!pendingOrigin) return;
  await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_SITE_APPROVAL_DENIED', origin: pendingOrigin });
  $('site-request-feedback').textContent = 'Denied. The pending task was stopped.';
  await refreshPendingSite();
});
setInterval(() => void refreshPendingSite(), 1000);

// -----------------------------------------------------------------------------
// Connection, permission and recent activity overview
// -----------------------------------------------------------------------------
async function updateOverviewStatus() {
  const access = currentTab?.origin
    ? await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_SITE_ACCESS_STATUS', origin: currentTab.origin })
    : { granted: false };
  const isApproved = Boolean(access?.granted);
  const hasCapture = Boolean(currentTab?.url);
  $('overview-site-origin').textContent = currentTab?.origin || 'No site selected';
  $('overview-site-status').textContent = isApproved ? 'Approved' : 'Not approved';
  $('overview-site-status').className = 'status-pill ' + (isApproved ? 'is-live' : 'is-offline');
  $('overview-site-desc').textContent = isApproved
    ? 'Switchboard may work on this site within your permission settings.'
    : 'Allow this website once in Chrome so Switchboard can read and work on it.';
  $('overview-allow-btn').disabled = !hasCapture || isApproved;
  $('overview-revoke-btn').disabled = !hasCapture || !isApproved;
  $('site-permission-status').textContent = isApproved ? 'Approved' : 'Not approved';
  $('site-permission-status').style.color = isApproved ? 'var(--success)' : 'var(--warning)';
}

function renderOverviewActivity(entries) {
  const container = $('overview-activity');
  if (!container) return;
  container.replaceChildren();
  const recent = entries.slice(0, 5);
  if (!recent.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-activity';
    const icon = document.createElement('span');
    icon.className = 'empty-icon';
    icon.textContent = '↗';
    const body = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = 'No activity yet';
    const p = document.createElement('p');
    p.textContent = 'Actions from Switchboard sessions appear here.';
    body.append(label,p);
    empty.append(icon,body);
    container.appendChild(empty);
    return;
  }
  recent.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'activity-row';
    const symbol = document.createElement('span');
    symbol.className = 'activity-symbol';
    symbol.textContent = entry.status === 'success' ? '✓' : '!';
    const info = document.createElement('div');
    info.className = 'activity-main';
    const name = document.createElement('span');
    name.className = 'activity-name';
    name.textContent = String(entry.tool || 'Browser action');
    const detail = document.createElement('span');
    detail.className = 'activity-sub';
    detail.textContent = String(entry.selector || entry.url || entry.action || 'Browser tab');
    info.append(name,detail);
    const outcome = document.createElement('span');
    outcome.className = 'activity-outcome' + (entry.status === 'success' ? '' : ' failed');
    outcome.textContent = entry.status === 'success' ? 'Completed' : 'Failed';
    row.append(symbol,info,outcome);
    container.appendChild(row);
  });
}

function openPanelTab(tab) {
  document.querySelector('nav button[data-tab="' + tab + '"]')?.click();
}

$('copy-cli-btn').addEventListener('click', async () => {
  const value = $('cli-command').textContent;
  try {
    await navigator.clipboard.writeText(value);
    $('copy-cli-btn').textContent = 'Copied ✓';
    $('copy-cli-btn').setAttribute('aria-label','Command copied to clipboard');
  } catch (_) {
    $('copy-cli-btn').textContent = 'Select text';
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents($('cli-command'));
    selection.removeAllRanges();
    selection.addRange(range);
  }
});
$('overview-settings-btn').addEventListener('click', () => openPanelTab('tab-settings'));
$('overview-activity-btn').addEventListener('click', () => {
  openPanelTab('tab-security');
  void refreshAuditLog();
});
$('overview-allow-btn').addEventListener('click', () => $('allow-current-origin-btn').click());
$('overview-revoke-btn').addEventListener('click', () => $('revoke-current-origin-btn').click());

// Ask Switchboard directly from the extension, using the already authenticated
// local Web API. This is the same agent runtime as the full chat page.
let activeTask = null;
let activeTaskSession = null;
function taskStatus(text) { $('task-status').textContent = text; }
$('task-open-web').addEventListener('click', () => {
  void chrome.tabs.create({ url: webOrigin + '/' });
});
// Configure provider API keys in the existing authenticated loopback console.
// Never accept, persist or transmit API keys through the browser extension.
async function openModelKeySettings() {
  // Use the authenticated, paired server's advertised origin, never an
  // unpaired fallback port or a webpage-supplied destination.
  const status = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_BRIDGE_STATUS' }).catch(() => null);
  const origin = normalizeWebOrigin(status?.webOrigin);
  if (!status?.connected || !origin) {
    const message = 'Hubungkan Browser Companion ke sbx web untuk mengatur model & API key.';
    taskStatus(message);
    $('bridge-diagnostics').textContent = message;
    return;
  }
  try {
    await chrome.tabs.create({ url: origin + '/?settings=models' });
  } catch (error) {
    const message = 'Gagal membuka pengaturan model: ' + String(error?.message || error);
    taskStatus(message);
    $('bridge-diagnostics').textContent = message;
  }
}
// Side-panel BYOK: the API key exists only in this password input and the
// single authorized request body. It is not logged or written to Chrome storage.
let byokPending = null;
$('task-configure-key').addEventListener('click', () => {
  $('byok-panel').open = true;
  $('byok-provider').focus();
});
$('byok-advanced').addEventListener('click', openModelKeySettings);
$('configure-model-key-settings').addEventListener('click', openModelKeySettings);
$('byok-provider').addEventListener('change', () => {
  $('byok-model').value = $('byok-provider').value === 'groq'
    ? 'openai/gpt-oss-20b' : 'qwen/qwen3.8-flash';
});
$('byok-cancel').addEventListener('click', () => {
  if (byokPending) byokPending.cancelled = true;
  $('byok-key').value = '';
  $('byok-status').textContent = 'Permintaan dibatalkan. Key tidak disimpan.';
});
async function byokApi(origin, token, path, method = 'GET', payload) {
  const response = await fetch(origin + '/api/companion-byok/' + path, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      ...(payload ? { 'content-type': 'application/json' } : {})
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(String(data.error || 'Pengaturan API key gagal (HTTP ' + response.status + ')').slice(0, 180));
  return data;
}
$('byok-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (byokPending) return;
  const token = companionToken;
  const bridge = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_BRIDGE_STATUS' }).catch(() => null);
  const origin = normalizeWebOrigin(bridge?.webOrigin);
  const keyField = $('byok-key');
  if (!bridge?.connected || !origin || !token) {
    keyField.value = '';
    $('byok-status').textContent = 'Hubungkan Browser Companion dan sbx web sebelum menyimpan API key.';
    return;
  }
  if (!keyField.value || keyField.value.length > 4096) return;
  const request = { cancelled: false };
  byokPending = request;
  $('byok-save').disabled = true;
  $('byok-cancel').hidden = false;
  const say = (message) => { $('byok-status').textContent = message; };
  try {
    const grant = await byokApi(origin, token, 'request', 'POST', {
      provider: $('byok-provider').value,
      model: $('byok-model').value.trim(),
      setDefault: $('byok-default').checked,
    });
    if (request.cancelled) return;
    say('Setujui penyimpanan API key melalui tab Web Console yang baru dibuka (maksimal 2 menit).');
    await chrome.tabs.create({ url: origin + '/?byok=' + encodeURIComponent(grant.id) });
    let approved = false;
    for (let i = 0; i < 110 && !request.cancelled; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (request.cancelled) break;
      const status = await byokApi(origin, token, 'status', 'POST', { id: grant.id });
      if (status.approved) { approved = true; break; }
    }
    if (request.cancelled) { say('Dibatalkan. Tidak ada API key disimpan.'); return; }
    if (!approved) throw Error('Persetujuan kedaluwarsa. Coba kembali.');
    // Clear the DOM input before the credential request finishes. The secret
    // survives only in one ephemeral request payload, not logs or storage.
    const apiKey = keyField.value;
    keyField.value = '';
    if (!apiKey) throw Error('API key sudah dikosongkan; ulangi.');
    const result = await byokApi(origin, token, 'commit', 'POST', { id: grant.id, apiKey });
    // A previous conversation may be pinned to its earlier provider/model.
    // Do not silently continue an old session after a BYOK default switch.
    if (result.selected) conversationId = null;
    say('API key ' + result.provider + ' tersimpan di backend. Model: ' + result.model +
      (result.selected ? ' (aktif untuk obrolan berikutnya).' : '.') +
      ' Koneksi model belum diuji.');
  } catch (error) {
    say('Gagal: ' + String(error?.message || 'Permintaan gagal').slice(0, 180));
  } finally {
    keyField.value = '';
    byokPending = null;
    $('byok-save').disabled = false;
    $('byok-cancel').hidden = true;
  }
});
$('task-stop').addEventListener('click', async () => {
  const sessionToCancel = activeTaskSession;
  activeTask?.abort();
  taskStatus('Stopped.');
  note('Dihentikan.');
  if (sessionToCancel && companionToken) {
    await fetch(webOrigin + '/api/runs/' + encodeURIComponent(sessionToCancel) + '/cancel', {
      method: 'POST', headers: { authorization: 'Bearer ' + companionToken }
    }).catch(() => {});
  }
});
// Enter sends; Shift+Enter adds a line.
$('task-prompt').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (!activeTask) $('task-form').requestSubmit();
});

// ---- Chat rendering ----------------------------------------------------------
// One conversation per panel: later messages reuse the session so the agent keeps context.
let conversationId = null;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Input is escaped first; only these patterns add markup: `code`, **bold**, *italic*, [text](http(s) url).
function inlineMarkup(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
function formatReply(text) {
  return String(text).split(/```/).map((part, index) => {
    if (index % 2 === 1) {
      const code = part.replace(/^[a-zA-Z0-9_+-]*\n/, '').replace(/\n$/, '');
      return '<pre><code>' + escapeHtml(code) + '</code></pre>';
    }
    const out = [];
    let list = '';
    let para = [];
    const endPara = () => { if (para.length) { out.push('<p>' + para.join('<br>') + '</p>'); para = []; } };
    const endList = () => { if (list) { out.push('</' + list + '>'); list = ''; } };
    for (const raw of part.split('\n')) {
      const line = raw.trimEnd();
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const number = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || number) {
        endPara();
        const tag = bullet ? 'ul' : 'ol';
        if (list !== tag) { endList(); out.push('<' + tag + '>'); list = tag; }
        out.push('<li>' + inlineMarkup(escapeHtml((bullet || number)[1])) + '</li>');
      } else if (!line.trim()) {
        endPara(); endList();
      } else {
        endList();
        para.push(inlineMarkup(escapeHtml(line)));
      }
    }
    endPara(); endList();
    return out.join('');
  }).join('');
}

function hostOf(url) { try { return new URL(String(url)).host; } catch (_) { return 'halaman'; } }
function shortSelector(selector) {
  const text = String(selector || '').trim();
  return text.length > 28 ? text.slice(0, 27) + '…' : text;
}
const STEP_LABELS = {
  browser_navigate: a => 'Membuka ' + hostOf(a.url),
  browser_tab_create: a => 'Membuka tab ' + hostOf(a.url),
  browser_tab_close: () => 'Menutup tab',
  browser_key: () => 'Menekan tombol',
  browser_dom_snapshot: () => 'Membaca halaman',
  browser_extract: () => 'Mengambil teks halaman',
  browser_click: a => 'Mengklik ' + shortSelector(a.selector),
  browser_type: a => 'Mengisi ' + shortSelector(a.selector),
  browser_select: a => 'Memilih opsi ' + shortSelector(a.selector),
  browser_scroll: () => 'Menggulir halaman',
  browser_screenshot: () => 'Mengambil tangkapan layar',
  browser_download: () => 'Mengunduh berkas',
  browser_wait: () => 'Menunggu',
  browser_tabs_list: () => 'Melihat daftar tab',
  browser_tab_select: () => 'Berpindah tab',
  browser_console_logs: () => 'Memeriksa console',
  browser_network_errors: () => 'Memeriksa jaringan',
};
function stepLabel(name, args) {
  const label = STEP_LABELS[name];
  return label ? label(args || {}).trim() : String(name || 'Menjalankan alat').replace(/^browser_/, '').replace(/_/g, ' ');
}

// These are tool-reported statuses, not independent validation of AI claims.
// Some bridge tools return JSON failure objects rather than "Error:" strings.
function toolResultFailed(result) {
  const value = String(result ?? '').trim();
  if (/^(Error:|Failed:)/i.test(value)) return true;
  if (value.startsWith('{') && value.length <= 4096) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' &&
        (parsed.ok === false || parsed.success === false || (Boolean(parsed.error) && parsed.ok !== true));
    } catch (_) { /* Plaintext tool output is not an error by itself. */ }
  }
  return false;
}

function taskReceiptText(state, statuses) {
  const complete = statuses.filter(status => status === 'done').length;
  const failed = statuses.filter(status => status === 'failed').length;
  const pending = statuses.length - complete - failed;
  if (state === 'cancelled') return 'Dihentikan. Aksi yang sudah berjalan tidak dapat dibatalkan; periksa rincian langkah.';
  if (state === 'failed') return 'Tugas gagal. ' + complete + ' langkah dilaporkan berhasil, ' + failed + ' gagal.';
  if (state === 'step_limit') return 'Batas langkah tercapai. ' + complete + ' langkah dilaporkan berhasil; hasil belum lengkap.';
  if (state !== 'completed') return 'Belum ada hasil akhir yang dapat dipastikan.';
  if (!statuses.length) return 'Jawaban AI diterima tanpa aksi browser yang tercatat; periksa sumber secara mandiri.';
  if (failed || pending) return 'Jawaban AI diterima, tetapi ' + failed + ' langkah gagal dan ' + pending + ' belum selesai.';
  return complete + ' langkah tool dilaporkan berhasil. Ini bukan verifikasi independen atas isi jawaban.';
}

function note(text, kind) {
  $('chat-empty').hidden = true;
  const log = $('chat-log');
  const el = document.createElement('div');
  el.className = 'msg msg-note' + (kind === 'error' ? ' error' : '');
  el.textContent = text;
  log.append(el);
  log.scrollTop = log.scrollHeight;
}

function createAgentMessage() {
  const root = document.createElement('div');
  root.className = 'msg msg-agent';
  const steps = document.createElement('details');
  steps.className = 'steps';
  steps.open = true;
  steps.hidden = true;
  const summary = document.createElement('summary');
  steps.append(summary);
  const answer = document.createElement('div');
  answer.className = 'answer';
  const thinking = document.createElement('div');
  thinking.className = 'thinking';
  thinking.setAttribute('role', 'status');
  thinking.setAttribute('aria-label', 'Sedang bekerja');
  thinking.innerHTML = '<i></i><i></i><i></i>';
  const receipt = document.createElement('div');
  receipt.className = 'task-receipt';
  receipt.hidden = true;
  receipt.setAttribute('aria-label', 'Status hasil tugas');
  root.append(steps, answer, receipt, thinking);
  return { root, steps, summary, answer, receipt, thinking, items: new Map(), text: '' };
}
function refreshStepSummary(msg, finished) {
  const total = msg.items.size;
  const failed = [...msg.items.values()].filter(el => el.classList.contains('failed')).length;
  msg.summary.textContent = finished
    ? total + ' langkah' + (failed ? ', ' + failed + ' gagal' : '')
    : 'Bekerja… ' + total + ' langkah';
}

function autosizePrompt() {
  const prompt = $('task-prompt');
  prompt.style.height = 'auto';
  prompt.style.height = Math.min(prompt.scrollHeight, 160) + 'px';
}
$('task-prompt').addEventListener('input', autosizePrompt);

function syncComposerMode() {
  const select = $('composer-mode');
  if (select) select.value = $('permission-mode-select').value;
}
$('composer-mode')?.addEventListener('change', event => {
  const target = $('permission-mode-select');
  target.value = event.target.value;
  target.dispatchEvent(new Event('change'));
});
$('permission-mode-select').addEventListener('change', syncComposerMode);

document.querySelectorAll('#chat-chips .chip').forEach(button => {
  button.addEventListener('click', () => {
    const prompt = $('task-prompt');
    prompt.value = button.dataset.prompt || '';
    autosizePrompt();
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
  });
});
$('chat-new')?.addEventListener('click', () => {
  if (activeTask) return;
  conversationId = null;
  $('chat-log').replaceChildren();
  $('chat-empty').hidden = false;
  $('task-prompt').value = '';
  autosizePrompt();
  $('task-prompt').focus();
});

$('task-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (activeTask) return;
  const question = $('task-prompt').value.trim();
  if (!question) return;
  if (!companionToken) { note('Switchboard belum terhubung. Buka Pengaturan untuk menghubungkannya.', 'error'); return; }
  activeTask = new AbortController();
  activeTaskSession = null;
  const approvalPoll = setInterval(() => void refreshActionApproval(), 500);
  $('task-send').disabled = true;
  $('task-stop').disabled = false;
  const log = $('chat-log');
  $('chat-empty').hidden = true;
  const userMsg = document.createElement('div');
  userMsg.className = 'msg msg-user';
  userMsg.textContent = question;
  log.append(userMsg);
  const msg = createAgentMessage();
  let taskOutcome = 'failed';
  log.append(msg.root);
  $('task-prompt').value = '';
  autosizePrompt();
  log.scrollTop = log.scrollHeight;
  taskStatus('Running with your configured AI model...');
  try {
    // The model must select the correct tab explicitly. Never silently grant
    // site access or pass webpage text as higher-trust instructions.
    const context = currentTab?.origin
      ? 'The current website origin is ' + currentTab.origin +
        '. Use browser_tabs_list and browser_tab_select to target the right tab if needed. '
      : '';
    const response = await fetch(webOrigin + '/api/chat', {
      method: 'POST',
      signal: activeTask.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + companionToken },
      body: JSON.stringify({ preset: 'browser', prompt: context + question, ...(conversationId ? { sessionId: conversationId } : {}) })
    });
    if (response.status === 404 && conversationId) conversationId = null;
    if (!response.ok || !response.body) throw Error('Local Switchboard HTTP ' + response.status);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let reachedTerminalEvent = false;
    let sawFatalEvent = false;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let item;
        try { item = JSON.parse(line.slice(6)); } catch (_) { continue; }
        if (item.type === 'session') {
          activeTaskSession = item.sessionId;
          conversationId = item.sessionId;
          void refreshActionApproval();
        }
        if (item.type === 'tool_call') {
          taskStatus('Using ' + String(item.name || 'browser tool'));
          const step = document.createElement('div');
          step.className = 'step running';
          step.innerHTML = '<span class="step-dot"></span><span class="step-label"></span>';
          step.querySelector('.step-label').textContent = stepLabel(item.name, item.args);
          msg.steps.append(step);
          msg.steps.hidden = false;
          msg.thinking.hidden = true;
          msg.items.set(String(item.id), step);
          refreshStepSummary(msg, false);
        }
        if (item.type === 'tool_result') {
          const step = msg.items.get(String(item.id));
          if (step) {
            step.classList.remove('running');
            step.classList.add(toolResultFailed(item.result) ? 'failed' : 'done');
            refreshStepSummary(msg, false);
          }
        }
        if (item.type === 'delta' && item.text) {
          msg.text += item.text;
          msg.thinking.hidden = true;
          msg.answer.innerHTML = formatReply(msg.text);
        }
        if (item.type === 'final' && !sawFatalEvent) {
          reachedTerminalEvent = true;
          taskOutcome = item.stopReason === 'step_limit' ? 'step_limit'
            : item.stopReason === 'error' ? 'failed' : 'completed';
          msg.text = item.content || msg.text || 'Selesai tanpa jawaban tertulis.';
          msg.answer.innerHTML = formatReply(msg.text);
          taskStatus(item.stopReason === 'step_limit' ? 'Stopped at step limit.' : item.stopReason === 'error' ? 'Failed.' : 'Completed.');
        }
        if (item.type === 'error') {
          taskOutcome = 'failed';
          reachedTerminalEvent = true;
          sawFatalEvent = true;
          taskStatus('Failed.');
          note('Terjadi galat: ' + String(item.message || item.error || 'tidak diketahui'), 'error');
        }
        if (item.type === 'cancelled') {
          taskOutcome = 'cancelled';
          reachedTerminalEvent = true;
          sawFatalEvent = true;
          taskStatus('Stopped.');
        }
        log.scrollTop = log.scrollHeight;
      }
    }
    if (!reachedTerminalEvent && !activeTask.signal.aborted) {
      taskStatus('Failed.');
      note('Koneksi tugas berakhir sebelum hasil akhir diterima.', 'error');
    }
  } catch (error) {
    if (error?.name === 'AbortError') taskOutcome = 'cancelled';
    if (error?.name !== 'AbortError') {
      taskOutcome = 'failed';
      taskStatus('Failed.');
      note('Gagal: ' + String(error?.message || error), 'error');
    }
  } finally {
    clearInterval(approvalPoll);
    msg.thinking.remove();
    if (msg.items.size) { msg.steps.open = false; refreshStepSummary(msg, true); }
    if (msg.text || msg.items.size) {
      msg.receipt.textContent = taskReceiptText(taskOutcome, [...msg.items.values()].map(step =>
        step.classList.contains('done') ? 'done' : step.classList.contains('failed') ? 'failed' : 'running'));
      msg.receipt.hidden = false;
    } else msg.root.remove();
    activeTask = null;
    activeTaskSession = null;
    pendingApprovalId = null;
    $('approval-banner').classList.remove('visible');
    $('task-send').disabled = false;
    $('task-stop').disabled = true;
    await refreshPendingSite();
    await refreshAuditLog();
  }
});

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------
(async function init() {
  // This companion intentionally uses one neutral light theme.
  document.documentElement.removeAttribute('data-theme');
  localStorage.removeItem('sb_theme');
  await loadStoredConfig();
  syncComposerMode();
  await refreshActiveTab();
  await refreshPendingSite();
  await refreshAuditLog();
  await updateOverviewStatus();
  // The background worker automatically resumes an existing pairing.
  await refreshBridgeStatus();
})();

// Simpler layout (Claude in Chrome): Chat, Izin, Pengaturan. Inspector and Workflows stay available under Pengaturan > Lanjutan.
(() => {
  const settings = document.getElementById('tab-settings');
  if (!settings) return;
  const advanced = document.createElement('details');
  advanced.className = 'advanced';
  advanced.innerHTML = '<summary>Lanjutan: inspeksi halaman dan workflow</summary>';
  for (const id of ['tab-tools', 'tab-workflows']) {
    const pane = document.getElementById(id);
    if (!pane) continue;
    pane.classList.remove('tab-pane', 'active');
    pane.style.display = 'block';
    advanced.append(pane);
  }
  settings.append(advanced);
})();

// Side panel = chat only. Settings open in a full tab (?view=settings).
(() => {
  if (new URLSearchParams(location.search).get('view') === 'settings') { const chatTab = document.querySelector('nav button[data-tab="tab-overview"]'); if (chatTab) chatTab.style.display = 'none'; document.querySelector('nav button[data-tab="tab-security"]')?.click(); return; }
  document.body.classList.add('chat-only');
  // Icon-only actions in the composer.
  const send = document.getElementById('task-send');
  const stop = document.getElementById('task-stop');
  const settings = document.getElementById('task-settings');
  if (send) { send.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>'; send.setAttribute('aria-label', 'Kirim instruksi'); send.title = 'Kirim'; }
  if (stop) { stop.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>'; stop.setAttribute('aria-label', 'Hentikan'); stop.title = 'Hentikan'; }
  if (settings) { settings.setAttribute('aria-label', 'Pengaturan'); settings.title = 'Pengaturan'; settings.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'; }
  const form = document.getElementById('task-form');
  for (const id of ['site-request', 'approval-banner']) {
    const el = document.getElementById(id);
    if (el && form) form.before(el);
  }
  const prompt = document.getElementById('task-prompt');
  if (prompt) prompt.placeholder = 'Tulis instruksi untuk browser…';
  const tabTitle = document.getElementById('active-tab-title');
  if (tabTitle) tabTitle.closest('section').hidden = true;
  document.getElementById('task-settings')?.addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('panel.html?view=settings') });
  });
})();
