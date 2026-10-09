# Store Listing Metadata — Chrome Web Store & Edge Add-ons

This document specifies the required submission information, descriptions, permissions justifications, and privacy disclosures for publishing the **Switchboard Browser Agent** to the **Chrome Web Store** and **Microsoft Edge Add-ons**.

---

## 1. General Listing Info

- **Item Name:** Switchboard Browser Agent
- **Short Description (Max 132 chars):** Autonomous AI companion for browser tasks, research, workflows, and multi-tab automation with local Switchboard runtime.
- **Category:** Productivity / Developer Tools
- **Default Language:** English (United States)
- **Primary Website:** https://github.com/farijarifriyanto-debug/switchboard
- **Support URL:** https://github.com/farijarifriyanto-debug/switchboard/issues

---

## 2. Detailed Description

```markdown
Switchboard Browser Agent connects your browser directly to your local Switchboard agent harness. Experience privacy-first, autonomous browser automation and AI assistance with deep element-level control.

KEY FEATURES:
• Autonomous Browser Companion: Instruct the AI through a dedicated side panel to read documents, summarize web pages, fill forms, and perform multi-step web workflows.
• Deep Element Control: Powered by 13 specialized browser tools including compact DOM snapshotting, smart clicking, keyboard typing, scrolling, dropdown selection, and error inspection.
• Workflow Recording & Replay: Record manual actions, edit steps, and replay complex workflows with automatic element retry, timeout guards, and scheduling.
• Strict Security & Approvals:
  - 3 Permission Modes: Ask Every Time, Auto Safe, and Restricted.
  - Per-site origin approvals with instant revocation.
  - Automatic shielding against password fields, credit card numbers, and sensitive credential leakage.
  - Prompt injection boundary markers on all untrusted web content.
  - Full local audit logging for every browser operation.
• Single-Codebase Native Performance: Built with Chrome Manifest V3 standards, running smoothly in both Google Chrome and Microsoft Edge.

PRIVACY & DATA HANDLING:
Switchboard Browser Agent communicates exclusively with your designated local Switchboard runtime (localhost/127.0.0.1) over an authenticated loopback connection. Your browsing activity, snapshots, and inputs are never sent to external third-party telemetry servers or unauthorized cloud backends.
```

---

## 3. Permissions Justifications

| Permission | Technical Reason | User Value Justification |
|---|---|---|
| `activeTab` | Required to inspect DOM elements, capture viewport screenshots, and interact with the active page upon user gesture. | Enables the agent to read and interact with the currently focused page when you click the extension icon. |
| `sidePanel` | Provides the modern side-by-side chat interface and workflow inspector. | Allows you to chat with the AI and monitor automation progress without leaving or obscuring the current web page. |
| `storage` | Stores user preferences (theme, permission mode, site approval list, local workflow definitions, and audit logs). | Preserves your custom settings, recorded workflows, and security decisions locally across browser sessions. |
| `tabs` | Allows querying tabs (`browser_tabs_list`) and switching focus between tabs (`browser_tab_select`). | Enables multi-tab workflows, such as cross-referencing information between multiple open tabs. |
| `scripting` | Injects targeted content actions (click, type, scroll, DOM snapshot) into the active tab upon explicit user authorization. | Allows the assistant to perform verified clicks, inputs, and extractions on the page. |

---

## 4. Single-Purpose Statement

The single purpose of **Switchboard Browser Agent** is to provide an authenticated bridge between the user's local Switchboard AI agent runtime and the browser, enabling privacy-focused, user-authorized web task automation and assistance.

---

## 5. Privacy Policy & Data Disclosure

1. **Personal Information:** Does not collect, transmit, or store personally identifiable information on external servers.
2. **Authentication Credentials:** The extension specifically detects and refuses access to password fields and sensitive credential forms.
3. **Network Communications:** All bridge network requests are confined strictly to loopback addresses (`127.0.0.1` / `localhost`) using cryptographic bearer tokens.
4. **Third-Party Sharing:** Zero data is sold, transferred, or shared with data brokers or advertising platforms.
