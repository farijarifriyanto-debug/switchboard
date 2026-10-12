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
    const tab = (await boundAgentTab()) || await getActiveTab();
    activeTab = { id: tab.id, title: tab.title || '', url: tab.url, auditedOrigin: new URL(tab.url).origin };
  } catch (_) {
    // Restricted/non-HTTP pages never receive browser actions.
  }
  const { permissionMode: storedMode } = await chrome.storage.local.get('permissionMode');
  const permissionMode = normalizeActionMode(storedMode);
  if (storedMode !== permissionMode) await chrome.storage.local.set({ permissionMode });
  // Only native Chrome host grants are reported as site access.
  const candidates = new Set();
  if (activeTab?.auditedOrigin) candidates.add(activeTab.auditedOrigin);
  if (chrome.permissions?.getAll) {
    const { origins = [] } = await chrome.permissions.getAll();
    for (const pattern of origins) {
      if (!/^https?:\/\/[^*]+\/\*$/.test(pattern)) continue;
      try { candidates.add(new URL(pattern.slice(0, -1)).origin); } catch (_) {}
    }
  }
  const grantedOrigins = [];
  for (const origin of candidates) {
    try { if (await siteAccessGranted(origin)) grantedOrigins.push(origin); } catch (_) {}
  }
  const response = await fetch(config.url + '/api/browser-companion/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.token },
    body: JSON.stringify({ activeTab, approvedOrigins: grantedOrigins, mode: permissionMode }),
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
    // Action approval in Switchboard does not substitute for Chrome site access.
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

// Native messaging: the local host returns the companion token the CLI wrote on this computer.
// Only the extension IDs in the host manifest can start it, so no typed code is needed.
const NATIVE_HOST_NAME = 'com.botconnector.switchboard';
async function pairViaNativeHost() {
  const reply = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { type: 'get-companion-token' });
  if (!reply?.ok || !/^[a-f0-9]{48}$/.test(reply.token || '')) throw new Error(reply?.error || 'Native host returned no token.');
  const url = validBridgeUrl(reply.url);
  const response = await fetch(url + '/api/browser-companion/pair', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: reply.token }),
  });
  if (!response.ok) throw new Error('Native pairing rejected (HTTP ' + response.status + ').');
  const data = await response.json();
  if (!data.ok || !data.token) throw new Error('Invalid pairing response.');
  await chrome.storage.local.set({ bridgeUrl: url, companionToken: data.token, bridgeConnected: true });
}

async function ensureBridgeSocket() {
  if (socketIsOpen()) return true;
  if (bridgeConnectPromise) return bridgeConnectPromise;
  bridgeConnectPromise = (async () => {
    // First run on this computer: pair through the native host instead of a typed code.
    if (!(await chrome.storage.local.get('companionToken')).companionToken) {
      try { await pairViaNativeHost(); } catch (_) { /* host not installed or sbx not running yet */ }
    }
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
  if (changes.permissionMode) scheduleStatusSync();
});
chrome.permissions?.onAdded?.addListener(() => scheduleStatusSync());
chrome.permissions?.onRemoved?.addListener(() => scheduleStatusSync());

void chrome.alarms.create(BRIDGE_ALARM, { periodInMinutes: 0.5 });
void ensureBridgeSocket().catch(() => {});

// Trusted input and screenshots go through the DevTools Protocol, as Claude in Chrome does.
// The debugger is attached only for the duration of one action.
async function withDebugger(tabId, run) {
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
  } catch (error) {
    if (!/already attached/i.test(errorMessage(error))) throw error;
  }
  try {
    return await run(target);
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
  }
}

// Named keys only (no characters, no modifier shortcuts): typing text stays in browser_type,
// where sensitive fields are checked.
const KEY_EVENTS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  'Shift+Tab': { key: 'Tab', code: 'Tab', vk: 9, modifiers: 8 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
};

