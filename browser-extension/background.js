// Switchboard Browser Companion — Service Worker (Chrome & Edge Manifest V3)
// Handles: independent message dispatch, 13 browser tools, permission modes,
// sensitive field protection, compact DOM snapshots, workflow recording & replay,
// audit logging, and authenticated loopback bridge communication.

const MAX_TEXT = 24000;
const SAFE_URL = /^https?:\/\//i;
const MUTATING_ACTIONS = new Set(['click', 'type', 'scroll', 'navigate', 'select']);

function errorMessage(error) {
  return String(error?.message || error);
}

// The Browser Companion socket lives in the MV3 service worker, not the panel.
// Chrome 116+ keeps a WebSocket-backed worker alive when frames are exchanged.
// An alarm re-establishes it after browser/worker restarts or an outage.
const BRIDGE_ALARM = 'switchboard-bridge-reconnect';
const BRIDGE_PROTOCOL = 'switchboard-bridge-v1';
let bridgeSocket = null;
let bridgeSocketGeneration = 0;
let bridgeSocketTimer = null;
let bridgeConnectPromise = null;
let bridgeLastError = '';
let statusSyncTimer = null;

function validBridgeUrl(input) {
  const url = new URL(String(input || 'http://127.0.0.1:7778'));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Browser Companion only connects to an HTTP loopback address.');
  }
  return url.origin;
}

async function bridgeConfig() {
  const data = await chrome.storage.local.get(['bridgeUrl', 'companionToken', 'bridgeConnected']);
  return { url: validBridgeUrl(data.bridgeUrl || 'http://127.0.0.1:7778'),
    token: data.companionToken || '', desired: Boolean(data.bridgeConnected) };
}

function socketIsOpen() {
  return bridgeSocket?.readyState === WebSocket.OPEN;
}

function stopSocket() {
  bridgeSocketGeneration++;
  if (bridgeSocketTimer) clearInterval(bridgeSocketTimer);
  bridgeSocketTimer = null;
  if (bridgeSocket) {
    bridgeSocket.close();
    bridgeSocket = null;
  }
}

async function syncBrowserState() {
  const config = await bridgeConfig();
  if (!config.desired || !config.token || !socketIsOpen()) return;
  let activeTab = null;
  try {
    const tab = await getActiveTab();
    activeTab = { id: tab.id, title: tab.title || '', url: tab.url, auditedOrigin: new URL(tab.url).origin };
  } catch (_) {
    // Restricted/non-HTTP pages never receive browser actions.
  }
  const { approvedOrigins = [], permissionMode = 'ask_every_time' } =
    await chrome.storage.local.get(['approvedOrigins', 'permissionMode']);
  const response = await fetch(config.url + '/api/browser-companion/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.token },
    body: JSON.stringify({ activeTab, approvedOrigins, mode: permissionMode }),
  });
  if (!response.ok) throw new Error('Bridge status synchronization HTTP ' + response.status);
}

function scheduleStatusSync() {
  if (statusSyncTimer) clearTimeout(statusSyncTimer);
  statusSyncTimer = setTimeout(() => {
    statusSyncTimer = null;
    void syncBrowserState().catch(error => { bridgeLastError = errorMessage(error); });
  }, 250);
}

async function sendBridgeResult(command, endpoint, token) {
  let ok = true;
  let result;
  let error;
  try {
    if (!command || typeof command.id !== 'string' || typeof command.tool !== 'string') {
      throw new Error('Invalid browser command');
    }
    result = await handleToolExecution(command.tool, command.args || {});
    if (!result?.ok) throw new Error(result?.error || 'Browser tool rejected');
  } catch (failure) {
    ok = false;
    error = errorMessage(failure);
  }
  const response = await fetch(endpoint + '/api/browser-companion/response', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ id: command?.id, ok, ...(ok ? { result } : { error }) }),
  });
  if (!response.ok) throw new Error('Failed to acknowledge browser command (HTTP ' + response.status + ')');
}

