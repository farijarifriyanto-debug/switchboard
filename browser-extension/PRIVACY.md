# Switchboard Browser Companion — Privacy Policy

**Effective date:** 29 October 2026
**Product:** Switchboard Browser Companion (Chrome and Microsoft Edge extension)
**Publisher:** BotConnector
**Open-source project:** https://github.com/farijarifriyanto-debug/switchboard
**Support and privacy requests:** https://github.com/farijarifriyanto-debug/switchboard/issues

## Overview and purpose

Switchboard Browser Companion supports two modes: (1) BotConnector Cloud standalone: the user enters their own BotConnector API key in the side panel, then the extension directly calls the fixed HTTPS gateway at https://api.botconnector.id/v1/chat/completions and orchestrates browser tools without Switchboard CLI or Web Console; (2) optional local companion mode, connecting to a Switchboard process on the same computer. BotConnector Cloud usage and billing depend on the user's API-key account and chosen model. The extension does not host an AI model itself.

This policy covers the browser extension in standalone Cloud and optional local-companion modes. Separate AI providers, optional plugins, and external websites have their own privacy terms.

## Categories of information handled

When a user activates browser tools, Browser Companion may access:

- **Website content:** the page's visible text, DOM/HTML-derived content, links, headings, form elements and selected text; when specifically requested and allowed by the browser, screenshots. Website content may incidentally contain personal identifiers, communications, location, financial or health information.
- **Browsing information:** active tab and selected tab IDs, website URLs, origins, page titles and changes to the selected browser tabs. This information can also appear in local activity/audit records.
- **User interactions:** requested clicks, scrolling, navigation, text entry, selected elements and resulting tool status. User-supplied form text may be transmitted for the requested action and may be recorded in Switchboard sessions or model inputs.
- **Local authentication and settings:** a randomly issued Browser Companion pairing credential (not an AI provider API key), the loopback service address, connection state, permitted site origins, permission mode, optional saved workflow steps and a bounded activity log.
- **Optional user-entered API keys (BYOK):** BotConnector Cloud standalone stores the user-entered BotConnector API key in Chrome/Edge **extension-local** storage, restricted to trusted extension contexts; it is not synced via Chrome sync storage or written to webpage scripts, logs, chat messages, query strings, or activity records. The key is sent only as an HTTPS Authorization header to https://api.botconnector.id when loading the available-model catalog or running the Cloud agent. The form clears the visible password field after saving. The key remains in extension-local storage until the user chooses "Hapus API key Cloud" or clears/uninstalls the extension. Extension-local storage is not an encrypted vault: do not enter keys on a shared/untrusted device. In optional **local companion mode**, non-BotConnector BYOK still uses the authenticated local Web Console and its separate write-only credentials store.
- **Installation detection metadata:** a public extension identifier and a short transient request nonce exchanged with the local Switchboard page only, without page content or pairing credentials.

The extension attempts to block actions targeting password, payment-card and file-upload fields and masks those fields in its DOM catalog. These safeguards do **not** guarantee that sensitive information elsewhere on a webpage will be hidden. Users should avoid authorizing sensitive pages unless they accept the associated risks.

## Collection, use and disclosure

Information is accessed only to provide the user-requested browser automation, permission controls, connection operation, troubleshooting/status and local activity history. Browser Companion does not collect browsing information for advertising, user profiling, sale or unrelated analytics.

Users grant each external website through one user-initiated Chrome/Edge native host permission flow. There is no separate Switchboard site allowlist gate. The extension declares optional HTTP/HTTPS site patterns solely to support requesting these per-site grants when needed. It does not silently enable access to all websites. Denying a requested origin prevents the browser action. Revoking a site removes the optional Chrome permission and clears any obsolete metadata. The existing local loopback connection does not require granting remote website access.

For standalone Cloud mode, the extension directly sends user instructions and selected permitted webpage content/tool results to the BotConnector HTTPS inference gateway; this is necessary for the requested agent operation, not analytics or advertising. This data leaves the device and is governed by BotConnector's account/data terms. For optional local companion mode, the extension communicates with an authenticated Switchboard process over loopback HTTP/WebSocket connections (`127.0.0.1` or `localhost`).

