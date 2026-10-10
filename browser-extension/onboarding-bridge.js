// Install detection and an explicit open companion action on local Switchboard pages.
// Zero browser tools, credentials, secrets, or pairing rights are exposed to the webpage.
(() => {
  'use strict';
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) return;

  const requestType = 'switchboard:companion:request';
  const replyType = 'switchboard:companion:reply';
  let lastOpen = 0;

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || message.type !== requestType || typeof message.nonce !== 'string' ||
        !/^[a-zA-Z0-9_-]{12,72}$/.test(message.nonce)) return;
    if (!['ping', 'open'].includes(message.action)) return;

    let status = 'installed';
    if (message.action === 'open') {
      if (Date.now() - lastOpen < 2500) return;
      lastOpen = Date.now();
      try {
        const reply = await chrome.runtime.sendMessage({ type: 'SWITCHBOARD_OPEN_COMPANION' });
        status = reply?.ok ? 'opened' : 'open_failed';
      } catch {
        status = 'open_failed';
      }
    }

    // Public presentation status only. Never pass local storage, model keys,
    // browser results, pairing codes or runtime error stack traces to a page.
    window.postMessage({
      type: replyType,
      nonce: message.nonce,
      action: message.action,
      status,
    }, location.origin);
  });
})();