async function ensureBridgeSocket() {
  if (socketIsOpen()) return true;
  if (bridgeConnectPromise) return bridgeConnectPromise;
  bridgeConnectPromise = (async () => {
    const { url, token, desired } = await bridgeConfig();
    if (!desired || !token) return false;
    stopSocket();
    const generation = bridgeSocketGeneration;
    const ws = new WebSocket(url.replace(/^http:/, 'ws:') + '/api/browser-companion/socket',
      [BRIDGE_PROTOCOL, 'sb-auth-' + token]);
    bridgeSocket = ws;
    const opened = await new Promise(resolve => {
      ws.addEventListener('open', () => resolve(true), { once: true });
      ws.addEventListener('error', () => resolve(false), { once: true });
      ws.addEventListener('close', () => resolve(false), { once: true });
    });
    if (generation !== bridgeSocketGeneration || !opened) {
      if (!opened) bridgeLastError = 'Local Switchboard browser socket unavailable';
      if (ws === bridgeSocket) bridgeSocket = null;
      try { ws.close(); } catch (_) {}
      return false;
    }
    bridgeLastError = '';
    bridgeSocketTimer = setInterval(() => {
      if (socketIsOpen()) ws.send(JSON.stringify({ type: 'heartbeat' }));
    }, 20_000);
    ws.addEventListener('message', event => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'command' && msg.data && generation === bridgeSocketGeneration) {
          void sendBridgeResult(msg.data, url, token).catch(err => {
            bridgeLastError = errorMessage(err);
          });
        }
      } catch (error) {
        bridgeLastError = errorMessage(error);
      }
    });
    ws.addEventListener('close', event => {
      if (generation !== bridgeSocketGeneration || ws !== bridgeSocket) return;
      bridgeSocket = null;
      if (bridgeSocketTimer) clearInterval(bridgeSocketTimer);
      bridgeSocketTimer = null;
      if (event.code === 4001) {
        bridgeLastError = 'Another Browser Companion took over this session. Click Connect browser to switch back.';
        void chrome.storage.local.set({ bridgeConnected: false });
        return;
      }
      bridgeLastError = 'Connection interrupted; reconnecting automatically';
      // Alarm is the durable fallback if the worker is suspended.
      setTimeout(() => void ensureBridgeSocket().catch(() => {}), 1800);
    });
    scheduleStatusSync();
    return true;
  })();
  try { return await bridgeConnectPromise; }
  finally { bridgeConnectPromise = null; }
}

async function pairBridge(message) {
  const url = validBridgeUrl(message.url);
  const raw = String(message.code || '').trim();
  const previous = await chrome.storage.local.get('companionToken');
  const code = raw && !/^[a-f0-9]{48}$/i.test(raw) ? raw.toUpperCase().replace(/[\s-]/g, '') : '';
  const token = !code ? (raw || previous.companionToken || '') : '';
  if (!code && !token) throw new Error('Enter the pairing code shown in Switchboard CLI.');
  const response = await fetch(url + '/api/browser-companion/pair', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(code ? { code } : { token }),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 429) {
      throw new Error('Pairing code was rejected or expired. Restart Switchboard CLI to receive a new code.');
    }
    throw new Error('Pairing request failed (HTTP ' + response.status + ').');
  }
  const data = await response.json();
  if (!data.ok || !data.token) throw new Error('Invalid pairing response.');
  await chrome.storage.local.set({ bridgeUrl: url, companionToken: data.token, bridgeConnected: true });
  stopSocket();
  const connected = await ensureBridgeSocket();
  return { ok: connected, paired: true, connected, mode: data.mode,
    error: connected ? undefined : (bridgeLastError || 'Waiting to reconnect') };
}

async function disconnectBridge() {
  await chrome.storage.local.set({ bridgeConnected: false });
  stopSocket();
  bridgeLastError = '';
  return { ok: true, connected: false };
}

function bridgeStatus() {
  return {
    ok: true,
    connected: socketIsOpen(),
    status: socketIsOpen() ? 'connected' : 'disconnected',
    error: bridgeLastError,
  };
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === BRIDGE_ALARM) void ensureBridgeSocket().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  void ensureBridgeSocket().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  void ensureBridgeSocket().catch(() => {});
});
chrome.tabs.onActivated.addListener(() => scheduleStatusSync());
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.url || change.status === 'complete') scheduleStatusSync();
});
chrome.windows.onFocusChanged.addListener(() => scheduleStatusSync());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.approvedOrigins || changes.permissionMode) scheduleStatusSync();
});

void chrome.alarms.create(BRIDGE_ALARM, { periodInMinutes: 0.5 });
void ensureBridgeSocket().catch(() => {});