**Important: data can leave the device through Switchboard.** The local Switchboard agent may include selected webpage content, URLs, screenshots or browser results in its requests to the AI model provider the user has chosen, including BotConnector if selected. Such information may be processed or retained by that provider under its own terms, account settings and data policies. When the user configures external plugins or integrations, those tools may process information under their own terms. The user decides which providers and plugins to enable.

The publisher does not sell or transfer extension user data to data brokers or advertising platforms. User data is transferred to a chosen provider only where needed for the user-facing agent workflow, or as required by law or to protect security and prevent abuse. No employee or other human is authorized to read user data except with the user's explicit consent for specific support, where necessary for security, to comply with applicable law, or where data is aggregated/anonymized for internal operations as allowed by law.

## Storage, retention and user controls

Browser Companion uses Chrome/Edge local extension storage for the BotConnector Cloud API key (when explicitly configured), connection address, pairing credential (when using local mode), approved sites, preferences, saved workflows and a browser activity/audit log of up to **300** recent entries. It also uses ephemeral session storage for selected-tab state. No fixed time-based deletion interval is promised for those local records: users can clear activity history, revoke a website, disconnect the bridge, or remove the extension.

Disconnecting does not necessarily remove the saved pairing credential; it can remain to permit reconnection. Uninstalling the extension or clearing its extension storage removes browser-stored settings and credentials. The separate local Switchboard application can retain its own sessions, pairing credentials and tool results according to that installation's settings and must be managed separately. Data already sent to a third-party provider is governed by that provider's retention and deletion process.

In optional local-companion mode, loopback communication is authenticated using a pairing credential and restricted to the user's computer; that pairing credential cannot authorize API-key changes without the separately authenticated Web Console confirmation. **Standalone BotConnector Cloud does not involve local pairing or a Web Console approval**: the user saves their own API key directly in extension-local storage and can delete it there. Requests use the fixed HTTPS BotConnector endpoint. Users should protect their own credentials and avoid approving access to sensitive pages.

## Chrome Web Store Limited Use disclosure

**The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.**

We use information from browser permissions and APIs only for the prominently disclosed purpose of allowing the user to control and inspect approved browser tabs through Switchboard, including directly related security and reliability functions. We do not use or transfer this information for personalized, interest-based or retargeted advertising, for creditworthiness or lending decisions, or for unrelated purposes. Transfers are limited to those necessary for the function the user requested and the other exceptions permitted by the Chrome Web Store User Data Policy.

## Changes and contact

We may update this policy when material extension behavior changes; the current text will be published at this URL. To raise privacy concerns, request assistance with local-data removal or report a security issue, use the [Switchboard issue tracker](https://github.com/farijarifriyanto-debug/switchboard/issues). The publisher contact email shown in the Chrome Web Store listing is an additional public contact channel.

**Related project documentation:** [Browser Companion README](./README.md).

## Browser permissions

Each permission the extension requests is used only for the browser tasks the user starts:

- **debugger** is attached to a tab only while one approved action runs. It sends trusted clicks and key presses and captures screenshots, then detaches. It is not used to read other browser data.
- **downloads** observes a download that the user approved and reports its file name and source. The file contents are not read.
- **nativeMessaging** asks a small helper that the user installed on the same computer for the local pairing credential and the loopback address. The helper makes no network requests.
- **notifications** tells the user that a site permission request is waiting.
- **tabGroups** groups the tabs that Switchboard opens under one labeled group, and only those tabs can be closed by the agent.
- **Fixed HTTPS host permission** for `https://api.botconnector.id/*` is required solely for direct BotConnector Cloud inference on the user's request; no arbitrary custom cloud hosts are accepted by the standalone mode.
- **activeTab**, **scripting**, **tabs**, **storage**, **sidePanel** and **alarms** are used as described above: reading and acting on approved pages, remembering settings, showing the side panel, and reconnecting after the browser suspends the background worker.