async function pressKey(tab, name) {
  const spec = Object.prototype.hasOwnProperty.call(KEY_EVENTS, name) ? KEY_EVENTS[name] : null;
  if (!spec) throw new Error('Unsupported key. Use one of: ' + Object.keys(KEY_EVENTS).join(', ') + '.');
  const focus = (await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return { tag: 'body' };
      const sensitive = el.matches('input[type="password"], input[type="file"], [autocomplete*="password"], [autocomplete*="cc-"], [autocomplete*="cvv"], [autocomplete*="one-time-code"]');
      const editable = el.matches('textarea, select, [contenteditable=""], [contenteditable="true"], input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="image"])');
      return { tag: el.tagName.toLowerCase(), sensitive, editable };
    }
  }))?.[0]?.result || { tag: 'body' };
  if (focus.sensitive) throw new Error('Keyboard input into a sensitive credential, payment or file field is blocked.');
  // Enter and Space activate buttons and links; those go through browser_click so the target can be checked.
  if ((name === 'Enter' || name === 'Space') && focus.tag !== 'body' && !focus.editable) {
    throw new Error('The focused element is not a text field. Use browser_click for buttons and links so the target can be checked.');
  }
  await withDebugger(tab.id, async target => {
    const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers: spec.modifiers || 0 };
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...base, type: spec.text ? 'keyDown' : 'rawKeyDown', ...(spec.text ? { text: spec.text } : {}) });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  });
  await recordAudit({
    tool: 'browser_key', action: 'key', url: tab.url,
    origin: new URL(tab.url).origin, decision: 'approved', status: 'success'
  });
  return { ok: true, result: { key: name } };
}

async function screenshotWithUserGrant(tab, quality) {
  const result = await withDebugger(tab.id, target =>
    chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'jpeg', quality }));
  if (!result?.data) throw new Error('Screenshot failed: Chrome returned no image data.');
  return 'data:image/jpeg;base64,' + result.data;
}

// Labels that name an authorization. Clicking one is a Protected action (AGENTS §6, Claude in Chrome).
const AUTHORIZATION_LABEL = /\b(allow|authori[sz]e|grant|consent|approve|izinkan|setujui|otorisasi)\b/i;

async function readElementLabel(tabId, selector) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        const el = document.querySelector(sel);
        if (!el) return '';
        return [el.innerText, el.value, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ').slice(0, 200);
      },
      args: [selector]
    });
    return String(res?.result || '');
  } catch (_) {
    return '';
  }
}

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
        const labelledByText = (el.getAttribute('aria-labelledby') || '').split(/\s+/)
          .map(id => document.getElementById(id)?.textContent || '').join(' ');
        const associatedLabelText = Array.from(el.labels || []).map(label => label.textContent || '').join(' ');
        const sensitiveHints = [type, el.id, el.getAttribute('name'), el.getAttribute('autocomplete'),
          el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'),
          labelledByText, associatedLabelText].join(' ');
        const isSensitive = isPassword || el.matches('[autocomplete*="password"], [autocomplete*="cc-"], [autocomplete*="cvv"], input[type="file"]') ||
          /credit.?card|card.?number|cvv|cvc|ssn|social.?security|national.?id|passport/i.test(sensitiveHints);

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
        let hrefOrigin = '';
        try { if (el.href) hrefOrigin = new URL(el.href, location.href).origin; } catch (_) {}

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
          hrefOrigin: hrefOrigin || undefined,
          placeholder: el.getAttribute('placeholder') || undefined,
          disabled: el.hasAttribute('disabled') || undefined,
          isSensitive: isSensitive || undefined,
          value: isSensitive ? '[PROTECTED_FIELD]' : (el.value ? String(el.value).slice(0, 50) : undefined)
        });
      }

      // Simple hash for change detection & observation caching
      let hash = 0;
      const hashStr = title + url + text.slice(0, 500) + elements.map(el => [el.ref, el.selector, el.tag, el.type, el.text, el.isSensitive, el.hrefOrigin].join(':')).join('|');
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

  if (!injection?.result || typeof injection.result.url !== 'string' ||
      !Array.isArray(injection.result.elements)) {
    throw new Error('Unable to read page DOM; content script returned no valid snapshot');
  }
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
    // Clicking the toolbar MUST open the panel immediately. Never queue an
    // approval wait before the user can reach the permission button.
    if (!(await siteAccessGranted(new URL(tab.url).origin))) {
      await chrome.storage.session.set({ captured: null });
    } else {
      await ensureTabMonitoring(tab.id);
      const data = await capturePage(tab);
      await chrome.storage.session.set({
        captured: { tabId: tab.id, data, at: Date.now() }
      });
    }
  } catch (error) {
    await chrome.storage.session.set({
      captured: { error: errorMessage(error), at: Date.now() }
    });
  }
  await opening.catch(() => {});
});

