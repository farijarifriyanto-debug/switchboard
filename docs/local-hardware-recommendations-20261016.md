# Switchboard — rekomendasi AI lokal berdasarkan hardware (kandidat)
Tanggal: 16 Oktober 2026, laptop home. **KANDIDAT, BELUM DIAPLIKASIKAN KE SBX GLOBAL/NPM ATAU DI-RESTART.**

## Tujuan
Menambahkan tombol **Cek model yang cocok untuk laptop ini** dalam panel yang sudah ada: Settings > Models > AI Lokal, tanpa pengelola model kedua, unduhan otomatis, atau fallback AI Cloud.

## Komponen asli yang dipakai ulang
- Vendor asli dari GitHub BotConnector Local Core yang sudah dipin di repository Switchboard.
- `runtime/hardware.cjs: detectHardware()`: CPU, thread, RAM total/bebas, NVIDIA jika terdeteksi.
- `runtime/recommend.cjs: assess()`: kecocokan model dengan hardware Core.
- `tui/first-run.cjs: catalog(), recommend()` + `registry/models.json`: sumber model kurasi Core (bukan hasil pencarian acak Hugging Face).
- Switchboard hanya menambahkan **presentasi per use-case** dan label estimasi RAM/CPU; tidak mengakses file model pribadi atau menjalankan proses inference untuk mengukur kinerja.

## Hasil pada perangkat
Hardware: ASUS Zenbook 14 UM3406KA, AMD Ryzen AI 7 350, Radeon 860M iGPU, RAM fisik 31,1 GB, 16 logical cores. Free RAM berubah sesuai aktivitas; klik tombol membaca kondisi terbaru.
1. Chat ringan: Llama 3.2 3B Instruct Q4_K_M (starter asli dari Core, ~2 GB unduh).
2. Browser/tool: Qwen3 4B Q4_K_M (~2,7 GB). Tool calling pernah terbukti pada **Ollama lokal Qwen3 4B**, bukan GGUF Core.
3. Coding: Qwen2.5 Coder 7B Q4_K_M (~4,7 GB; perlu validasi latensi CPU).
4. Vision: Gemma 3 4B IT Q4_K_M (~2,8 GB; memerlukan projector/runtime yang kompatibel, **belum dibuktikan**).
Perkiraan RAM ialah bobot GGUF * 1,35 + 0,8 GB, dengan cadangan OS 2 GB dari free memory. Beban CPU mengacu jumlah thread dan ukuran bobot; **bukan benchmark**. AMD iGPU tidak dikira VRAM NVIDIA terdedikasi. Jika model memerlukan RAM melebihi yang bebas saat itu, tombol hanya memperingatkan **kosongkan RAM terlebih dahulu**, tidak mengeksekusi perubahan sistem.

## Pengamanan
- Endpoint **GET /api/settings/local-core/recommendations** berada di router Settings WebApp yang sudah memiliki pengaman localhost/host/CSRF dan tidak mengambil input URL arbitrer.
- Halaman memakai sanitasi `esc()` untuk seluruh teks perangkat/model (XSS guard).
- Unduh, instalasi GGUF, memilih backend, dan memulai runtime tetap melalui `sbx local` (Original BotConnector Core) dengan persetujuan pengguna. Model aktif hanya diubah setelah tombol `Gunakan model lokal` yang lama diklik terhadap runtime aktif.
- Tidak ada network lookup atau billing Cloud untuk menghasilkan empat pilihan Core. Pengambilan Hugging Face diperlukan hanya bila pengguna kemudian membuka pengelola dan meminta pencarian/unduhan.

## Tes yang telah dijalankan
- `npm run typecheck`, `npm run build`, `git diff --check`: PASS.
- `npm test`: PASS 2026-10-16, exit 0, ~137 detik, termasuk keamanan browser, Core, dan tarball npm.
- `node test/test-local-hardware-recommendations.mjs`: PASS untuk 8 GB/minimal free RAM, 32 GB CPU, 4 vs 16 logical threads, NVIDIA, cloud-exclusion.
- Chrome nyata Chrome for Testing 154 dan server QA terisolasi, tombol Settings > Models ditekan, 4 pilihan muncul serta identitas laptop dan status memori benar. Desktop 1365px dan mobile 390px: no horizontal overflow, PASS. Gambar tersimpan di %TEMP%/sbx-local-ui-resp-8RQwLn/evidence.
- Model GGUF 4 kelas **tidak otomatis diunduh atau di-benchmark**; kemampuan GGUF untuk browser/vision harus diuji setelah pengguna memilih dan menginstalnya.

## Acuan & perbandingan
BotConnector Local Core adalah sumber rekomendasi hardware; UI Switchboard mempertahankan panel Settings > Models. Ini tambahan opsional pengelolaan AI lokal, bukan perubahan alur browsing Claude in Chrome.

| Fitur | Acuan | Switchboard | Bukti | Status |
|---|---|---|---|---|
| Kurasi cocok perangkat | Core detectHardware + assess + first-run recommend | Memakai modul Core asli | Source vendored + unit test | MATCH / ADAPTASI |
| Unduh dengan izin | Core eksplisit | Tak ada download di tombol saran | Pengecekan endpoint / test | MATCH |
| Browser UI | Panel Settings > Models yang ada | Tombol rekomendasi dalam section AI Lokal | Chrome desktop/mobile QA | ADAPTASI |
| Browser agent Claude | Tindakan browser/izin native terpisah | Tidak diubah dalam kandidat | Source diff | UNCHANGED, parity menyeluruh belum diuji |
| Kualitas/performa semua model | Runtime inference nyata | Belum dibenchmark GGUF baru | N/A | BELUM TERVERIFIKASI |

## Aktivasi
Kandidat berada pada checkout `C:\Users\farij\switchboard-local-core-p2-qa-20261015`. Jangan menimpa paket npm v0.4.2 atau mengubah proses Switchboard yang digunakan pengguna **sebelum izin eksplisit owner untuk instalasi/restart**. Perubahan lain (banner UI, browser Auto, tes vision) sudah WIP dalam checkout: jangan di-reset, jangan tanpa sengaja dimasukkan ke commit fitur ini. Pembuatan versi npm, PR, push, merge, dan Chrome Web Store juga perlu persetujuan tersendiri.
