# P2 — Switchboard + BotConnector Local Core on Windows (15 October 2026)

**Scope:** Authorized Windows laptop `home`; opt-in P2 QA only. No production, VPS, Chrome Web Store update, npm publish or PR merge. Source branch: `feat/local-core-integration-20261015` based on PR #31. Changes here are local only until separately authorized to push.

## Reference-first / reuse

- **Original local runtime and model manager:** owner's `farijarifriyanto-debug/BotConnector` repository (MIT). Bundle is pinned to `1aa37824ea5d6bcd35f499c892a68cecfa695660`, including its original CLI, GGUF downloader, model manager, backend detection, startup ownership protection and local web UI; no reimplementation or second model manager. Model files and runtime binary are NOT bundled or silently downloaded.
- **Browser UX reference:** Claude in Chrome, actual installed 1.0.100, evidence `docs/browser-claude-headtohead-20261015.md`. This P2 does NOT claim pixel parity or repeat the signed-in reference test.
- **Architecture:** Switchboard browser agent uses existing model selector and provider adapter; local inference 127.0.0.1:11435. BotConnector Local owns original runtime and storage, launched on demand with `Manage-Local-AI.cmd`. `Start-Switchboard.cmd` starts Switchboard. One portable ZIP, two first-party entry points; model installation remains optional.

## Real Windows evidence

| Item | Test/evidence | Status |
| --- | --- | --- |
| GitHub CI on PR #31 base commit `8fe444c` | Node 20+22, typecheck/build/full suite | **PASS**, prior CI |
| Windows source unit/build | `npm ci`, `typecheck`, `build`, `test:local-core`, `test:local-core-ui` | **PASS**, prior Windows check |
| Direct local GGUF and fail-closed | SmolVLM-500M via real `llama-server`, explicit provider, unauthorized API key and Cloud fallback=0 | **PASS**, prior Windows check |
| Offline vision from real Chrome screenshot | `test/test-local-offline-vision-windows.mjs`, headed real Chrome isolated profile, JPEG → Switchboard → SmolVLM + mmproj | **PASS**: read image heading `BICO 731`; ZERO Cloud. Original question about blue rectangle answered with heading instead, so color-specific accuracy **FAIL / model limitation** |
| Browser Companion + real local AI | `test/test-browser-visible-local.mjs` in Chrome for Testing **153** and Ollama LOCAL `botconnector-fast:latest` Qwen3 4B: MV3 pairing, authenticated WebSocket, real DOM read, click, agent-chosen browser_click then browser_dom_snapshot, final `Clicks: 2` | **PASS** |
| Browser Companion + Qwen3 GGUF native llama-server | Real Qwen3 4B blob from installed Ollama, llama.cpp `--jinja` on 11435, correct tool-call with `{"selector":"#counter"}` | **PARTIAL**: agent emitted browser_click and browser_dom_snapshot, but final follow-up request had 4,216 tokens vs 4,096 context and returned HTTP 400. This is not a full PASS. RAM free reached only ~1.1 GB; intentionally stopped just QA runtime. **DO NOT** increase context on this busy laptop to force PASS |
| Browser version compatibility | Chrome for Testing **156** returned empty tab URL despite page visible; **153** exposed URL and passed; Chrome regular **155** could take screenshot | Browser 156 issue **OPEN**; no weakening native permission restrictions |
| Windows unified ZIP | `scripts/package-portable-windows.ps1` bundles pinned original BotConnector Core + its `dist/web` + LICENSE/production dependencies alongside Switchboard Node/uv | **PASS**: built `Switchboard-0.4.1-Windows-x64.zip`, 62,053,180 bytes, SHA256 `a2cbfeec8683be6406f93f38d56cc0143a20759e868bb99ab5427102891ee6f2` |
| Extracted ZIP | Original `botconnector.mjs --help`, `sbx --version`, pinned revision, license, original manager assets, two cmd launchers | **PASS** |
| Bundled manager boot | Isolated `APPDATA` sandbox, original `botconnector serve --port 32277`, HTML 20,495 bytes on localhost; QA process stopped and port closed | **PASS** |
| 390px/mobile Settings visual + full original Claude interaction | Not run in this P2 | **UNVERIFIED** |