// One site-permission authority: Chrome native host grants. Browser commands
// can wait for a grant, but only a user gesture can invoke Chrome's prompt.
// Switchboard does NOT maintain a second site-approval gate.
const pendingSiteRequests = new Map();
// "Allow this action" grants host access only for one tool call; these origins lose it when the call ends.
const oneTimeOrigins = new Set();
const SITE_APPROVAL_WAIT_MS = 75_000;

function sitePattern(origin) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
    throw new Error('Invalid site origin');
  }
  return url.protocol + '//' + url.hostname + '/*';
}
async function siteAccessGranted(origin) {
  if (!chrome.permissions?.contains) return false;
  try { return await chrome.permissions.contains({ origins: [sitePattern(origin)] }); }
  catch (_) { return false; }
}
async function publishPendingSite() {
  const first = pendingSiteRequests.values().next().value;
  await chrome.storage.session.set({ pendingSiteAccess: first ? {
    origin: first.origin, tool: first.tool, requestedAt: first.requestedAt
  } : null });
  await chrome.action.setBadgeText({ text: first ? '!' : '' });
  if (first) {
    await chrome.action.setBadgeBackgroundColor({ color: '#ae691a' });
    await chrome.action.setTitle({ title: 'Approval needed: ' + first.origin });
    try {
      chrome.notifications.create('switchboard-approval', {
        type: 'basic', iconUrl: 'icons/bico-48.png',
        title: 'Switchboard needs site access',
        message: 'Allow ' + first.origin + ' in the Switchboard panel to continue.'
      });
    } catch (_) {}
  } else {
    await chrome.action.setTitle({ title: 'Open Switchboard Companion' });
  }
}
// Resolves once the tab reports "complete" on the target URL (or after a timeout).
function waitForTabLoad(tabId, targetHref, timeoutMs = 15000) {
  const targetOrigin = new URL(targetHref).origin;
  const onTarget = (current) => current?.status === 'complete' && String(current.url || '').startsWith(targetOrigin);
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, change, updated) => {
      if (id === tabId && onTarget({ ...updated, status: change.status ?? updated?.status })) done();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    timer = setTimeout(done, timeoutMs);
    chrome.tabs.get(tabId).then((current) => {
      if (onTarget(current)) done();
    }, done);
  });
}

async function waitForSiteAccess(origin, tool) {
  if (oneTimeOrigins.has(origin)) {
    throw new Error('Temporary Chrome site permission is in use by another browser action; retry after it completes.');
  }
  const hadGrant = await siteAccessGranted(origin);
  if (oneTimeOrigins.has(origin)) {
    throw new Error('Temporary Chrome site permission is in use by another browser action; retry after it completes.');
  }
  // Manual/Auto action policy does not override Chrome's site-level decision.
  if (hadGrant) return;
  if (!chrome.permissions?.contains) {
    throw new Error('Chrome host permission unavailable. Update Browser Companion.');
  }
  let request = pendingSiteRequests.get(origin);
  if (!request) {
    request = { origin, tool, requestedAt: Date.now(), waiting: [] };
    pendingSiteRequests.set(origin, request);
    await publishPendingSite();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    waiter.timer = setTimeout(() => {
      request.waiting = request.waiting.filter(item => item !== waiter);
      reject(new Error('Site access timed out: ' + origin +
        '. Open Browser Companion and allow this site.'));
      if (!request.waiting.length && pendingSiteRequests.get(origin) === request) {
        pendingSiteRequests.delete(origin);
        void publishPendingSite();
      }
    }, SITE_APPROVAL_WAIT_MS);
    request.waiting.push(waiter);
  });
}
async function settleSiteAccess(origin, allowed, once = false) {
  const request = pendingSiteRequests.get(origin);
  if (!request) return { ok: false, error: 'No pending site request' };
  if (allowed) {
    if (!(await siteAccessGranted(origin))) {
      return { ok: false, error: 'Chrome did not grant this site permission' };
    }
    if (once) oneTimeOrigins.add(origin);
  }
  pendingSiteRequests.delete(origin);
  const waiters = request.waiting.splice(0);
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
  }
  if (allowed && once) {
    waiters.shift()?.resolve();
    for (const waiter of waiters) {
      waiter.reject(new Error('One-action Chrome grant was reserved for another browser action; retry after it completes.'));
    }
  } else {
    for (const waiter of waiters) {
      if (allowed) waiter.resolve();
      else waiter.reject(new Error('User denied site access: ' + origin));
    }
  }
  await publishPendingSite();
  return { ok: true };
}
async function requireTabSite(tab, tool) {
  await waitForSiteAccess(new URL(tab.url).origin, tool);
}

