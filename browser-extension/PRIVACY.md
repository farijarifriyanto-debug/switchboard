# Switchboard Browser Companion — Privacy Policy

**Effective date:** 10 October 2026
**Publisher:** BotConnector / Switchboard (publisher support email must be supplied before marketplace submission)
**Project:** https://github.com/farijarifriyanto-debug/switchboard

## Purpose

Switchboard Browser Companion lets the user direct the locally running Switchboard AI agent to inspect or interact with Chrome and Edge tabs. Browser actions originate from the user's Switchboard CLI or Web UI, not from an independent AI chat inside the extension. Only websites the user has explicitly approved are eligible for mutating browser operations. Switchboard's separate tool approval policy can require another confirmation before an action executes.

## Data accessed

Depending on the user's actions and site approval settings, browser tools may access the active tab's URL and title, page text, HTML structure and DOM attributes, selected page elements, and a screenshot when browser permissions allow it. The user can also direct clicking, form input, scrolling, navigation, and other permitted actions. The extension attempts to protect password and payment fields from unsafe automation.

Browser Companion stores locally: a pairing credential used to authenticate to Switchboard on the same computer, connection preferences, website-origin approvals, and a bounded browser activity/audit history. Its local browser audit is bounded to the latest 300 entries. The credential is not an API key for an AI provider.

The loopback-only installation-detection content script exchanges only a public installed/opened signal and a short ephemeral UI request identifier with the local Switchboard Web UI. It does not send page content, pairing secrets or provider API keys through that detection channel.

## How data is transmitted

The extension communicates with the authenticated Switchboard process on the user's own computer using HTTP/WebSocket loopback connections. Browser content or browser tool results requested by the user are returned to Switchboard. **Switchboard may send parts of that information to the AI model provider configured by the user** in order to interpret page contents and decide the next tool action. These providers have their own privacy policies, retention rules and processing locations. The extension does not independently select or contact external AI providers.

No browser data is sent by this extension to a BotConnector analytics or advertising endpoint as part of the Browser Companion transport itself. This does not override any separately configured Switchboard provider integrations or optional third-party plugins.

## User controls and retention

Users can approve or revoke website origins in the extension, disconnect the Browser Companion bridge, view or clear local audit entries, and remove the extension. Disconnecting stops the active browser bridge but may retain the pairing credential for reconnection. Removing the extension's local browser storage/uninstalling it clears its browser-stored settings and pairing secret. The local Switchboard process also stores its own pairing secret, sessions and tool records according to that installation's settings; uninstalling the browser extension alone does not erase those local Switchboard files.

Information already sent to an external model provider may be retained under that provider's terms, outside the extension's control.

## Data sharing, sale and advertising

The extension does not sell browser content, credentials, or user browsing data, and it does not use browser content for behavioral advertising. Content is transmitted to the user's configured Switchboard/AI provider only when required for a user-directed browser action or the resulting agent workflow.

## Security

The local bridge validates its credentials and restricts connections to loopback. Website-origin approvals and action restrictions apply to browser tools; a detected extension is not automatically authorized for browser control. The content script exposed to local Switchboard Web UI pages has presentation-only abilities (status ping and opening the extension's own settings page).

No software can guarantee complete security. Do not authorize sensitive financial, password, or personal-data actions unless you understand the destination website and the provider that will process any page content.

## Contact and updates

Issues and security concerns: https://github.com/farijarifriyanto-debug/switchboard/issues

Before Chrome Web Store or Edge Add-ons publication, the publisher must add a functioning developer contact email to the actual store listing and review this policy against the final submitted implementation. Changes to material browser data-handling behavior will be documented in this policy.
