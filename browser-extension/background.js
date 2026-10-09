const MAX_TEXT = 24000;
const SAFE_URL = /^https?:\/\//i;
const ACTIONS = new Set(['click', 'type', 'scroll']);
function errorMessage(error) { return String(error?.message || error); }
function getActiveTab() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (!tab?.id || !SAFE_URL.test(tab.url || '')) throw new Error('Open a regular HTTP(S) page.');
    return tab;
  });
}
async function capture(tab) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: max => ({
      title: document.title, url: location.href,
      text: (document.body?.innerText || '').slice(0, max),
      selection: String(getSelection() || '').slice(0, 8000),
      elements: [...document.querySelectorAll('a,button,input,textarea,select,[role="button"]')]
        .filter(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
        .slice(0, 120).map(el => ({
          tag: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute('aria-label') || '').slice(0, 100),
          type: el.getAttribute('type') || '', name: el.getAttribute('name') || '',
          placeholder: el.getAttribute('placeholder') || ''
        }))
    }),
    args: [MAX_TEXT]
  });
  return injection.result;
}
chrome.action.onClicked.addListener(async tab => {
  try {
    if (!tab?.id || !SAFE_URL.test(tab.url || '')) throw new Error('Open a regular HTTP(S) page.');
    const data = await capture(tab);
    await chrome.storage.session.set({ captured: { tabId: tab.id, data, at: Date.now() } });
  } catch (error) {
    await chrome.storage.session.set({ captured: { error: errorMessage(error), at: Date.now() } });
  }
  if (tab.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || typeof message?.type !== 'string') return false;
  (async () => {
    if (message.type === 'SWITCHBOARD_GET_CAPTURE') {
      const { captured } = await chrome.storage.session.get('captured');
      return { ok: Boolean(captured?.data), ...captured };
    }
    if (message.type === 'SWITCHBOARD_BROWSER_ACTION') {
      if (!ACTIONS.has(message.action)) throw new Error('Unsupported action');
      const tab = await getActiveTab();
      const { captured } = await chrome.storage.session.get('captured');
      if (captured?.tabId !== tab.id || captured?.data?.url !== tab.url) throw new Error('Capture this exact page using the toolbar icon first.');
      const { approvedOrigins = [] } = await chrome.storage.local.get('approvedOrigins');
      if (!approvedOrigins.includes(new URL(tab.url).origin)) throw new Error('Site not approved. Allow this origin in the panel first.');
      const selector = String(message.selector || '');
      const value = String(message.value || '').slice(0, 4000);
      if (selector.length > 500) throw new Error('Selector too long');
      if (message.action !== 'scroll' && !selector) throw new Error('CSS selector required');
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (action, selector, value) => {
          if (action === 'scroll') { window.scrollBy({ top: Math.max(-1500, Math.min(1500, Number(value) || 600)), behavior: 'instant' }); return 'Scrolled'; }
          const el = document.querySelector(selector);
          if (!el) throw new Error('Element not found');
          if (el.matches('input[type=password],input[type=file],[autocomplete*=cc-],[autocomplete*=password]')) throw new Error('Sensitive fields are blocked');
          if (action === 'click') { el.click(); return 'Clicked'; }
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error('Typing requires input or textarea');
          if (el.readOnly || el.disabled) throw new Error('Field is not editable');
          const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
          setter?.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'Typed';
        },
        args: [message.action, selector, value]
      });
      return { ok: true, result: result.result };
    }
    throw new Error('Unknown message');
  })().then(respond, error => respond({ ok: false, error: errorMessage(error) }));
  return true;
});