function normalizeActionMode(value) {
  if (value === 'manual' || value === 'ask_every_time') return 'manual';
  if (value === 'skip') return 'skip';
  return 'auto';
}
async function releaseOneTimeGrants() {
  const origins = [...oneTimeOrigins].map(sitePattern);
  oneTimeOrigins.clear();
  if (origins.length) {
    if (!chrome.permissions?.remove) throw new Error('Chrome cannot remove temporary site permission');
    const removed = await chrome.permissions.remove({ origins });
    if (!removed) throw new Error('Could not remove temporary Chrome site permission');
  }
}

// -----------------------------------------------------------------------------
// Core Browser Action Executor
// -----------------------------------------------------------------------------
async function executeBrowserAction(action, params = {}, options = {}) {
  const tab = options.tabId ? await chrome.tabs.get(options.tabId) : await getActiveTab();
  if (!tab?.id || !SAFE_URL.test(tab.url || '')) throw new Error('Valid active HTTP(S) tab required');

  const tabOrigin = new URL(tab.url).origin;


  // Navigating out of a tab never reads its source DOM. Authorize the target,
  // not the starting page; other actions need explicit site consent.
  const isApprovedOrigin = await siteAccessGranted(tabOrigin);
  let userApproved = false;
  if (action !== 'navigate' && MUTATING_ACTIONS.has(action)) {
    await requireTabSite(tab, 'browser_' + action);
    await ensureTabMonitoring(tab.id);
    // Do not inspect page content (even a target label) until Chrome grants access.
    const authorization = action === 'click' && AUTHORIZATION_LABEL.test(await readElementLabel(tab.id, String(params.selector || '')));
    userApproved = authorization;
  }

  // Handle navigate
  if (action === 'navigate') {
    const targetUrl = new URL(String(params.url || params.value || ''), tab.url);
    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      throw new Error('Navigation restricted to HTTP/HTTPS URLs.');
    }
    await waitForSiteAccess(targetUrl.origin, 'browser_navigate');
    await chrome.tabs.update(tab.id, { url: targetUrl.href });
    // Wait for the new page so the next read does not hit the previous document.
    await waitForTabLoad(tab.id, targetUrl.href);
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
    if (!result?.result || !Number.isFinite(result.result.scrollY)) {
      throw new Error('Scroll action failed; page did not return a scroll position');
    }
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
    func: async (act, sel, val, clearBefore, pressEnter) => {
      try {
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
      const labelledByText = (el.getAttribute('aria-labelledby') || '').split(/\s+/)
        .map(id => document.getElementById(id)?.textContent || '').join(' ');
      const associatedLabelText = Array.from(el.labels || []).map(label => label.textContent || '').join(' ');
      const sensitiveHints = [el.type, el.id, el.name, el.getAttribute('autocomplete'),
        el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'),
        labelledByText, associatedLabelText].join(' ');
      const sensitiveByLabel = /credit.?card|card.?number|cvv|cvc|security.?code|card.?verification|ssn|social.?security|national.?id|passport/i.test(sensitiveHints);
      if (el.matches('input[type="password"], [autocomplete*="password"], [autocomplete*="cc-"], [autocomplete*="cvv"], input[type="file"]') || sensitiveByLabel) {
        throw new Error('Security violation: interaction with sensitive credential or payment fields is blocked.');
      }

      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });

      if (act === 'click') {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) throw new Error(`Element "${sel}" is not visible.`);
        return { point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, clicked: sel };
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

        const isRichText = el.isContentEditable;
        const current = isRichText ? (el.textContent || '') : (el.value || '');
        const textToSet = clearBefore ? String(val) : current + String(val);
        if (isRichText) {
          // Contenteditable is not an HTMLInputElement: its value setter throws.
          el.textContent = textToSet;
        } else {
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, textToSet);
          else el.value = textToSet;
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        // Let synchronous framework handlers settle, then verify the live DOM
        // value without returning the user's text to the extension or chat.
        await new Promise(resolve => setTimeout(resolve, 0));
        const liveValue = isRichText ? (el.textContent || '') : (el.value || '');
        if (liveValue !== textToSet) {
          throw new Error('Browser input value could not be verified after typing; inspect the field before retrying.');
        }

        if (pressEnter) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        }

        return { typed: true, selector: sel, verified: true };
      }

      throw new Error(`Unsupported action "${act}"`);
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
    args: [action, selector, String(params.value ?? params.text ?? ''), Boolean(params.clear), Boolean(params.pressEnter)]
  });

  // Chrome may return null when injected code throws. Fail closed rather
  // than falsely reporting a successful or safely blocked browser action.
  if (!res?.result || res.result.ok === false) {
    const error = res?.result?.error || 'Browser action did not complete';
    await recordAudit({
      tool: 'browser_' + action, action, selector, url: tab.url,
      origin: tabOrigin, decision: 'rejected', status: 'error', error
    });
    throw new Error(error);
  }

  if (action === 'click') {
    const { x, y } = res.result.point;
    await withDebugger(tab.id, async target => {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1
        });
      }
    });
    delete res.result.point;
  }
  // Tool output is persisted in chat history and traces; never return page or
  // input values from mutations, even if an injected page function does so.
  if (action === 'type') {
    if (res.result.verified !== true) {
      const error = 'Browser input value could not be verified after typing; inspect the field before retrying.';
      await recordAudit({
        tool: 'browser_type', action, selector, url: tab.url,
        origin: tabOrigin, decision: 'rejected', status: 'error', error
      });
      throw new Error(error);
    }
    res.result = { typed: true, selector, verified: true };
  }
  if (!options.quiet) await recordAudit({
    tool: `browser_${action}`,
    action,
    selector,
    url: tab.url,
    origin: tabOrigin,
    decision: isApprovedOrigin && !userApproved ? 'auto_safe' : 'approved',
    status: 'success'
  });

  return { ok: true, result: res.result };
}

