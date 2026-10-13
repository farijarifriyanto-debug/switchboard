# OpenSandbox Local / Private plugin — candidate 13 October 2026

**Status:** Implementation verified with real Linux Docker, official OpenSandbox server and MCP; **NOT released**. No Switchboard production/npm release, VPS service restart, or BotConnector website redeploy in this work. Windows Desktop Commander device later returned **ONLINE**; Docker Desktop CLI v29.7.2 exists but the Linux Engine named pipe was **not running**. We did not start it or alter the owner’s local Switchboard repository (which is dirty/behind). Clean Windows Docker Desktop positive E2E remains **NO-GO** until the owner starts Docker Desktop.

## Owner decision and separation

- Switchboard installed once, optional `OpenSandbox` plugin from existing BotConnector Plugin Store.
- **Local (Docker)**: uses the customer's machine and existing Docker Desktop/Engine (additional Docker prerequisite; not bundled). Select Local, click the existing Install once; Switchboard creates its own official OpenSandbox server container and 32-byte random local key, binds only 127.0.0.1, connects the official `opensandbox-mcp==1.1.1` tools without restarting the app, and persists. Remove deletes the owned container, config and key. Manually installed MCP settings retain priority.
- **My private server**: unchanged explicit private localhost/Tailscale endpoint and key. Switchboard does not alter the user's separately managed server.
- **BotConnector Cloud**: optional future offer, not required to install either mode. No Cloud charges or GIO prerequisite for Local/Private. Cloud PAYG remains `PRICING_UNVERIFIED/PAYG_CLOUD_DISABLED` and no customer wallet debit. The canonical owner policy in `production-candidate/AI_CLOUD_POLICY.md` was clarified to refer to **actual infrastructure** rather than mandating Biznet/GIO. Backup: `reports/AI_CLOUD_POLICY.before-switchboard-local-20261013.md` under production-candidate.

## Source scope

- `src/services/local-opensandbox.ts`: digest-pinned official Docker image; Docker/Linux engine preflight; dynamic available loopback port; local private config/API key; container ownership label; deterministic cleanup; Docker error diagnostics; no public bind; per-container entry uses `--security-opt no-new-privileges`, capped 1 vCPU/512MB service, and official server config caps child PIDs/drops sensitive capabilities. **The server mounts the Docker socket**; it is a trusted local component, not untrusted multi-user Cloud. This backend is plain Docker, not gVisor; default Docker bridge can allow outbound network. Never market it as equivalent to the Cloud gVisor runtime.
- `src/services/plugin-catalog.ts`: added local-mode metadata, private mode preserved, official MCP hot-attach and key separation, uninstall cleanup.
- `src/plugins/web.ts`: same-origin guarded install accepts `mode=local` with **no client-supplied key/endpoint**; private mode retains manually entered endpoint and key.
- `web/app.js` and `web/settings.css`: one small runtime selector inside existing Settings > Plugins & MCP card; no new page, permission step, or wizard.
- `README.md`: vendor-neutral customer and operator instructions.

## Real tests and reference comparison

| Feature / reference | Switchboard behavior | Evidence | Decision |
|---|---|---|---|
| Official OpenSandbox server Docker config and SDK | Official digest-pinned server with own private API and MCP client; no custom code execution engine | One-off real Docker SDK canary HTTP health, Python `42` and sandbox destroy PASS | MATCH |
| Existing Switchboard MCP plugin catalog | Same `mcp__opensandbox__*` tool names, existing agent approval and settings | `test-plugin-local-opensandbox.mjs`: 24 tools; same E2E Python `42`, sandbox destroy, Remove cleans runtime and key PASS | MATCH / additive local mode |
| Operator explicitly clicks Install | Cross-origin https://botconnector.id POST blocked; forged Local endpoint rejected; no silent installation | Real HTTP tests `LOCAL_PLUGIN_CSRF_DENIED_PASS`, `LOCAL_PLUGIN_FORGED_ENDPOINT_DENIED_PASS` | PASS |
| Existing Plugins & MCP UI | Local default, optional Private Server, no GIO/Cloud field | Chrome headless at 1365x820 and 390x844: mode toggle, Install, 24 tools, Remove and no horizontal overflow PASS; screenshots in this reports directory | MATCH on VPS; Windows NOT VERIFIED |
| Manual server mode unchanged | Private OpenSandbox official 24 MCP tools, real exec `42` | `test:plugin-opensandbox` PASS after local patch | MATCH |
| Host safety | 127.0.0.1 publish, secrets omitted from installed metadata, config file 0600, container owner labels before deletion | Full local Docker E2E + `test-plugin-local-guards.mjs`: absent Docker, Windows-container engine, missing owned container, spoofed container all handled PASS | PASS on VPS |
| Backwards compatibility | Semgrep MCP, existing MCP bridge, settings API and other plugins unaffected | `test:web`, `test:mcp`, `test:mcp-extended`, `test:settings-api`, `test:settings-ui`, `test:plugin-catalog`, `test:plugin-opensandbox` all PASS | PASS |
| Clean Windows portable + Docker Desktop | Windows Desktop installed; Docker Linux Engine currently stopped. No positive Windows UI/agent test; WSL2/port/volume/ACL differences not yet checked | Windows engine absent (Docker Desktop application installed but stopped), so no Windows positive E2E; Linux Docker Engine PASS | **NO-GO** public release |
| BotConnector Cloud PAYG | Separate, disabled, no customer debit | Canonical policy and disabled `rate-card-UNVERIFIED.json`, candidate metering tests are not real wallet settlement | **NO-GO** Cloud activation |

## Additional Windows source verification (12:2x WIB)

The owner's Windows device reconnected. Without touching the existing dirty `C:\Users\farij\switchboard` repo, cloned this PR to `C:\Users\farij\switchboard-opensandbox-qa-20261013`; `npm ci`, TypeScript typecheck, and build all PASS. Windows Docker CLI 29.7.2 is installed but the Docker Desktop Linux Engine pipe does not exist, so the new Local mode correctly fails closed and creates no new local sandbox resources. **Real Semgrep MCP test on Windows fully PASS** (12 tools, real `semgrep_scan_with_custom_rule` finding, persistence after simulated host restart, uninstall, manual MCP precedence). These are source/native MCP tests, not a positive OpenSandbox Docker Desktop runtime E2E.

## Remaining release gate

1. On a real Windows laptop with **Docker Desktop Linux containers**, install vNext Switchboard portable, visit BotConnector Plugin Store, click OpenSandbox, perform Install Local, verify actual Python code / sandbox cleanup, restart PC and confirm reconnect, and Remove. Check persisted Windows file ACL and Docker socket implications; do not only use Linux Chrome headless screenshots.
2. Confirm macOS/Linux packaging path if claiming those platforms, pin digest for supported CPU architecture, and provide clear messaging when Docker is not installed. Agent's normal tool permission remains the only AI action gate.
3. CI on draft PR; review code and no unexpected changes; merge/release only when tests pass and owner authorizes. Packaging Windows portable workflow is already available from v0.4.1; this code isn't published there yet.
4. Cloud BotConnector (if later offered): verify actual hosting and retail cost, customer identity and tenant isolation, wallet reserve/settle/refund and operator approval per canonical policy, regardless of hosting vendor.
