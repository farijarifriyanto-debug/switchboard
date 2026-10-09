// Chrome and Edge MV3: the toolbar click grants activeTab; side-panel clicks do not.
chrome.action.onClicked.addListener(async tab => {
  try {
    if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Open a regular HTTP(S) page.');
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        title: document.title,
        url: location.href,
        text: (document.body?.innerText || '').slice(0, 24000),
        selection: String(getSelection() || '').slice(0, 8000)
      })
    });
    await chrome.storage.session.set({ captured: { tabId: tab.id, data: injection.result, at: Date.now() } });
  } catch (error) {
    await chrome.storage.session.set({ captured: { error: String(error.message || error), at: Date.now() } });
  }
  await chrome.sidePanel.open({ windowId: tab.windowId });
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'SWITCHBOARD_GET_CAPTURE') return false;
  chrome.storage.session.get('captured').then(({ captured }) => respond({ ok: Boolean(captured?.data), ...captured }), error => respond({ ok: false, error: String(error) }));
  return true;
});
