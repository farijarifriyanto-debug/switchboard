# Switchboard × BotConnector Local Core — P0/P1 candidate, 15 Oct 2026

STATUS: staging source only; NO production deploy/restart, NO model download, NO GitHub push or merge, NO Windows real GGUF/Chrome E2E claim.

## Reference-first: reuse, not replacement

Reference source: farijarifriyanto-debug/BotConnector (native-agent-integration): runtime/runtime-manager.cjs, runtime/downloads.cjs, runtime/ownership.cjs, runtime/llama.cjs, webui/server.cjs.

BotConnector Local already has managed llama.cpp, GGUF downloads/catalog, runtime lifecycle, hardware detection, ownership locks, authenticated model manager, and inference defaulting to 127.0.0.1:11435/v1. Its /api management methods use a per-session credential and SAME-ORIGIN protections; Switchboard does NOT impersonate that UI, take its secret, or add a second model manager.

Switchboard already has a provider registry, default-model picker and openai-chat adapter. Use these unchanged.

## P0 — Local inference adapter

- src/services/botconnector-local.ts: GET /health followed by GET /v1/models with strict timeouts and 256-KiB response bound. Endpoint strictly 127.0.0.1; default port 11435 (optional SWITCHBOARD_LOCAL_CORE_PORT, integer range 1024–65535), never a browser/user-submitted URL.
- Optional BOTCONNECTOR_LOCAL_API_KEY supplied by local environment, never returned in status or committed. 401/403 and unavailable runtime fail closed. Exclude duplicate and :cloud model names.
- Existing settingsGuard/CSRF protects GET /api/settings/local-core and POST /api/settings/local-core/connect.
- Explicit model choice registers provider local-botconnector in existing registry. Conflicting existing provider is blocked, selected local model becomes the default for new runs.
- Agent/LLM guard prevents local model failure from falling through to configured Cloud fallback; local default also resolves to the local provider profile even when an agent omits the provider argument.

Ownership caveat: port 11435 might belong to llama-swap or another compatible runtime; a successful local API probe is not proof of BotConnector process ownership. Switchboard NEVER starts, stops, restarts, or replaces another local process. A compatible endpoint may itself implement remote routing; Switchboard can guarantee no additional Cloud fallback by Switchboard, not guarantee the behavior of an arbitrary third-party runtime.

## P1 — Existing Models settings UI

- Under Settings > Models, show runtime status, current model list, Periksa ulang and Gunakan model lokal.
- Model installation, download/progress, GGUF deletion and hardware settings remain in the original BotConnector Local application. No duplicate manager and no second browser permission gate.
- Reuses existing Settings sections, button styles and toast; no new settings tab or dashboard.
- Design: inherit actual settings.css tokens (#08788c accent, #00cbe7 cyan, #ffffff surface, #f9fafb alternate surface, #111111 text), with existing typography. The only new task-specific element is the local model dropdown.

## Lightweight candidate checks

- scripts/test-botconnector-local.mjs tests loopback fixture discovery, filtering of Cloud-labeled models, unauthorized status, empty/error health, explicit model registration, conflicting provider, env key, and endpoint constraint. Ran against stripped TS original on VPS Node 24; PASS.
- scripts/test-botconnector-local-ui.mjs tests offline/ready text, explicit connect button, existing default-model section and HTML escaping; PASS.
- node --check modified JS/TS PASS; git diff --check PASS.
- Not yet run: complete TypeScript compilation, full regression, actual model inference, local vision GGUF, Windows installer, Chrome E2E, desktop/390px screenshots, overflow. VPS AGENTS global section 11c prohibits heavy CI on this production machine.

## Post-change reference matrix

| Reference | Switchboard | Evidence | Result |
| --- | --- | --- | --- |
| BotConnector manages model/runtime lifecycle | No runtime/installer/file lifecycle calls | source audit | MATCH design; Windows unverified |
| BotConnector inference on loopback | local fixed-port model catalog and provider | loopback mock PASS | PARTIAL, no real model |
| Existing Switchboard Models tab | additive local status/dropdown in existing panel | UI mock PASS | PARTIAL, no browser screenshot |
| Local model failure does not invoke Cloud fallback | fail-closed chain + local provider profile | code audit, discovery fixture | PARTIAL, full model failure E2E pending |
| Claude in Chrome site permission stays Chrome-native | no browser-extension changes | source diff | UNCHANGED |

Next: owner approval to push branch from VPS for GitHub Actions Node 20/22 build/typecheck/regression, then Windows real GGUF agent+vision and Chrome/installer P2. NOT DEPLOYED and NOT READY FOR RELEASE.