// -----------------------------------------------------------------------------
// Message Dispatcher (BUG FIX #1: Independent Top-Level Handlers)
// -----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || typeof message?.type !== 'string') return false;

  // Content scripts run with the extension id too, but their sender URL is the
  // host page. Only extension-owned pages may call privileged APIs. The sole
  // webpage entry point is the localhost onboarding nudge below.
  let extensionPage = false;
  try {
    const senderUrl = new URL(sender.url || '');
    extensionPage = senderUrl.protocol === 'chrome-extension:' && senderUrl.host === chrome.runtime.id;
  } catch (_) {}
  const localhostOnboarding = message.type === 'SWITCHBOARD_OPEN_COMPANION' && sender.tab &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(sender.tab.url || '');
  if (!extensionPage && !localhostOnboarding) return false;

  (async () => {
    // 1. SWITCHBOARD_GET_CAPTURE
    if (message.type === 'SWITCHBOARD_GET_CAPTURE') {
      const { captured } = await chrome.storage.session.get('captured');
      return { ok: Boolean(captured?.data), ...captured };
    }

    // Tab metadata does not require a DOM-injection or host grant.
    if (message.type === 'SWITCHBOARD_ACTIVE_TAB') {
      const tab = (await boundAgentTab()) || await getActiveTab();
      return { ok: true, tab: {
        id: tab.id, title: tab.title || 'Untitled', url: tab.url, origin: new URL(tab.url).origin
      } };
    }
    if (message.type === 'SWITCHBOARD_PENDING_ACCESS') {
      const request = pendingSiteRequests.values().next().value;
      return { ok: true, pending: request ? {
        origin: request.origin, tool: request.tool, requestedAt: request.requestedAt
      } : null };
    }
    if (message.type === 'SWITCHBOARD_SITE_APPROVAL_GRANTED') {
      return await settleSiteAccess(String(message.origin || ''), true, message.once === true);
    }
    if (message.type === 'SWITCHBOARD_SITE_APPROVAL_DENIED') {
      return await settleSiteAccess(String(message.origin || ''), false);
    }
    if (message.type === 'SWITCHBOARD_SITE_ACCESS_STATUS') {
      const origins = chrome.permissions?.getAll ? (await chrome.permissions.getAll()).origins || [] : [];
      const origin = String(message.origin || '');
      return { ok: true, granted: origin ? await siteAccessGranted(origin) : false, origins };
    }
    if (message.type === 'SWITCHBOARD_SITE_ACCESS_REVOKE') {
      const origin = String(message.origin || '');
      const removed = await siteAccessGranted(origin) && chrome.permissions?.remove
        ? await chrome.permissions.remove({ origins: [sitePattern(origin)] }) : false;
      scheduleStatusSync();
      return { ok: true, removed: Boolean(removed) };
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
      if (!(await siteAccessGranted(tabOrigin))) {
        throw new Error('Chrome site permission is required for screenshot capture: ' + tabOrigin);
      }
      const dataUrl = await screenshotWithUserGrant(tab, Number(message.quality) || 65);
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
      await requireTabSite(tab, 'browser_dom_snapshot');
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

    // Presentation-only onboarding. Open our own trusted extension page;
    // never accept URLs, browser tool names or pairing tokens from a webpage.
    if (message.type === 'SWITCHBOARD_OPEN_COMPANION' && sender.tab &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(sender.tab.url || '')) {
      const panelUrl = chrome.runtime.getURL('panel.html?view=settings');
      const open = await chrome.tabs.query({ url: panelUrl });
      if (open.length) await chrome.tabs.update(open[0].id, { active: true });
      else await chrome.tabs.create({ url: panelUrl });
      return { ok: true };
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
// Downloads start from a click on the page. The download is reported only when Chrome actually starts it.
async function downloadViaClick(tab, args) {
  let onCreated;
  let timer;
  const started = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      chrome.downloads.onCreated.removeListener(onCreated);
      reject(new Error('No download started within 15 seconds after the click.'));
    }, 15000);
    onCreated = item => {
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      resolve(item);
    };
    chrome.downloads.onCreated.addListener(onCreated);
  });
  try {
    await executeBrowserAction('click', args, { tabId: tab.id, quiet: true });
  } catch (error) {
    clearTimeout(timer);
    chrome.downloads.onCreated.removeListener(onCreated);
    throw error;
  }
  const item = await started;
  await recordAudit({
    tool: 'browser_download', action: 'download', selector: String(args.selector || ''),
    url: item.url, origin: new URL(tab.url).origin, decision: 'approved', status: 'success'
  });
  return { ok: true, result: 'Download started', filename: item.filename, url: item.url };
}