**Security and cleanup:** QA used only local endpoints and synthetic browser fixtures; Chrome for Testing in throwaway profile, original user's browser profile/login not modified. Native Chrome site permission was not bypassed. Authenticated local llama-server with restricted CORS was used. All model/process QA was stopped after tests and test-only API key deleted. Existing Ollama processes untouched. The separate test folder and extracted QA ZIP remain, not installed over Switchboard.

## Native process/RAM issue

- The saved Spark-X2.5 4B GGUF cannot load on this installed llama.cpp build (unknown model architecture `spark2_5`). No runtime update or re-download was performed.
- Native Qwen3 GGUF tool use generated expected calls but the agent's second context request exceeded 4096 tokens. Local RAM available dropped to 1.1 GB; stopped to protect the owner's active laptop. User-facing release cannot treat this as passed.
- The default portable runtime manager must install hardware-compatible llama.cpp/model binaries on user request; the ZIP does not ship 2–12GB models, does not start another local inference service automatically, and does not silently route local prompts to a Cloud provider.

## Reference matrix

| Behavior reference | Candidate | Evidence | Result |
| --- | --- | --- | --- |
| BotConnector Local single runtime owner and model manager | Original pinned Core bundled in Switchboard ZIP, opened with Manage-Local-AI.cmd | Extracted binary and live original manager HTTP | **MATCH architecture; fresh-user model install not yet exercised** |
| Claude in Chrome browser actions with native Chrome site grants | Existing native browser permission and agent tool workflow untouched | Chrome 153 actual extension pairing/DOM/click and real local AI | **ADAPTATION / PASS tested loopback flow, not full parity** |
| Claude visual reading inside actual panel | AI offline screenshot and vision through Switchboard | Chrome screenshot and local SmolVLM, correctly read BICO 731 | **PARTIAL**, original Claude vision and model color following not verified |
| No silent paid Cloud inference | Local provider's existing fail-closed chain | Test wrong local key, fallback=0; isolated local LLM call | **PASS tested paths** |
| Windows one extracted bundle | Main Switchboard + pinned BotConnector Local CLI/manager, optional GGUF setup | 62 MB package, extraction, original manager HTTP | **PASS QA package**, not public release |

**Gate:** This is a P2 implementation/QA candidate, **NO-GO for production release** until full GGUF browser agent context and RAM envelope, new-user model installation, and browser/version checks are resolved. Keep PR #31 as Draft until owner authorizes push/merge/release.
## Lanjutan QA lokal (15 October 2026, sesi berikutnya — tetap HOLD)

Semua bukti di bawah diambil di perangkat Windows `home` dari checkout P2 sendiri; tidak ada push, merge, release, deploy, perubahan produksi VPS atau Chrome Web Store.

