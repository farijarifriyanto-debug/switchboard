# OpenSandbox Local Docker — Windows Docker Desktop E2E QA (13 October 2026, session 2)

**Scope:** real end-to-end verification of PR #24 OpenSandbox **Local (Docker)** mode on this Windows laptop (Docker Desktop 29.7.2, Linux engine/WSL2, overlay2). No product rewrite; QA clone `C:\Users\farij\switchboard-opensandbox-qa-20261013` at commit `76fe907`. The owner's live repo `C:\Users\farij\switchboard` was not touched.

**Result: PASS — Windows release gate for Local Docker mode is now satisfied on the E2E axis.** Cloud PAYG stays disabled (`PAYG_CLOUD_DISABLED`); no wallet debit involved anywhere in this session.

## Environment actions taken

- Started Docker Desktop (`Start-Process …\Docker Desktop.exe`); Linux engine came up (ServerVersion 29.7.2, OSType linux, driver overlay2/WSL2).
- Pulled official public sandbox image `opensandbox/code-interpreter:latest` (digest `sha256:64cd01f0…`). The repo's default test image `botconnector/opensandbox-code:20261012` is a **private** image not pullable on laptops — that was the sole cause of the earlier Windows "sandbox_create 404" failure, not a Windows bug.
- Test-only change committed: `scripts/test-plugin-local-opensandbox.mjs` now honors `SBX_TEST_OPENSANDBOX_IMAGE` (same pattern already used by the private-server test). Default falls back to the original pinned private image, so existing VPS behavior is unchanged.
- `npx tsc --noEmit` and `npm run build` PASS after all changes.

## Reference comparison matrix (required by repo AGENTS.md)

| Fitur / acuan | Perilaku acuan (official OpenSandbox / existing Switchboard) | Perilaku kita di Windows | Bukti uji nyata (Windows Docker Desktop) | Keputusan |
|---|---|---|---|---|
| Lifecycle API create | `POST /v1/sandboxes` with `image.uri` + top-level `entrypoint`, `resource_limits`, `timeout` | Verified against the pinned server's own OpenAPI; plugin delegates to official `opensandbox-mcp==1.1.1` (no custom request shaping) | Manual curl create → `202 Accepted`, then real MCP `sandbox_create` → `Running` | MATCH |
| Tool surface | Official MCP exposes 24 tools | Same 24 tools attached after local install without app restart | `LOCAL_DOCKER_PLUGIN_CONNECTED_PASS 24` | MATCH |
| Untrusted execution | Python in sandbox returns `6*7 → 42` | Identical | `command_run` stdout `42`, `exit_code 0` → `LOCAL_DOCKER_REAL_MCP_EXEC_42_PASS` | MATCH |
| Loopback-only publish | Server published on 127.0.0.1, never `0.0.0.0` | Same | Docker `docker ps` ports `127.0.0.1:<dyn>->18088`, sandbox ports `127.0.0.1` | PASS |
| Secret hygiene | Random 32-byte key, stored in credentials, **not** echoed in installed-mcp registry | Same | `LOCAL_DOCKER_LOOPBACK_AND_SECRET_STORE_PASS` | PASS |
| Cross-origin install guard | Website cannot silently install; forged endpoint rejected | Same on Windows | `LOCAL_PLUGIN_CSRF_DENIED_PASS`, `LOCAL_PLUGIN_FORGED_ENDPOINT_DENIED_PASS` | PASS |
| Cleanup on Remove | Owned container + config + key removed | Same; `--rm` server container gone, credentials cleaned | `LOCAL_DOCKER_UNINSTALL_REMOVES_CONTAINER_AND_KEY_PASS`, `LOCAL_DOCKER_SANDBOX_DESTROY_PASS` | PASS |
| Restart/reconnect | `--restart unless-stopped` server + persisted install reconnect on new host boot | Simulated app restart (new host, same settings dir) reconnects MCP with 24 tools, real exec works, ownership label intact | `RESTART_RECONNECT_FULL_PASS` (8/8) | PASS |
| Container hardening | Official server image `de9f40d1…`; sandbox `no-new-privileges`, dropped caps, pids/mem/cpu caps, loopback ports | Verified by real `docker inspect` of the created sandbox | `["no-new-privileges=true"]`, CapDrop 9 caps (incl. SYS_ADMIN/NET_ADMIN), PidsLimit 128, Memory 512MiB, NanoCpus 0.5, ports 127.0.0.1 | PASS |
| Foreign-container safety | Cleanup must never remove containers it doesn't own | Real Docker test: same naming pattern WITHOUT ownership label → refused `/not owned/`, container kept running | `REAL_DOCKER_FOREIGN_CONTAINER_NOT_REMOVED_PASS` | PASS |
| Docker-missing preflight | Fail closed with clear message | `docker` absent from PATH → clear error before any resource creation | `GUARD_DOCKER_MISSING_FAILS_BEFORE_INSTALL_PASS` (+ `76fe907` message for stopped Linux engine) | PASS |
| UI (Settings → Plugins & MCP → OpenSandbox → Local) | Real Chrome click-through: toggle modes, Install → 24 tools, Remove, no overflow at 390px | Real Chrome (laptop Chrome binary) at 1365x820 and 390x844 | `CHROME_LOCAL_RUNTIME_UI_E2E_PASS` (5/5) + catalog 5/5 PASS; screenshots refreshed in `reports/` | PASS |
| Regression scope | Semgrep MCP, catalog, MCP bridge, settings, web, CI/schedule unaffected | Full suite PASS on Windows | see list below | PASS |

