// A lightweight visual onboarding state for the LOCAL Switchboard Web UI.
// This is NOT a security credential check: the localhost content-script reply
// is advisory. The authenticated Switchboard service remains authoritative
// about whether the background WebSocket is connected.
(() => {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const frame = byId('companion-onboarding');
  const stateLabel = byId('companion-onboarding-state');
  const description = byId('companion-onboarding-description');
  const install = byId('companion-onboarding-install');
  const open = byId('companion-onboarding-open');
  const code = byId('companion-onboarding-code');
  const codeStatus = byId('companion-onboarding-code-status');
  const preview = byId('companion-onboarding-preview');
  const preset = byId('preset-mini');
  if (!frame || !preset) return;

  const reqType = 'switchboard:companion:request';
  const replyType = 'switchboard:companion:reply';
  let installed = false;
  let server = null;
  let nonce = null;
  let lastResponseAt = 0;
  let openNonce = null;

  // No localStorage, bearer token, pairing secret or model key crosses the
  // window message boundary. Nonces are UI correlation, not authentication.
  const freshNonce = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(18)), n => n.toString(16).padStart(2, '0')).join('');

  const visible = () => preset.value === 'browser';
  const setVisible = (element, show) => { element.hidden = !show; };

  function render() {
    frame.hidden = !visible();
    if (frame.hidden) return;

    const connected = server?.connected === true;
    const available = server?.bridgeReady === true;
    const store = /Edg\//.test(navigator.userAgent) ? server?.storeUrls?.edge : server?.storeUrls?.chrome;
    install.removeAttribute('href');
    const hasStore = typeof store === 'string' &&
      /^https:\/\/(?:chromewebstore\.google\.com\/detail\/|microsoftedge\.microsoft\.com\/addons\/detail\/)/.test(store);
    if (hasStore) install.href = store;

    setVisible(install, !installed && hasStore);
    install.textContent = /Edg\//.test(navigator.userAgent) ? 'Install from Edge Add-ons' : 'Install from Chrome Web Store';
    setVisible(preview, !installed && !hasStore);
    setVisible(open, installed);
    setVisible(code, installed && !connected && available);

    if (connected && installed) {
      stateLabel.textContent = 'Connected';
      description.textContent = 'Ready for browser actions from Switchboard. Website approvals still apply.';
    } else if (installed) {
      stateLabel.textContent = 'Pairing needed';
      description.textContent = available
        ? 'Open Companion, enter the one-time code, and connect once. It will reconnect automatically.'
        : 'The extension is installed. Start sbx web on this computer to enable pairing.';
    } else if (connected) {
      stateLabel.textContent = 'Connected elsewhere';
      description.textContent = 'A Companion is connected to Switchboard, but is not detected in this browser.';
    } else {
      stateLabel.textContent = 'Not detected';
      description.textContent = hasStore
        ? 'Install once from your browser store, then refresh this Switchboard tab.'
        : 'Browser store listing is pending. The preview installation requires manual setup.';
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.type !== replyType) return;
    if (data.action === 'ping' && data.nonce === nonce && data.status === 'installed') {
      installed = true; lastResponseAt = Date.now(); render();
    }
    if (data.action === 'open' && data.nonce === openNonce) {
      openNonce = null;
      if (data.status === 'open_failed') {
        codeStatus.textContent = 'Use the puzzle icon in your browser toolbar to open Switchboard Companion.';
        codeStatus.hidden = false;
      }
    }
  });

  function ping() {
    if (!visible()) return;
    // After an extension reload, stale visual detection must expire. The
    // backend's connected state is independent of this UI-only hint.
    if (lastResponseAt && Date.now() - lastResponseAt > 11000) installed = false;
    nonce = freshNonce();
    window.postMessage({ type: reqType, nonce, action: 'ping' }, location.origin);
    render();
  }

  async function refreshServer() {
    if (!visible()) return;
    try {
      const res = await fetch('/api/browser-companion-setup/status', { cache: 'no-store' });
      if (res.ok) server = await res.json();
      else server = null;
    } catch {
      server = null;
    }
    render();
  }

  open.addEventListener('click', () => {
    codeStatus.hidden = true;
    openNonce = freshNonce();
    window.postMessage({ type: reqType, nonce: openNonce, action: 'open' }, location.origin);
    // If extension was uninstalled after the last ping, show a recovery hint.
    setTimeout(() => {
      if (!openNonce) return;
      openNonce = null;
      codeStatus.textContent = 'Companion did not respond. Refresh the page or open it from the browser extensions menu.';
      codeStatus.hidden = false;
    }, 2000);
  });

  code.addEventListener('click', async () => {
    code.disabled = true;
    codeStatus.hidden = false;
    try {
      const res = await fetch('/api/browser-companion-setup/code', { cache: 'no-store' });
      if (!res.ok) throw new Error('The local Switchboard bridge is unavailable.');
      const info = await res.json();
      if (!info.code) throw new Error('Code expired or already used. Restart sbx web to generate another code.');
      await navigator.clipboard.writeText(info.code);
      codeStatus.textContent = 'Code copied. Paste it in Companion → Connection. Valid for 15 minutes or until used.';
    } catch (error) {
      codeStatus.textContent = error.message || 'Unable to copy pairing code.';
    } finally {
      code.disabled = false;
    }
  });

  preset.addEventListener('change', () => { render(); ping(); void refreshServer(); });
  const tick = () => {
    if (visible()) { ping(); void refreshServer(); }
    else frame.hidden = true;
  };
  tick();
  setInterval(tick, 4500);
})();