// Bounded Audit Log storage (latest 300 entries in storage.local)
async function recordAudit(entry) {
  try {
    const { auditLog = [] } = await chrome.storage.local.get('auditLog');
    const item = {
      id: 'ext-audit-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      timestamp: Date.now(),
      ...entry
    };
    const updated = [item, ...auditLog.slice(0, 299)];
    await chrome.storage.local.set({ auditLog: updated });
  } catch (_) {}
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !SAFE_URL.test(tab.url || '')) {
    throw new Error('Open a regular HTTP(S) page first.');
  }
  return tab;
}

// Compact, Token-Optimized DOM Snapshot Generator
async function capturePage(tab, options = {}) {
  const maxChars = Number(options.maxChars) || MAX_TEXT;
  const compact = options.compact !== false;

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (max, isCompact) => {
      const title = document.title;
      const url = location.href;
      const origin = location.origin;

      // Extract visible text, filtering scripts and styles
      const bodyClone = document.body ? document.body.cloneNode(true) : null;
      if (bodyClone) {
        const removeTags = bodyClone.querySelectorAll('script, style, noscript, svg, iframe');
        removeTags.forEach(el => el.remove());
      }
      const rawText = (bodyClone?.innerText || document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      const text = rawText.slice(0, max);
      const selection = String(window.getSelection() || '').slice(0, 4000);

      // Interactive element catalog with stable reference tags (@e1, @e2, ...)
      const candidateElements = Array.from(
        document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [onclick]')
      );

      let refIndex = 1;
      const elements = [];

      for (const el of candidateElements) {
        if (elements.length >= 80) break;
        const rect = el.getBoundingClientRect();
        // Filter non-visible elements
        if (rect.width <= 0 || rect.height <= 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type') || '';
        const isPassword = type === 'password';
        const isSensitive = isPassword || el.matches('[autocomplete*="password"], [autocomplete*="cc-"], [autocomplete*="cvv"], input[type="file"]');

        // Build stable unique CSS selector
        let selector = '';
        if (el.id) {
          selector = '#' + CSS.escape(el.id);
        } else if (el.name) {
          selector = `${tag}[name="${CSS.escape(el.name)}"]`;
        } else if (el.className && typeof el.className === 'string') {
          const firstClass = el.className.trim().split(/\s+/)[0];
          if (firstClass && !firstClass.includes(':')) {
            selector = `${tag}.${CSS.escape(firstClass)}`;
          }
        }
        if (!selector) {
          selector = tag;
        }

        const labelText = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').slice(0, 80).trim();

        // Tag element in DOM for fast reference lookup
        const refTag = `@e${refIndex++}`;
        el.setAttribute('data-sb-ref', refTag);

        elements.push({
          ref: refTag,
          tag,
          selector,
          text: labelText,
          type: type || undefined,
          name: el.getAttribute('name') || undefined,
          placeholder: el.getAttribute('placeholder') || undefined,
          disabled: el.hasAttribute('disabled') || undefined,
          isSensitive: isSensitive || undefined,
          value: isSensitive ? '[PROTECTED_FIELD]' : (el.value ? String(el.value).slice(0, 50) : undefined)
        });
      }

      // Simple hash for change detection & observation caching
      let hash = 0;
      const hashStr = title + url + text.slice(0, 500) + elements.length;
      for (let i = 0; i < hashStr.length; i++) {
        hash = ((hash << 5) - hash) + hashStr.charCodeAt(i);
        hash |= 0;
      }

      return {
        title,
        url,
        origin,
        text,
        selection,
        elements,
        hash: 'dom-' + Math.abs(hash).toString(16),
        elementCount: elements.length
      };
    },
    args: [maxChars, compact]
  });

  return injection.result;
}

// In-memory Console and Network Error Trackers
const consoleLogsMap = new Map();
const networkErrorsMap = new Map();

// Helper to inject log listeners into tab
async function ensureTabMonitoring(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (window.__sb_monitored) return;
        window.__sb_monitored = true;
        window.__sb_console_logs = [];
        window.__sb_network_errors = [];

        const origError = console.error;
        console.error = (...args) => {
          try {
            window.__sb_console_logs.push({ level: 'error', message: args.map(String).join(' '), at: Date.now() });
            if (window.__sb_console_logs.length > 50) window.__sb_console_logs.shift();
          } catch (_) {}
          origError.apply(console, args);
        };

        const origWarn = console.warn;
        console.warn = (...args) => {
          try {
            window.__sb_console_logs.push({ level: 'warn', message: args.map(String).join(' '), at: Date.now() });
            if (window.__sb_console_logs.length > 50) window.__sb_console_logs.shift();
          } catch (_) {}
          origWarn.apply(console, args);
        };

        window.addEventListener('error', (evt) => {
          window.__sb_console_logs.push({ level: 'error', message: String(evt.message || evt.error), at: Date.now() });
        });

        window.addEventListener('unhandledrejection', (evt) => {
          window.__sb_console_logs.push({ level: 'error', message: 'Unhandled Promise: ' + String(evt.reason), at: Date.now() });
        });
      }
    });
  } catch (_) {}
}

