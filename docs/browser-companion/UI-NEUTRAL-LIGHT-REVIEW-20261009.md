# Browser Companion — Neutral Light UI Review (2026-10-09)

## Keputusan desain
- Satu tema terang yang netral; **tidak ada dark mode, gradient, glow, banner promosi, atau ilustrasi AI**.
- Fokus produk pada pairing Switchboard CLI, izin situs, inspeksi browser, workflow dan audit. Prompt tetap di Switchboard CLI/Web UI.
- Teks status tidak diulang dalam beberapa panel. Kontrol utama langsung terlihat dalam viewport side panel.

## Bukti Chrome Windows asli
- Perangkat: `home` Windows; Chrome for Testing v154, extension Switchboard Browser Companion yang terpasang pada profil uji terisolasi.
- Branch: `feat/chrome-browser-companion`, commit UI terakhir `bbdd4c2`.
- Profil uji: `C:\Users\farij\switchboard-browser-proof\chrome-testing-profile`. Profil Chrome reguler tidak disentuh.
- Status koneksi: Connected ke Switchboard lokal `127.0.0.1:7778`, origin uji `127.0.0.1:8999` Approved.
- Warna permukaan diperiksa di runtime Chrome: `rgb(248,249,251)`, CSS `color-scheme:light`.
- Tidak ada komponen hero marketing, toggle tema gelap, atau chat AI kedua dalam extension.

## UI smoke test nyata
- Viewport 320, 360, 390, 768, dan 1100 piksel: **PASS**, tidak ada overflow horizontal halaman.
- Tab Overview, Inspector, Permissions dan Connection: **PASS**.
- Revoke origin kemudian Allow lagi: **PASS**, label dan izin berubah sesuai storage.
- Audit activity aman terhadap konten mirip HTML/script: **PASS**.
- Browser security, companion bridge, dan regression tests: **PASS**.
- Workflow automated test: **PASS di VPS**. Test yang sama pada laptop sebelumnya gagal dijalankan karena port lokal `7792` telah dipakai oleh `node scripts/e2e-stub.mjs 7792`; proses tersebut tidak dihentikan.

## Screenshot asli
- [Desktop 1100 px](./ui-neutral-final-desktop.png)
- [Browser companion side panel 390 px](./ui-neutral-final-sidepanel.png)
- [Browser companion compact 320 px](./ui-neutral-final-compact.png)

## Batasan rilis
Listener command-stream extension masih hidup selama panel terbuka; pekerjaan untuk koneksi background MV3, onboarding pairing sederhana, dan verifikasi final E2E setelah perbaikan provider tetap dibutuhkan. **Ini rilis branch pengembangan, bukan deploy production atau publikasi Web Store.**