// Tabs the agent opens go into one tab group named "Switchboard", as Claude in Chrome groups its tabs.
let agentGroupId = null;

// The tab the agent works in. Tools without an explicit tabId use this tab, so
// switching tabs in Chrome does not move the agent (Claude in Chrome's tab group).
let agentTabId = null;
async function boundAgentTab() {
  const id = agentTabId ?? (await chrome.storage.session.get('agentTabId')).agentTabId;
  if (!id) return null;
  try {
    return await chrome.tabs.get(id);
  } catch (_) {
    agentTabId = null;
    return null;
  }
}
function bindAgentTab(id) {
  agentTabId = id;
  chrome.storage.session.set({ agentTabId: id }).catch(() => {});
}
async function createAgentTab(url) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Tab creation restricted to HTTP/HTTPS URLs.');
  await waitForSiteAccess(target.origin, 'browser_tab_create');
  const tab = await chrome.tabs.create({ url: target.href, active: true });
  bindAgentTab(tab.id);
  let groupId = agentGroupId;
  if (groupId !== null) {
    try { await chrome.tabGroups.get(groupId); } catch (_) { groupId = null; }
  }
  if (groupId === null) {
    groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title: 'Switchboard', color: 'blue' });
    agentGroupId = groupId;
  } else {
    await chrome.tabs.group({ tabIds: [tab.id], groupId });
  }
  await recordAudit({
    tool: 'browser_tab_create', action: 'tab_create', url: target.href,
    origin: target.origin, decision: 'approved', status: 'success'
  });
  return { ok: true, result: 'Opened ' + target.href, tab: { id: tab.id, url: target.href, groupId } };
}