// -----------------------------------------------------------------------------
// Toolbar action handler: open side panel synchronously during user gesture
// -----------------------------------------------------------------------------
chrome.action.onClicked.addListener(async (tab) => {
  // Side panel opened synchronously in user gesture context (BUG FIX #2)
  const opening = tab.windowId !== undefined
    ? chrome.sidePanel.open({ windowId: tab.windowId })
    : Promise.resolve();

  try {
    if (!tab?.id || !SAFE_URL.test(tab.url || '')) {
      throw new Error('Open a regular HTTP(S) page.');
    }
    await ensureTabMonitoring(tab.id);
    const data = await capturePage(tab);
    await chrome.storage.session.set({
      captured: { tabId: tab.id, data, at: Date.now() }
    });
  } catch (error) {
    await chrome.storage.session.set({
      captured: { error: errorMessage(error), at: Date.now() }
    });
  }
  await opening.catch(() => {});
});

// -----------------------------------------------------------------------------
// Core Browser Action Executor
// -----------------------------------------------------------------------------
async function executeBrowserAction(action, params = {}, options = {}) {
  const tab = options.tabId ? await chrome.tabs.get(options.tabId) : await getActiveTab();
  if (!tab?.id || !SAFE_URL.test(tab.url || '')) throw new Error('Valid active HTTP(S) tab required');

  const tabOrigin = new URL(tab.url).origin;
  const { approvedOrigins = [], permissionMode = 'ask_every_time' } = await chrome.storage.local.get(['approvedOrigins', 'permissionMode']);

  // Mode check
  if (permissionMode === 'restricted' && MUTATING_ACTIONS.has(action)) {
    throw new Error('Permission mode is Restricted (read-only): actions that modify the page are blocked.');
  }

  // Origin check for mutations
  const isApprovedOrigin = approvedOrigins.includes(tabOrigin);
  if (MUTATING_ACTIONS.has(action) && !isApprovedOrigin && !options.skipOriginCheck) {
    throw new Error(`Site origin "${tabOrigin}" is not approved. Allow this site in the side panel first.`);
  }

  // Handle navigate
  if (action === 'navigate') {
    const targetUrl = new URL(String(params.url || params.value || ''), tab.url);
    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      throw new Error('Navigation restricted to HTTP/HTTPS URLs.');
    }
    // Cross-origin navigation check (BUG FIX #5)
    if (targetUrl.origin !== tabOrigin && !approvedOrigins.includes(targetUrl.origin) && !options.skipOriginCheck) {
      throw new Error(`Cross-origin navigation to "${targetUrl.origin}" rejected. Approve target origin first.`);
    }
    await chrome.tabs.update(tab.id, { url: targetUrl.href });
    await recordAudit({
      tool: 'browser_navigate',
      action: 'navigate',
      url: targetUrl.href,
      origin: targetUrl.origin,
      decision: isApprovedOrigin ? 'auto_safe' : 'approved',
      status: 'success'
    });
    return { ok: true, result: 'Navigated to ' + targetUrl.href, url: targetUrl.href };
  }

  // Handle scroll
  if (action === 'scroll') {
    const direction = params.direction || 'down';
    const amount = Number(params.amount || params.value) || 600;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (dir, amt, sel) => {
        const target = sel ? document.querySelector(sel) : window;
        if (!target) throw new Error('Scroll target container not found');
        let top = 0;
        if (dir === 'down') top = amt;
        else if (dir === 'up') top = -amt;
        else if (dir === 'top') top = -999999;
        else if (dir === 'bottom') top = 999999;
        target.scrollBy ? target.scrollBy({ top, behavior: 'instant' }) : (target.scrollTop += top);
        return { scrollX: window.scrollX, scrollY: window.scrollY };
      },
      args: [direction, amount, params.selector || '']
    });
    await recordAudit({
      tool: 'browser_scroll',
      action: 'scroll',
      selector: params.selector || 'window',
      url: tab.url,
      origin: tabOrigin,
      decision: 'auto_safe',
      status: 'success'
    });
    return { ok: true, result: 'Scrolled', ...result.result };
  }

  // Element actions: click, type, select
  const selector = String(params.selector || '').trim();
  if (!selector) throw new Error('Element selector or ref (@e1) required');
  if (selector.length > 500) throw new Error('Selector too long');

  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (act, sel, val, clearBefore, pressEnter) => {
      // Find element by data-sb-ref or selector
      let el = null;
      if (sel.startsWith('@e')) {
        el = document.querySelector(`[data-sb-ref="${sel}"]`);
      }
      if (!el) {
        el = document.querySelector(sel);
      }
      if (!el) throw new Error(`Element not found for selector "${sel}".`);

      // Security check: strictly block sensitive fields (password, payment cards, file upload) (BUG FIX #7)
      if (el.matches('input[type="password"], [autocomplete*="password"], [autocomplete*="cc-"], [autocomplete*="cvv"], input[type="file"]')) {
        throw new Error('Security violation: interaction with sensitive credential or payment fields is blocked.');
      }

      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });

      if (act === 'click') {
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.click();
        return { clicked: sel, text: (el.innerText || el.value || '').slice(0, 50) };
      }

      if (act === 'select') {
        if (!(el instanceof HTMLSelectElement)) throw new Error('Target element is not a <select> element');
        const options = Array.from(el.options);
        const match = options.find(o => o.value === val || o.text.trim() === val.trim());
        if (!match) throw new Error(`Option "${val}" not found in select`);
        el.value = match.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: match.value, label: match.text };
      }

      if (act === 'type') {
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)) {
          throw new Error('Target element is not an editable input or textarea');
        }
        if (el.readOnly || el.disabled) throw new Error('Target input field is disabled or readonly');

        if (clearBefore) {
          el.value = '';
        }

        const textToSet = clearBefore ? String(val) : (el.value || '') + String(val);
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) {
          setter.call(el, textToSet);
        } else {
          el.value = textToSet;
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        if (pressEnter) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        }

        return { typedLength: String(val).length, selector: sel };
      }

      throw new Error(`Unsupported action "${act}"`);
    },
    args: [action, selector, String(params.value ?? params.text ?? ''), Boolean(params.clear), Boolean(params.pressEnter)]
  });

  await recordAudit({
    tool: `browser_${action}`,
    action,
    selector,
    url: tab.url,
    origin: tabOrigin,
    decision: isApprovedOrigin ? 'auto_safe' : 'approved',
    status: 'success'
  });

  return { ok: true, result: res.result };
}