| Gate | Bukti terbaru | Status |
| --- | --- | --- |
| Audit working tree | 7 tracked modified + 2 untracked P2 saat mulai; AGENTS.md global/repository dan cara kerja bersama dibaca | PASS inventaris; diff owner tidak di-reset |
| Context GGUF 4K | Agent browser untuk provider `local-botconnector` sekarang membatasi output per turn 192 token, riwayat estimasi 1.700 token dan tool result 1.400 karakter. `scripts/test-local-browser-budget.mjs` dengan **HTTP model fixture** memverifikasi tool browser tetap tersedia, stale history trimmed dan Cloud inference 0 | **PASS contract only, native GGUF 4K end-to-end BELUM PASS** |
| TypeScript/build/full regression | `npm run typecheck`, `npm run build`, `npm test` (exit 0, 158,55 s) dan regresi context/local-core/UI lulus di Windows | PASS lokal |
| Chrome nyata | Chrome for Testing **154.0.8037.57**: extension MV3/pairing/DOM/satu klik manual di fixture lokal lulus. Percobaan agent Ollama di port 11434 gagal `fetch failed`: port itu terikat ke alamat Tailscale, bukan loopback. Port 11666 memang merespons HTTP 200 | PASS browser direct only; **agent run terbaru belum PASS** |
| Pengamanan RAM | Model `botconnector-fast:latest` dimuat melalui Ollama QA 11666, RAM bebas sempat ~0,82 GB. Uji agent langsung dihentikan; model QA di-unload dengan `keep_alive:0`; Ollama server tidak dihentikan dan RAM bebas pulih ~5,8 GB | STOP aman, **NO-GO native agent** |
| Visual desktop / 390px | `test/test-local-ui-responsive-windows.mjs` di Chrome nyata: lebar 1365 & 390, halaman tidak overflow horizontal, Settings > Models > AI Lokal terlihat; screenshot di folder QA sementara | PASS untuk responsive layout, bukan pixel parity Claude |
| llama.cpp / Spark | `llama-server --version`: build **10930**, commit `56381e407`; file Spark-X2.5 Q4_K_M GGUF ada. Tidak update atau mengganti runtime; error `spark2_5` dari handoff masih blocker kompatibilitas | UNRESOLVED; wajib verifikasi kompatibilitas dari build resmi sebelum perubahan |
| Claude in Chrome parity | Catatan original 1.0.100 read-only sudah ada di `docs/browser-claude-headtohead-20261015.md`; tidak memakai jatah Claude untuk uji tambahan | **BELUM TERVERIFIKASI** untuk full agent actions, permissions/stop dan pixel parity |
| Chrome 153 vs 156 | Pengujian baru baru tersedia pada Chrome 154; kasus URL kosong Chrome 156 belum terbuktikan teratasi | OPEN; native Chrome site permission tidak diubah |

**Arsitektur tetap:** BotConnector Local Core asli pada satu paket portable, manager asli, Chrome native host permission tunggal. Patch context hanya mengurangi penggunaan token untuk **browser session yang memilih provider lokal**; tidak mengubah format tool, konfigurasi Cloud, izin situs maupun runtime asli. Ini adalah mitigasi terarah; belum ada klaim bahwa setiap model GGUF 4K dan setiap situs pasti selesai. Uji asli dan memori aman tetap menjadi gerbang release.

### Tambahan: bundle bersih, reconnect dan pemeriksaan arsitektur

- Existing 62.053.180-byte ZIP successfully **extracted again** to `%TEMP%\\switchboard-p2-fresh-user-qa-20261015\\Switchboard-0.4.1`; pinned original Core, `dist/web/index.html`, Node binary and three launcher CMD files present. `botconnector --help` from embedded Node PASS. This is the **previously built ZIP**, not a rebuild including the new context patch.
- `test/test-portable-fresh-windows.mjs` against extracted ZIP and independent temporary `APPDATA` / `USERPROFILE`: original `runtime status --json` PASS, original `serve` manager started/stopped twice at isolated localhost port, both returned actual HTML (20.495 bytes). No model download, no resident QA web server, no writes to user's original profile. **PASS clean-profile smoke/reconnect**, NOT a real new Windows account or new GGUF download/install/start.
- First attempt of this smoke incorrectly asserted the original store **must** eagerly create a settings folder; actual original Core may defer directory creation. Removed the incorrect assumption and reran: PASS. Preserve original manager behavior, do not custom-build or force-create another store.
- Read-only GGUF metadata scan: Spark model header magic `GGUF` and `general.architecture=spark2_5` at offset 32. Installed llama.dll b10930 contains literal `spark2_5`, which suggests the installed binary may have some recognition. **This is not proof that the model loads**; earlier incompatibility report remains open until a resource-safe real load test. No runtime update or model download was done.
- New automated `test:local-browser-budget` is included in the general `npm test` chain for future CI; Windows visual and portable smoke are opt-in scripts with explicit paths. CI against **uncommitted P2** has not run, because push requires separate owner approval.

