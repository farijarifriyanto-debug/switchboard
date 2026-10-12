# Switchboard Plugin Catalog / BotConnector integration — 2026-10-13

**Source branch:** `feat/plugin-catalog-20261013` in `farijarifriyanto-debug/switchboard` independent VPS worktree `/home/botadmin/newbotconnector/switchboard-plugin-catalog-20261013`.
**State:** Implementation + real local candidate tests PASS, **not published/released**; owner machine currently uses installed Switchboard 0.4.0 and Semgrep 1.173 MCP configured manually. The previous WebApp `/workspace/tools/` is not the intended plugin delivery product, and has not been touched by this branch.

## Owner-approved architecture

Switchboard is the only required main application. BotConnector website will list optional trusted MCP plugins (Semgrep and OpenSandbox). A website button opens the **existing local** Switchboard Plugins & MCP settings with the plugin selected; the user clicks Install there. Website JavaScript cannot silently install tools via localhost. Both plugins use their official pinned MCP server implementations, with the existing Switchboard approval gate. No new dashboard, wizard, or permission layer.

## Feature acceptance/reference matrix

| Reference behavior | Candidate implementation | Real evidence | Result |
|---|---|---|---|
| Switchboard existing MCP bridge dynamically registers tools from official servers | Uses original `mcpBridge`, plus `addServer/removeServer` for trusted catalog; same `mcp__...` names and approval | MCP/extended regression, E2E Semgrep 12 tools and OpenSandbox 24 | MATCH / additive |
| Semgrep official MCP scans code | Official pinned `semgrep==1.180.0` via uvx, not a reimplemented analyzer | Real `semgrep_scan_with_custom_rule` finds `exec(input())` | MATCH |
| OpenSandbox official MCP offers isolated commands and files | Official pinned `opensandbox-mcp==1.1.1`, configured to private local/Tailscale server; key via existing credential store | Real MCP connected 24 tools, `sandbox_create` -> `command_run` produced 42 -> `sandbox_kill` PASS on VPS | MATCH on private VPS / not yet Windows |
| Install once, tools immediately usable and persist | Operator clicks Install in existing Plugins panel; MCP hot-starts without whole app restart; nonsecret metadata chmod 0600; restart restores tools | `scripts/test-plugin-catalog.mjs`, real Chrome button click + restore-after-restart | PASS with uvx preinstalled |
| One source of approval; no hidden installation | Local UI explicit click; settings Host/Origin/JSON guard rejects cross-origin website POST | HTTP 403 remote origin, 400 arbitrary plugin command; real Chrome PASS | PASS |
| Existing user manual MCP configuration stays authoritative | Manual takes priority; catalog shows Configured and forbids replacement/deletion | Manual-override regression PASS | MATCH |
| Chrome/mobile layout in existing settings | Two small cards within existing Plugins & MCP tab | Real Chrome headless at 1365 and 390 pixels, no overflow | PASS for tested viewport |
| Website download/install link to Switchboard | Local handoff via `http://127.0.0.1:7777/?plugin=semgrep` (or `opensandbox`) opens Settings, not direct execution | Browser direct local handoff PASS, but no BotConnector website integration yet | PARTIAL / website NOT DEPLOYED |
| Switchboard single install on any OS | Currently requires `uvx` already installed or bundled by distribution; this branch does not package uv runtime | Requirement declared and preflight error handling tested | NOT DONE for public users without uvx |
| OpenSandbox self-service Cloud instance | Requires existing private endpoint/key. No per-user provisioning, metering, desktop tunnel automation | Sandbox MCP real on VPS only; no Windows remote access yet | NOT DONE |

## Test logs / commands

- `npm run typecheck && npm run build` PASS
- `npm run test:web`, `npm run test:mcp`, `npm run test:mcp-extended`, `npm run test:settings-api`, `npm run test:settings-ui` PASS
- `npm run test:plugin-catalog`: full HTTP install, prompt-injection-style arbitrary command rejected, cross-origin blocked, official Semgrep real scan, restart persisted, uninstall, manual config preserved — PASS
- `SBX_TEST_OPENSANDBOX_KEY_FILE=... npm run test:plugin-opensandbox`: official MCP 24 tools; create+execute+kill real container; private secret never in registry; removing plugin deletes stored key — PASS
- `SBX_TEST_PUPPETEER_PATH=... SBX_TEST_CHROME_PATH=... npm run test:plugin-catalog-browser`: Chrome UI desktop, click Install, click Remove, mobile 390 no overflow — PASS
- Chrome UI screenshots in `reports/plugin-catalog-desktop-20261013.png` and `reports/plugin-catalog-mobile-20261013.png` (working directory, untracked evidence).

## Source impact

- `src/services/plugin-catalog.ts` trusted pinned packages + registry and key separation.
- `src/plugins/mcp.ts` hot-add/hot-remove using existing MCP supervisor.
- `src/index.ts` startup assembly preserving manual configuration.
- `src/plugins/web.ts` same-origin local API routes for catalogue (no arbitrary command execution).
- `web/app.js`, `web/settings.css` existing Plugins & MCP panel and `?plugin=` local-console handoff.
- `README.md` documented process and limits, optional test scripts.

## Release gate

1. Review code security and website design in PR. Do not merge / push to `main` or publish npm without release authorization.
2. Ship an official uv runtime/bundled installer or clearly retain `uvx` prerequisite; confirm first-install Windows/macOS/Linux on clean devices. Windows owner machine is behind 108 commits and has uncommitted local changes — **do not overwrite its repo/config**.
3. Add an official BotConnector website plugin-store page pointing to local handoff *only once local Switchboard installation is available*. Browser install always requires a user click in Switchboard. Never permit unauthenticated remote website calls to local execution APIs.
4. Finish private OpenSandbox connection onboarding (Tailscale / SSH tunnel or local Docker runtime). Never expose sandbox HTTP publicly, invent a shared-user access key or bypass tenant isolation/billing.
5. Run real signed-in browser/operator acceptance, verify approvals, retry/reconnect and success/error messaging before public release.

## Production safety

No production Switchboard npm package or website image changed. No VPS systemd restart/deploy. No change to BotConnector WebApp or billing, and no modification to the owner's existing laptop working tree. Historical `/workspace/tools/` can only be removed in separately approved production deploy; do not remove it reflexively.