async function handleToolExecution(toolName, args = {}) {
  try { return await runToolExecution(toolName, args); }
  finally { await releaseOneTimeGrants(); }
}
async function runToolExecution(toolName, args = {}) {
  // Listing and switching tabs never inject content scripts.
  if (toolName === 'browser_tabs_list') {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    // Mark the agent's own tab so the model does not confuse it with the focused tab.
    const agentId = (await boundAgentTab())?.id ?? null;
    return { ok: true, agentTabId: agentId, tabs: tabs.filter(t => SAFE_URL.test(t.url || ''))
      .map(t => ({ id: t.id, title: t.title, url: t.url, active: Boolean(t.active), agent: t.id === agentId })) };
  }
  // Opening a new tab does not depend on the current tab being an HTTP page.
  if (toolName === 'browser_tab_create') {
    return await createAgentTab(String(args.url || ''));
  }
  if (toolName === 'browser_tab_select') {
    if (!args.tabId) throw new Error('tabId is required');
    const updated = await chrome.tabs.update(Number(args.tabId), { active: true });
    bindAgentTab(updated.id);
    return { ok: true, tab: { id: updated.id, title: updated.title, url: updated.url } };
  }
  if (toolName === 'browser_tab_close') {
    if (!args.tabId) throw new Error('tabId is required');
    const target = await chrome.tabs.get(Number(args.tabId));
    // The user's own tabs stay open; only tabs Switchboard opened (its tab group) can be closed.
    let owned = false;
    if (Number.isInteger(target.groupId) && target.groupId >= 0) {
      try { owned = (await chrome.tabGroups.get(target.groupId)).title === 'Switchboard'; } catch (_) { owned = false; }
    }
    if (!owned) throw new Error('Only tabs opened by Switchboard can be closed.');
    await chrome.tabs.remove(target.id);
    await recordAudit({
      tool: 'browser_tab_close', action: 'tab_close', url: target.url || '',
      origin: SAFE_URL.test(target.url || '') ? new URL(target.url).origin : '',
      decision: 'approved', status: 'success'
    });
    return { ok: true, result: 'Closed tab ' + target.id };
  }
  // No bound tab yet: navigate opens its own grouped tab, others adopt the current tab.
  if (toolName === 'browser_navigate' && !args.tabId && !(await boundAgentTab())) {
    return await createAgentTab(String(args.url || ''));
  }
  let tab;
  if (args.tabId) {
    tab = await chrome.tabs.get(Number(args.tabId));
  } else {
    tab = await boundAgentTab();
    if (!tab) {
      tab = await getActiveTab();
      bindAgentTab(tab.id);
    }
  }
  if (!tab?.id || !SAFE_URL.test(tab.url || '')) throw new Error('Valid HTTP(S) tab required');
  if (toolName !== 'browser_navigate') {
    const mutatingAction = toolName.startsWith('browser_') && MUTATING_ACTIONS.has(toolName.slice(8));
    // Mutating actions do their permission check before any page injection.
    if (!mutatingAction) {
      await requireTabSite(tab, toolName);
      await ensureTabMonitoring(tab.id);
    }
  }

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
      return await executeBrowserAction('navigate', { url: args.url }, { tabId: tab.id });
    }

    case 'browser_dom_snapshot': {
      const snapshot = await capturePage(tab, args);
      await recordAudit({
        tool: 'browser_dom_snapshot', action: 'read', url: tab.url,
        origin: new URL(tab.url).origin, decision: 'auto_safe', status: 'success'
      });
      return { ok: true, tabId: tab.id, ...snapshot };
    }

    case 'browser_screenshot': {
      const siteOrigin = new URL(tab.url).origin;
      if (!(await siteAccessGranted(siteOrigin))) {
        await recordAudit({ tool: 'browser_screenshot', action: 'screenshot', url: tab.url,
          origin: siteOrigin, decision: 'rejected', status: 'error', error: 'Chrome host permission missing' });
        throw new Error('Screenshot denied: allow this site in Chrome Browser Companion first.');
      }
      const dataUrl = await screenshotWithUserGrant(tab, Number(args.quality) || 65);
      await recordAudit({ tool: 'browser_screenshot', action: 'screenshot', url: tab.url,
        origin: siteOrigin, decision: 'approved', status: 'success' });
      return { ok: true, dataUrl, url: tab.url, title: tab.title };
    }

    case 'browser_download': return await downloadViaClick(tab, args);
    case 'browser_tab_create': return await createAgentTab(String(args.url || ''));
    case 'browser_click': {
      return await executeBrowserAction('click', args, { tabId: tab.id });
    }

    case 'browser_type': {
      return await executeBrowserAction('type', args, { tabId: tab.id });
    }

    case 'browser_scroll': {
      return await executeBrowserAction('scroll', args, { tabId: tab.id });
    }

    case 'browser_key': return await pressKey(tab, String(args.key || ''));

    case 'browser_select': {
      return await executeBrowserAction('select', args, { tabId: tab.id });
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
