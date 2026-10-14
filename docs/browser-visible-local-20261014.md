# Pengujian Chrome nyata dengan AI lokal — Windows

**Tujuan:** pengujian berulang alur AI → Switchboard → Browser Companion → Chrome → verifikasi DOM. Skrip `test/test-browser-visible-local.mjs` memakai profil Chrome sementara, tab HTTP lokal, model Ollama lokal, dan menghapus profil setelah selesai.

## Menjalankan (tanpa VPS dan API berbayar)

Persyaratan: Node.js >=20, dependensi repo terpasang (`npm ci` dan `npm run build`), Chrome for Testing yang mendukung `--load-extension`, Ollama lokal berisi model yang mendukung tools (di laptop QA: `botconnector-fast:latest`).

Buka PowerShell dalam direktori repo:

```powershell
$env:OLLAMA_HOST='127.0.0.1:11666'
ollama serve
```

Di PowerShell lain:

```powershell
$env:SBX_TEST_CHROME_PATH='C:\path\to\chrome-for-testing\chrome.exe'
$env:SBX_LOCAL_BASE_URL='http://127.0.0.1:11666/v1'
$env:SBX_LOCAL_MODEL='botconnector-fast:latest'
node test/test-browser-visible-local.mjs
```

Jangan memakai Chrome reguler yang menonaktifkan flag pemuatan ekstensi. Browser dipasang hanya di profil sementara. Tidak memakai profil browser pribadi atau kredensial BotConnector.

## Yang benar-benar dibuktikan (14 Oktober 2026)

- PASS: unit test GitHub watch 5/5, typecheck/build, dan CI GitHub.
- PASS: Chrome for Testing UI nyata, backend lokal, extension service worker asli, pairing sekali pakai dan WebSocket.
- PASS: tool browser membaca DOM, klik mengubah status, snapshot membaca hasil.
- PASS: model Ollama lokal (Qwen3 / `botconnector-fast`) memutuskan `browser_click`, lalu `browser_dom_snapshot`, melaporkan `Clicks: 2` yang terverifikasi di halaman; test rerun 11,83 detik saat model sudah termuat.
- PASS: test kontrak izin native Chrome, CDP, fail-closed, dan bridge (ini kontrak mock, **bukan** bukti Chrome E2E penuh).
- **BELUM TERVERIFIKASI:** mode Auto dengan safety evaluator lokal tidak menyelesaikan pengujian Chrome; proses QA dihentikan pada sekitar 130 detik. Jangan klaim Auto PASS, jangan menghapus safety gating untuk mengatasi tes.
- **BELUM TERVERIFIKASI:** side panel yang benar-benar dipakai manusia, recovery, tabGroups, sesi panjang, dan kesetaraan UI Claude in Chrome.

**Keamanan tes:** hanya target `127.0.0.1`, model lokal, `tools.shell.disabled=true`, approval `risky`, mode aksi browser Skip yang memang ada di produk. Tes Skip bukan tes keamanan mode Auto. Untuk penggunaan nyata, ikuti satu izin native Chrome dan verifikasi Auto secara terpisah.

## Komparasi proyek GitHub relevan

| Upstream | Fakta dari README / lisensi | Switchboard sudah punya | Gap yang harus diuji, bukan dibuat ulang |
| --- | --- | --- | --- |
| [Magpie](https://github.com/yetone/magpie) (MIT) | Gateway multi-model lintas agent, grup routing dan pindah provider | Adapter OpenAI Chat/Responses/Anthropic, provider registry dan fallback, test PASS | Kemudahan konfigurasi tiap agent, parity tool/stream serta fallback real dengan 429 |
| [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT) | Indexed DOM targets + satu permintaan pemilihan aksi, benchmark sempit 7,1 detik | Browser Companion CDP, DOM snapshot, aksi, tab dan native permission | Benchmark terukur di tugas yang sama; jangan adopsi izin/UX custom di luar Claude in Chrome |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) (MIT) | Skills, memory, jadwal, subagent | Unit test skills, memory, schedule, subagent PASS | Perbandingan pengalaman pengguna, bukan membuat sistem memory/skills kedua |
| [Strata](https://github.com/Niko1221/Strata) (MIT) | Inference local Qwen pada GPU konsumen | Ollama sudah berfungsi untuk browser agent | Evaluasi hanya bila hardware tersedia; jangan unduh model besar otomatis |
| [PdfCraft](https://github.com/storytold/pdfcraft), [PhotoCraft](https://github.com/storytold/photocraft) (Apache-2.0) | Editor PDF/foto native; brand/aset dapat memiliki syarat sendiri | Produk OlahDokumen dan Image Studio terpisah | Audit fitur/lisensi khusus produk, tidak otomatis dimasukkan ke Switchboard |
| [Cherry Studio](https://github.com/CherryHQ/cherry-studio) (AGPL-3.0) | Multi-model UI dan agents | Switchboard punya konsol chat dan plugin | Referensi UX; tinjau kewajiban AGPL sebelum memakai kode |

**Aturan AGENTS.md:** Claude in Chrome adalah acuan UX ekstensi browser. Jangan menambah gate izin situs kedua, menyalin branding upstream, atau merilis perubahan fitur sebelum tes Chrome nyata dan matriks parity lengkap. Skrip ini **tidak** merilis ekstensi dan tidak mengubah production.
