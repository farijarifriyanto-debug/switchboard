# AGENTS.md — SWITCHBOARD (ATURAN WAJIB SEMUA AGEN)

## Produk acuan otoritatif: Claude in Chrome

**Keputusan owner 2026-10-11: jangan mendesain custom untuk fitur browser yang sudah matang di Claude in Chrome.** Referensi utamanya **pengalaman pengguna Claude in Chrome (modern side panel)** melalui dokumentasi resmi Anthropic dan pengujian aplikasi asli jika tersedia. Dokumentasi pembanding repo: `docs/claude-in-chrome-reference-20261011.md` dan syarat penerimaan `docs/browser-parity-gate-20261011.md`. Kedua dokumen adalah catatan pemeriksaan yang harus diperbarui dengan bukti, **bukan pengganti referensi asli**.

### Prosedur sebelum coding (wajib)

1. Identifikasi fitur tepatnya dari permintaan owner. Baca dokumentasi resmi/observasi **Claude in Chrome** mengenai UI/UX, izin, tab, tools, tugas agent, kegagalan, dan recovery. Cantumkan sumber dan batasan fitur/versi; jangan menebak internals atau menyalin kode/branding proprietary.
2. Bandingkan source Switchboard, implementasi yang sedang live, laporan tes aktual, dan diff/branch. **Implementasikan setara acuan, bukan kreativitas agent.** Hindari extra menu, dashboard, persetujuan ganda, mekanisme state/route berlapis, dan friksi yang tidak ada pada acuan.
3. **Hanya boleh custom untuk fungsi yang memang tidak ada pada Claude in Chrome.** Verifikasi ketidakadaannya, buat tambahan terisolasi tanpa memodifikasi alur asli. Perubahan yang berbeda untuk fungsi yang sudah ada harus mendapat persetujuan eksplisit owner terlebih dahulu.

### Setelah setiap pekerjaan (wajib, jangan menunggu akhir sesi)

Lakukan tes end-to-end di Chrome **nyata** (jika owner meminta Chrome laptop, jangan menggantinya dengan headless), dengan model AI **sungguhan** untuk klaim agent E2E. Lalu **bandingkan dengan fitur dan alur Claude in Chrome yang asli**: `Fitur | Perilaku referensi | Perilaku Switchboard | Evidence | MATCH / ADAPTASI SETARA / DIFF / BELUM TERVERIFIKASI | Tindakan`. Jika ada **DIFF tak disetujui, coret pendekatan custom, perbaiki dan uji ulang SEKARANG** sebelum fitur lain, merge, atau rilis. Jangan sebut PASS jika hanya mock, status HTTP 200, tool terpanggil, atau UI tampak benar tanpa hasil nyata.

### Aturan izin Switchboard (keputusan owner)

- **SATU izin akses situs:** permission host native Chrome/Edge; status `approvedOrigins` historis **bukan** gate kedua. Jika izin Chrome telah diberikan, browser boleh membaca situs tanpa meminta persetujuan situs Switchboard lagi.
- **Manual dan Auto mengatur persetujuan TINDAKAN AGENT**, bukan persetujuan situs ulang. Tindakan sensitif/berisiko masih memakai pengaman yang sah, tanpa menambah konfirmasi yang tidak diperlukan atau mengizinkan bypass keamanan.
- Panel harus terbuka tanpa menunggu perizinan yang hanya bisa dilakukan di panel. Deny/revoke wajib fail-closed. Alur dasar tetap chat-first tanpa menu teknis berlebihan.

### Release gate

**NO-GO** bila masih ada DIFF referensi yang tidak disetujui, bukti E2E AI/provider nyata belum ada, atau keamanan gagal. Lulus unit test/CI saja bukan selesai. Dokumentasikan bukti, sumber acuan, skenario uji, keterbatasan, dan hasil perbandingan setelah SETIAP patch. Saat ini v0.4.2 sudah publik dan draft PR #22 adalah pekerjaan pengembangan: **jangan merge atau kirim update Web Store hanya karena patch selesai**; ikuti izin owner, verifikasi semua blocker, dan kebijakan rilis aktual.

Aturan global di `C:\Users\farij\AGENTS.md` berlaku juga. **Ringkasan:** pelajari original -> implementasi sama -> uji nyata -> bandingkan -> coret DIFF -> ulang sampai MATCH, bukan custom.
