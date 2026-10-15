# Switchboard Local AI via npm — P2 release-candidate evidence (15 Oct 2026)

**Status:** npm distribution + local manager integration QA PASS; full P2 release HOLD.
**Repository:** farijarifriyanto-debug/switchboard; branch feat/local-core-integration-20261015; PR #31 Draft.
**Device:** authorized Windows laptop `home`. This work did not push, merge, publish, restart production, or alter the user's global npm package.

## Architecture: one original model manager

- The existing `@botconnector/switchboard` npm package and `sbx` executable remain the entry point.
- Original BotConnector Local Core source under `vendor/botconnector-local-core/` is **copied unchanged from pinned commit** `1aa37824ea5d6bcd35f499c892a68cecfa695660`. The original CLI, runtime ownership rules, GGUF downloader, models store, original web manager, and MIT license are retained.
- `sbx local` delegates to the original `botconnector ui --ui-port 32100`; `sbx local status` delegates to the original `runtime status --json`; all other `sbx local <args>` are passed through to that same CLI. No second runtime, downloader, model manager, or browser permission gate is created.
- The existing Switchboard UI and provider selector use the Local Core loopback API at `127.0.0.1:11435`. Explicit Local AI selections fail closed on missing/hijacked providers or redirects; no hidden Cloud fallback was permitted by tests.
- GGUF weights and hardware-dependent `llama.cpp` runtime binaries are **not installed/downloaded automatically**. The original model manager retains explicit user control.
- Portable Windows ZIP remains an optional distribution, not a replacement for npm.

## Verified tests

| Scenario | Result |
| --- | --- |
| `npm ci --offline --ignore-scripts` with updated lockfile | PASS (105 packages) |
| `npm run typecheck`, `npm run build`, `git diff --check` | PASS |
| Full `npm test` including `test:npm-local-core` | PASS, exit code 0 |
| npm tarball includes pinned original CLI, web manager assets, Core license and SOURCE-REVISION | PASS |
| npm package installed offline under isolated prefix; `node dist/cli.js local --help` and `local status` | PASS |
| Actual original model manager HTTP on localhost, clean profile, then stops | PASS (source + tarball install) |
| npm global-prefix `sbx.cmd local status` on Windows, without changing existing global installation | PASS |
| No automatic GGUF / runtime install on fresh profile | PASS |
| Local HTTP redirect, disconnect and provider hijack Cloud fallback guards | PASS, Cloud calls 0 (contract tests) |
| Existing model picker desktop and 390px checks | PASS from earlier P2 QA |

**Final npm candidate:** `%TEMP%\\switchboard-npm-release-candidate-20261015\\botconnector-switchboard-0.4.1.tgz`, 744,460 bytes.
**SHA256:** `AEBA9D249D8506719AEFBB20ED2CDFD027CF487154B971870202FA38A0B6A0CC`.
The candidate is local only and **not** published to npmjs.

## Release gates not yet cleared

1. Full native GGUF 4K browser-agent E2E on safe RAM; contract trimming is not itself a real inference success.
2. Actual optional model/runtime installation and inference on a genuinely new Windows user profile. The clean-profile manager smoke intentionally does not download/install models.
3. Chrome 153/156 follow-up and remaining original Claude comparison for Browser Companion; separate from Switchboard's main npm delivery.
4. GitHub Actions CI against the *newly pushed* P2 commit, including Node 20/22 and installed npm tarball acceptance tests.
5. Release version/tag determination and explicit owner authorization for push, merge, npm publish, GitHub release, and Chrome Web Store updates individually.

Do not claim P2 fully released, or claim local model download/native GGUF E2E passed, before those gates are addressed.
