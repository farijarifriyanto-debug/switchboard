# Switchboard Browser Companion — Pengujian Web UI, Chrome, dan Edge

**Tanggal:** 10 Oktober 2026 WIB
**Branch:** `feat/chrome-browser-companion`
**Lingkungan:** laptop Windows `home`, profil Chrome dan Edge terisolasi, backend Switchboard lokal, provider BotConnector sungguhan.
**Kesimpulan:** Semua jalur E2E yang dirinci di bawah **PASS**. Publikasi ekstensi dan pengujian umum sebelum produksi masih belum dilakukan.

## Matriks hasil pengujian

| Jalur | Browser pengguna | Browser tool | AI | Hasil |
|---|---|---|---|---|
| Prompt Switchboard CLI → tool → jawaban | CLI lokal | Chrome MV3 Companion | Agnes 3.0 Flash | PASS — sudah diverifikasi dua kali pada laporan sebelumnya |
| Web UI API SSE → tool → jawaban | HTTP API lokal | Chrome MV3 Companion (panel tutup) | Agnes 3.0 Flash | PASS — `Clicks: 0` → `Clicks: 1` |
| Prompt dari **tampilan Web UI** | **Microsoft Edge** | Chrome MV3 Companion (panel tutup) | Agnes 3.0 Flash | PASS — status `Completed` dan hasil DOM cocok |
| Agent runtime → Edge Companion | Agent lokal | **Microsoft Edge** MV3 Companion (panel tutup) | Agnes 3.0 Flash | PASS — kode pairing, persetujuan origin, klik, snapshot, jawaban |
| **`sbx web` standar setelah perbaikan** | Microsoft Edge | Chrome MV3 Companion (panel tutup) | Agnes 3.0 Flash | PASS — tombol Allow once ditekan di UI, kemudian model menyelesaikan tugas |

## Temuan dan perbaikan penting

**Sebelum perbaikan**, perintah `sbx web` menampilkan 13 browser tools, tetapi port bridge `7778` **tidak** mendengarkan. Pengguna harus menulis konfigurasi bridge sendiri.

**Perbaikan di branch ini:** `sbx web` kini membuat bridge lokal dengan token pairing persisten yang sama seperti `sbx chat` dan menampilkan kode pairing 8 karakter sekali pakai. Pengguna tidak perlu lagi mengatur bridge manual.

**Regression guard:** `scripts/test-web-companion-startup.mjs` menjalankan CLI `sbx web` sungguhan dengan HOME uji, port HTTP acak, pemeriksaan listener Web UI dan bridge, kode pairing satu kali, dan penolakan replay. Tidak menggunakan model tiruan untuk E2E browser; tes startup hanya memverifikasi transport.

**Approval:** Dalam mode `risky` bawaan, aksi `browser_click` menunggu persetujuan Web UI. Pada tes `sbx web` standar, saya mengklik **Allow once** dari UI; model lalu melanjutkan dan memberi jawaban tepat. Durasi total sekitar 100 detik termasuk waktu menunggu persetujuan manual — **bukan** latensi model murni. Default approval tetap aktif.

## Bukti independen

- [Web UI Edge → Chrome (screenshot)](./cross-webui-edge-final.png)
- [Web UI Edge → Chrome (data pengujian)](./cross-webui-edge-e2e.json)
- [Web UI SSE langsung → Chrome (data pengujian)](./cross-webui-api-e2e.json)
- [Microsoft Edge sebagai Browser Companion (screenshot)](./cross-edge-companion-final.png)
- [Microsoft Edge sebagai Browser Companion (data pengujian)](./cross-edge-companion-e2e.json)
- [`sbx web` standar + persetujuan (screenshot)](./cross-default-webui-final.png)
- [`sbx web` standar + persetujuan (data pengujian)](./cross-default-webui-e2e.json)

Data pengujian disimpan tanpa API key, token bridge, atau kode pairing. Screenshots diambil dari browser sungguhan, bukan mockup. Perubahan DOM diperiksa secara independen melalui CDP setelah agent menyelesaikan tool calls; CDP tidak dipakai agent untuk melakukan klik.

## Full regression suite

**Pada commit kode `976dd55` setelah patch startup**, pipeline `npm run typecheck && npm run build && npm test`, dilanjutkan `npm run package:extension` dan validasi `unzip -t` untuk kedua paket, **PASS** dengan exit code 0. Durasi keseluruhan sekitar **216,1 detik** pada VPS. Tes meliputi approval, keamanan, Web UI, MCP, sesi, CLI, 13 browser tools, reconnect WebSocket, dan tes baru `sbx web` dengan pairing sekali pakai. Paket Chrome dan Edge masing-masing 22.107 byte, SHA-256 sama (`108cb393a1e377554b00755902f3432831acbdda58e24ee96ef25680a15038a9`).

## Belum termasuk

- Pengujian Microsoft Edge di macOS/Linux serta Firefox.
- Pemasangan dari Chrome Web Store / Microsoft Edge Add-ons dan review marketplace.
- Pengujian beban multi-user berkepanjangan, browser suspend lama, dan VPS→laptop lintas jaringan.
- Validasi screenshot tanpa user gesture: Chrome membutuhkan `activeTab` yang diberikan pengguna.
- **P1 transparansi approval:** modal Web UI saat ini menamai aksi browser dengan teks generik seperti `Tool · Working with project`, bukan memperlihatkan nama `browser_click` dan selector `#increment` secara jelas. Permintaan persetujuan tetap bekerja dan menahan aksi, tetapi keterbacaan tindakan harus diperbaiki sebelum publikasi luas.
- Deploy production atau merge ke `master` (tidak dilakukan).

**Release gate:** jalur E2E pada profil test Windows PASS; publikasi umum masih perlu uji tambahan dan persetujuan rilis.