// -----------------------------------------------------------------------------
// Message Dispatcher (BUG FIX #1: Independent Top-Level Handlers)
// -----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || typeof message?.type !== 'string') return false;

  (async () => {
    // 1. SWITCHBOARD_GET_CAPTURE
    if (message.type === 'SWITCHBOARD_GET_CAPTURE') {
      const { captured } = await chrome.storage.session.get('captured');
      return { ok: Boolean(captured?.data), ...captured };
    }

    // 2. SWITCHBOARD_LIST_TABS (Independent handler)
    if (message.type === 'SWITCHBOARD_LIST_TABS') {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const valid = tabs
        .filter(t => SAFE_URL.test(t.url || ''))
        .map(t => ({
          id: t.id,
          title: t.title || 'Untitled',
          url: t.url || '',
          active: Boolean(t.active),
          auditedOrigin: t.url ? new URL(t.url).origin : ''
        }));
      return { ok: true, tabs: valid };
    }

    // 3. SWITCHBOARD_CAPTURE_SCREENSHOT (Independent handler, BUG FIX #6)
    if (message.type === 'SWITCHBOARD_CAPTURE_SCREENSHOT') {
      const tab = await getActiveTab();
      const tabOrigin = new URL(tab.url).origin;
      const { approvedOrigins = [] } = await chrome.storage.local.get('approvedOrigins');
      if (!approvedOrigins.includes(tabOrigin)) {
        throw new Error(`Site origin "${tabOrigin}" must be approved before screenshot capture.`);
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality: Number(message.quality) || 65
      });
      await recordAudit({
        tool: 'browser_screenshot',
        action: 'screenshot',
        url: tab.url,
        origin: tabOrigin,
        decision: 'auto_safe',
        status: 'success'
      });
      return { ok: true, dataUrl, url: tab.url, title: tab.title };
    }

    // 4. SWITCHBOARD_REFRESH_CAPTURE
    if (message.type === 'SWITCHBOARD_REFRESH_CAPTURE') {
      const tab = await getActiveTab();
      await ensureTabMonitoring(tab.id);
      const data = await capturePage(tab, message.options);
      await chrome.storage.session.set({
        captured: { tabId: tab.id, data, at: Date.now() }
      });
      return { ok: true, data };
    }

    // 5. SWITCHBOARD_BROWSER_ACTION (Manual or script actions)
    if (message.type === 'SWITCHBOARD_BROWSER_ACTION') {
      const action = message.action;
      if (!action) throw new Error('Action is required');
      return await executeBrowserAction(action, message, {
        tabId: message.tabId,
        skipOriginCheck: false
      });
    }

    // 6. SWITCHBOARD_EXECUTE_TOOL (Direct agent tool runner)
    if (message.type === 'SWITCHBOARD_EXECUTE_TOOL') {
      const { tool, args = {} } = message;
      return await handleToolExecution(tool, args);
    }

    // 7. SWITCHBOARD_GET_AUDIT_LOG
    if (message.type === 'SWITCHBOARD_GET_AUDIT_LOG') {
      const { auditLog = [] } = await chrome.storage.local.get('auditLog');
      return { ok: true, auditLog };
    }

    // 8. SWITCHBOARD_CLEAR_AUDIT_LOG
    if (message.type === 'SWITCHBOARD_CLEAR_AUDIT_LOG') {
      await chrome.storage.local.set({ auditLog: [] });
      return { ok: true };
    }

    // 9. SWITCHBOARD_WORKFLOW_REPLAY
    if (message.type === 'SWITCHBOARD_WORKFLOW_REPLAY') {
      const { steps = [] } = message;
      return await replayWorkflow(steps);
    }

    if (message.type === 'SWITCHBOARD_BRIDGE_CONNECT') {
      return await pairBridge(message);
    }
    if (message.type === 'SWITCHBOARD_BRIDGE_DISCONNECT') {
      return await disconnectBridge();
    }
    if (message.type === 'SWITCHBOARD_BRIDGE_SYNC_STATUS') {
      await syncBrowserState();
      return { ok: true };
    }

    // 10. SWITCHBOARD_BRIDGE_STATUS (live socket health, not a stale stored boolean)
    if (message.type === 'SWITCHBOARD_BRIDGE_STATUS') {
      return bridgeStatus();
    }

    throw new Error(`Unknown message type: "${message.type}"`);
  })().then(
    result => respond(result),
    error => respond({ ok: false, error: errorMessage(error) })
  );

  return true; // Keep channel open for async response
});

