# Switchboard direct side-panel BYOK — implementation and security gate

Date: 2026-10-29. Base: branch `feat/switchboard-tasks-api-key-20261029`.
This work is on a local branch, **not** published to npm / Chrome Web Store.

## User experience

Chrome Browser Companion chat has a collapsible **AI Cloud — masukkan API key**
form. Click **Atur model & API key** to open it. The user enters a
provider (BotConnector Cloud / OpenRouter / Groq), exact model ID, and API key directly inside the
side panel. The existing "Pengaturan lengkap" button still opens local Web
Console > Models for advanced provider setup. No new model manager was created.

Submitting the form creates a credential-free, 120-second pending request.
It opens the separately authenticated local Web Console, which displays the
specific provider, model and whether the default changes. Only an explicit
"**Izinkan sekali**" click approves the pending request. The extension then
sends the key in one guarded request; the backend reuses
`ctx.providers.create`, `ctx.credentials.set`, and
`ctx.providers.setDefault`. No API key goes into the grant URL or into
Chrome storage. The form clears the key on save, cancellation, and failure.
An active model switch starts the next conversation in a new session.

## Security boundaries

- Companion bearer tokens retain their existing chat/agent privileges; they
  do **not** authorize `/api/settings` or the console approval endpoint.
- Only the Chrome extension connected via the active companion WebSocket may
  initiate and commit a BYOK request; requests are bound to the actual
  connected `chrome-extension://` Origin and paired bearer.
- Approval is exclusively through the regular Web Console authenticated
  session (independent console cookie/token), and requires a human click.
  No approval is granted by opening a link (GET is read-only).
- One-time 128-bit random ID; memory-only, expires in two minutes, limited to
  five pending per origin. The commit consumes the grant **before** awaiting
  credential writes; a parallel replay cannot reuse it.
- Only predeclared HTTPS endpoints/protocols are accepted, avoiding arbitrary
  key exfiltration via user-supplied URLs. BotConnector Cloud uses the existing
  first-party endpoint `https://api.botconnector.id/v1` (`openai-chat`),
  provider ID `byok-botconnector`, and the existing repository default
  `agnes-3.0-flash`; users may enter a supported model ID explicitly.
  Support for arbitrary endpoints remains restricted to Web Console advanced
  settings.
- Provider/model values are fixed/validated on request; they cannot be
  changed at commit time. Model IDs are bounded and allowlisted for syntax.
- The backend only returns `configured`, selected provider/model metadata.
  Secrets are write-only and never appear in responses, logs, browser URLs,
  or agent context. A successful store does **not** independently prove that
  a provider key is valid; the UI makes this explicit.
- Site permissions and Manual/Auto/Skip agent action rules are untouched.

## Acceptance evidence

`node test/test-companion-byok.mjs` PASS:
unauthorized/foreign-origin calls rejected; no self-approval; no preapproval
commit; one-use approval; correct provider allowlist; write-only storage;
optional default does not override active selection. BotConnector Cloud is
accepted through the same one-use consent process, rejects preapproval and
replay writes, and is pinned to the first-party HTTPS gateway; values from
the commit body cannot redirect the key to another provider.

`npm run test:tasks:chrome` PASS:
real disposable Chrome + paired worker + separate Web Console authentication,
side-panel BotConnector Cloud selection/model default, key form input,
Web Console consent, backend credential save, input cleared, and explicit
assertion that the test key is absent from
`chrome.storage.local`. Uses a **fake local test key** and does not
call any cloud provider, charge an account or use the user's live Chrome profile.

## Release status and scope

Developer QA only. Existing public 0.4.6 is unaffected. Independent owner
profile acceptance, Chrome Store disclosure review and explicit publish
authorization remain necessary. Provider choices in this quick form are
BotConnector Cloud, OpenRouter and Groq; other providers remain available
through existing Web Console settings. The test used a fake key: real
BotConnector API-key validity and a fresh live inference through this newly
selected preset have **not** been independently verified in this change.