## Full suite evidence (all PASS on this Windows machine)

- `test:plugin-local-opensandbox` with public-image override: **8/8 PASS** (incl. `LOCAL_DOCKER_FULL_E2E_PASS`)
- `scripts/test-plugin-local-restart.mjs`: **8/8 PASS** (restart/reconnect, ownership label, clean uninstall)
- `scripts/test-plugin-local-ownership.mjs` (new, real-docker foreign-container audit): **PASS**
- `test:plugin-local-guards`: PASS (Windows runs the covered subset; POSIX fake-docker paths remain for Linux CI — execFile cannot run sh fakes on Windows; the same guards are additionally proven by the real-docker ownership test)
- `test:plugin-catalog` 11/11, `test:plugin-catalog-browser` 5/5, `test:plugin-local-browser` 6/6 (real Chrome via `SBX_TEST_CHROME_PATH`)
- `test:web`, `test:tools-web`, `test:mcp`, `test:mcp-extended`, `test:settings-api`, `test:settings-ui`, `test:web-token`, `test:ci`, `test:schedule`, `test:doctor`, `test:approval`, `test:agents-md`, `test:date`, `test:gauge`, `test:badge`, `test:subagent`, `test:providers`, `test:retry`, `test:ctx`, `test:split`, `smoke`, `test:adapters` — all PASS
- Build/typecheck PASS; pinned image digest verified locally (`de9f40d1…` → image ID resolves).

## Security notes (honest boundaries)

- **Not gVisor.** Local mode runs on plain Docker bridge (same as official local deployments); sandbox egress network is not restricted by default. Documentation already forbids marketing it as equivalent to Cloud gVisor — unchanged.
- **Docker socket mounted into the trusted local server container** — inherent to the official local-mode design; documented in prior report, unchanged.
- File ACLs on Windows: chmod(0600) is a no-op on NTFS (inherited user-profile ACL, user-private). Files are not world-readable; POSIX-mode semantics remain for macOS/Linux. No blocker.
- `bico-pg-dev` (owner's other container) untouched throughout; cleaned up after each test (no leftover `sbx-opensandbox-*` or sandbox containers at end of session).

## Limitations / remaining (non-blocking for this gate)

1. **Private image default unchanged**: laptops without `SBX_TEST_OPENSANDBOX_IMAGE` still target the private image and will fail with a clear pull error; only VPS with registry access uses it. Optional follow-up: make the repo default the public `opensandbox/code-interpreter` image — owner decision.
2. Private-server mode could not be verified against a live private endpoint from this laptop (VPS unreachable on Tailscale at test time); UI toggle + endpoint/key handling already proven by real-Chrome E2E, and private-mode server E2E passed previously on VPS.
3. Portable packaging (Node+uv bundled) and CI on the draft PR remain the owner's separate release steps.

**Verdict: Local (Docker) mode — GO from the Windows E2E QA axis.** Release/merge/deploy remain owner decisions per repo rules.