// -----------------------------------------------------------------------------
// Unified Agent Tool Execution Engine (All 13 Tools)
// -----------------------------------------------------------------------------
async function handleToolExecution(toolName, args = {}) {
  const tab = await getActiveTab();
  await ensureTabMonitoring(tab.id);

  switch (toolName) {
    case 'browser_tabs_list': {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const valid = tabs
        .filter(t => SAFE_URL.test(t.url || ''))
        .map(t => ({ id: t.id, title: t.title, url: t.url, active: Boolean(t.active) }));
      return { ok: true, tabs: valid };
    }

    case 'browser_tab_select': {
      if (!args.tabId) throw new Error('tabId is required');
      const updated = await chrome.tabs.update(Number(args.tabId), { active: true });
      return { ok: true, tab: { id: updated.id, title: updated.title, url: updated.url } };
    }

    case 'browser_navigate': {
      if (!args.url) throw new Error('url is required');
      return await executeBrowserAction('navigate', { url: args.url }, { tabId: args.tabId });
    }

    case 'browser_dom_snapshot': {
      const snapshot = await capturePage(tab, args);
      return { ok: true, ...snapshot };
    }

    case 'browser_screenshot': {
      const siteOrigin = new URL(tab.url).origin;
      const { approvedOrigins = [] } = await chrome.storage.local.get('approvedOrigins');
      if (!approvedOrigins.includes(siteOrigin)) {
        await recordAudit({ tool: 'browser_screenshot', action: 'screenshot', url: tab.url,
          origin: siteOrigin, decision: 'rejected', status: 'error', error: 'Unapproved site' });
        throw new Error('Screenshot denied: approve this site origin in Browser Companion first.');
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality: Number(args.quality) || 65
      });
      await recordAudit({ tool: 'browser_screenshot', action: 'screenshot', url: tab.url,
        origin: siteOrigin, decision: 'approved', status: 'success' });
      return { ok: true, dataUrl, url: tab.url, title: tab.title };
    }

    case 'browser_click': {
      return await executeBrowserAction('click', args, { tabId: args.tabId });
    }

    case 'browser_type': {
      return await executeBrowserAction('type', args, { tabId: args.tabId });
    }

    case 'browser_scroll': {
      return await executeBrowserAction('scroll', args, { tabId: args.tabId });
    }

    case 'browser_select': {
      return await executeBrowserAction('select', args, { tabId: args.tabId });
    }

    case 'browser_wait': {
      const timeoutMs = Math.min(10000, Number(args.timeoutMs) || 3000);
      const delayMs = Number(args.delayMs) || 0;
      if (delayMs > 0) {
        await new Promise(r => setTimeout(r, Math.min(10000, delayMs)));
        return { ok: true, waitedMs: delayMs };
      }
      const selector = String(args.selector || '');
      if (!selector) throw new Error('selector or delayMs required for wait');
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const [check] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: sel => Boolean(document.querySelector(sel)),
          args: [selector]
        });
        if (check.result) {
          return { ok: true, selector, elapsedMs: Date.now() - start };
        }
        await new Promise(r => setTimeout(r, 200));
      }
      throw new Error(`Timeout waiting for selector "${selector}" after ${timeoutMs}ms`);
    }

    case 'browser_extract': {
      const selector = String(args.selector || '');
      if (!selector) throw new Error('selector required for extraction');
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (sel, attr, multiple) => {
          const list = multiple ? Array.from(document.querySelectorAll(sel)) : [document.querySelector(sel)].filter(Boolean);
          if (!list.length) return null;
          return list.map(el => {
            if (attr && attr !== 'text') return el.getAttribute(attr) || '';
            return (el.innerText || el.textContent || '').trim();
          });
        },
        args: [selector, String(args.attribute || 'text'), Boolean(args.multiple)]
      });
      if (res.result === null) throw new Error(`No elements matched selector "${selector}".`);
      return { ok: true, selector, results: res.result };
    }

    case 'browser_console_logs': {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (filterLevel, doClear) => {
          const logs = window.__sb_console_logs || [];
          const filtered = filterLevel && filterLevel !== 'all' ? logs.filter(l => l.level === filterLevel) : logs;
          if (doClear) window.__sb_console_logs = [];
          return filtered;
        },
        args: [String(args.level || 'all'), Boolean(args.clear)]
      });
      return { ok: true, logs: res.result || [] };
    }

    case 'browser_network_errors': {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: doClear => {
          const errs = window.__sb_network_errors || [];
          if (doClear) window.__sb_network_errors = [];
          return errs;
        },
        args: [Boolean(args.clear)]
      });
      return { ok: true, errors: res.result || [] };
    }

    default:
      throw new Error(`Unknown tool "${toolName}".`);
  }
}