**Release blockers unchanged:** full direct GGUF browser task on safe RAM, user-requested optional installation of model in genuine new-user Windows environment, Chrome153/156 repeat testing, full original Claude browser parity, updated ZIP from final source, and actual CI on the eventual pushed candidate.

### Tambahan hardening keamanan dan Chrome versi lain

- Audit resolver menemukan potensi **Cloud fallback tidak sengaja** saat sesi eksplisit masih meminta `local-botconnector` tetapi provider telah dihapus atau diubah endpoint-nya; sebelumnya resolver `profileFor` bisa kembali ke `legacy` Cloud. Diperbaiki di `src/services/llm.ts` agar local meminta profil yang masih ada, protokol `openai-chat`, dan endpoint loopback tepat; jika tidak, error eksplisit. Redirect HTTP pada request local juga ditolak tanpa mengikuti `Location`.
- Contract test via server HTTP nyata (tanpa model/provider berbayar) memverifikasi: local healthy -> response, local disconnect -> request gagal, provider local dialihkan ke URL lain -> gagal, local endpoint mengirim HTTP 307 menuju Cloud -> gagal; **Cloud POST 0 dalam keempat kasus**. `LOCAL_PROVIDER_DISCONNECT_AND_HIJACK_FAIL_CLOSED_PASS` dan `LOCAL_REDIRECT_FAIL_CLOSED_PASS`; ini pengujian guard, bukan uji native GGUF.
- Chrome for Testing 154 browser-only test di profil throwaway **PASS** MV3 worker/pairing/DOM/mutasi tombol. Chrome reguler 155.0.8059.79 dengan `--load-extension` dan profil QA throwaway **gagal menemukan MV3 service worker**; akar masalah flags/instalasi extension versi Stable belum ditentukan. Jangan menyatakan Chrome155 produk rusak atau mengubah izin Chrome untuk mengatasinya. Chrome153/156 tetap **BELUM TERVERIFIKASI** dalam run baru.
- Screenshot nyata desktop 1365px dan 390px telah ditinjau: panel Model Lokal berada dalam lebar modal, tidak overflow horizontal. Ini bukti layout, bukan bukti head-to-head pixel parity Claude.

### Hasil akhir pengujian lokal dan recovery (15 Oktober)

- `npm run typecheck` PASS, `npm run build` PASS, `npm test` **PASS exit 0** setelah patch fail-closed dan penambahan contract test (waktu 163,47 detik); `git diff --check` PASS. Ini **bukan** GitHub Actions CI dari source P2 uncommitted.
- Pada akhir QA, model Ollama yang dimuat untuk pengujian dibebaskan melalui API lokal dengan `keep_alive:0`; server Ollama milik pengguna tidak dihentikan. Proses llama-server QA tidak ditinggalkan. Browser QA menggunakan profil sementara. Production VPS dan Chrome Web Store tidak disentuh.
- Snapshot WIP yang bisa ditinjau/pulihkan tanpa menghapus riwayat: `C:\\Users\\farij\\AppData\\Local\\Temp\\switchboard-p2-worktree-snapshot-20261015` berisi `tracked-worktree.patch`, lima file baru (untracked) dan `status.txt`. **Jangan** menjalankan `git reset --hard` atau otomatis me-reverse patch tanpa mengecek perubahan milik owner; snapshot berisi pula P2 yang sudah ada sebelum sesi ini.
- Working tree tetap uncommitted. **NO-GO / P2 HOLD.** Native GGUF 4K full browser agent, optional fresh Windows account model installation, Chrome153/156 native permission parity, pixel/full workflow head-to-head Claude, rebuild QA ZIP with current context patch, dan GitHub CI masih OPEN. Push/merge/release/deploy memerlukan persetujuan terpisah.