// -----------------------------------------------------------------------------
// Workflow Replay Engine (Sequential with Target Validation & Retries)
// -----------------------------------------------------------------------------
let activeReplayCancelled = false;

async function replayWorkflow(steps = []) {
  activeReplayCancelled = false;
  const results = [];
  const tab = await getActiveTab();

  for (let i = 0; i < steps.length; i++) {
    if (activeReplayCancelled) {
      results.push({ step: i + 1, status: 'cancelled', message: 'Replay stopped by user.' });
      break;
    }
    const step = steps[i];
    let attempts = 0;
    let stepSuccess = false;
    let stepError = null;

    while (attempts < 3 && !stepSuccess) {
      attempts++;
      try {
        await executeBrowserAction(step.action, step, { tabId: tab.id });
        stepSuccess = true;
      } catch (err) {
        stepError = err;
        await new Promise(r => setTimeout(r, 600)); // Bounded retry backoff
      }
    }

    results.push({
      step: i + 1,
      action: step.action,
      selector: step.selector || '',
      status: stepSuccess ? 'success' : 'failed',
      attempts,
      error: stepSuccess ? undefined : errorMessage(stepError)
    });

    if (!stepSuccess) {
      break; // Sequential execution halts on unrecoverable failure
    }
  }

  return { ok: results.every(r => r.status === 'success'), results };
}
