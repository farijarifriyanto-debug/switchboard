# Acuan resmi Claude in Chrome untuk Switchboard

**Tanggal kajian:** 11 Oktober 2026
**Status implementasi:** Riset/kontrak penerimaan, **BUKAN** persetujuan rilis.
**Keputusan:** Ikuti pola perilaku Claude in Chrome modern (Cowork side panel), jangan membuat ulang UI atau fitur custom tanpa kebutuhan yang teruji. Jangan menganggap fitur proprietary Anthropic tersedia bagi Switchboard.

## Sumber primer

- https://support.claude.com/id/articles/12012173-mulai-dengan-claude-di-chrome
- https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide
- https://support.claude.com/en/articles/12902428-use-claude-in-chrome-safely
- https://support.claude.com/id/articles/12902405-pemecahan-masalah-claude-di-chrome
- https://academy.claude.com/tutorials/simplify-your-browsing-experience-with-claude-for-chrome
- https://developer.chrome.com/docs/extensions/reference/api/debugger
- https://developer.chrome.com/docs/extensions/reference/api/tabs
- https://developer.chrome.com/docs/extensions/reference/api/permissions
- https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings

## Fitur resmi yang menjadi standar

**Panel modern:** Chat sebagai permukaan utama, konteks tab aktif, aktivitas tool, hasil tugas, tombol Stop, dan permintaan izin di dalam alur. Cowork side panel menyimpan sesi dan dapat melanjutkan dari aplikasi lain pada produk Anthropic. Jangan menyalin fitur sinkronisasi cloud jika Switchboard belum memiliki infrastrukturnya. Workflow recorder tersedia di *classic side panel* saja; jangan menjadikan pengalaman klasik sebagai acuan UI utama.

**Kontrol browser:** Anthropic mendokumentasikan izin `sidePanel`, `scripting`, `debugger`, `tabs`, `tabGroups`, `alarms`, `notifications`, serta kemampuan visual, interaksi DOM, console, network, tangkapan layar, navigasi, grup tab, dan background task. `chrome.debugger` memakai Chrome DevTools Protocol (CDP), tetapi meminta izin berkekuatan tinggi yang memiliki peringatan keamanan. Jangan menambahnya otomatis sebelum review izin, keamanan dan review Chrome Web Store.

**Izin:** Pengalaman modern memiliki Manual (setujui tiap tindakan) dan Auto (tindakan rendah risiko berjalan setelah pemeriksaan aksi otomatis, berhenti bila berisiko). Anthropic juga menawarkan Skip, tetapi itu **bukan syarat Switchboard** dan tidak perlu ditiru karena menghilangkan safety checks. Situs dengan risiko tertentu meminta persetujuan setiap aksi; pilihan mencakup Allow this action, Always allow on this site, Decline. Pengunduhan, pemberian otorisasi, dan penanganan data sensitif memerlukan konfirmasi khusus; beberapa kategori aksi selalu dilarang.

**Keamanan:** Konten web selalu tidak terpercaya. Anthropic menerapkan pemeriksaan prompt injection pada konten maupun aksi, pembatasan situs berisiko tinggi, serta konfirmasi aksi penting. Switchboard tidak boleh sekadar mengganti label `auto_safe` menjadi Auto tanpa memiliki penyaring risiko yang benar-benar diuji.

**Produktivitas:** Multitab dalam grup khusus agent (tab kelompok agent berbeda dari tab pribadi), tugas tetap berjalan saat pengguna beralih tab, notifikasi, shortcut dengan pemicu `/`, jadwal, observasi console/network, dan navigasi situs populer. Integrasi khusus seperti 1Password atau Claude Desktop **tidak** perlu dibuat bila tidak ada keperluan dan konektor aman yang nyata.

## Gap source Switchboard v0.4.2 yang telah diverifikasi

| Sistem | Pada source 0.4.2 | Acuan resmi Claude | Keputusan |
| --- | --- | --- | --- |
| Izin Chrome | `activeTab`, `scripting`, `tabs`, `sidePanel`, `storage`, `alarms`; akses origin eksternal diminta per situs | `debugger`/CDP, `tabGroups`, `notifications`, dll. | Evaluasi CDP sebagai mesin browser, bukan menambal banyak script injection terpisah. Audit permission warning dan keamanan terlebih dahulu. |
| Visual/screenshot | Screenshot via `captureVisibleTab` memerlukan gesture `activeTab`; belum lulus vision end-to-end | Screenshot/visual intelligence merupakan kemampuan inti | Jadikan screenshot/vision P0 dengan alur izin yang nyata dan eksplisit. |
| Chat | `Ask Switchboard` berada di tab Overview di samping Inspector/Workflows/Permissions/Connection | Chat-first side panel, izin dan aktivitas inline | Jadikan chat default; rincian teknis masuk Settings/overflow, bukan menu utama. |
| Izin perilaku | `ask_every_time`, `auto_safe`, `restricted` + native per-origin | Manual, Auto diperiksa tiap aksi, opsi izin sekali/selalu/tolak | Pertahankan gate keamanan; jangan klaim Auto setara tanpa action risk checker teruji. |
| Tab | List/select tab tersedia | Task-owned tabGroups dan konteks berkelanjutan | Uji group ownership, tab identity, perpindahan dan konteks task. |
| Aksi | DOM/click/type/select/scroll tersedia; PR #22 menangani kesuksesan palsu dan rich-text | Interaksi browser akurat termasuk situs kompleks | Buktikan melalui real DOM dan efek yang benar, bukan tool called / `ok` saja. |
| Workflow | Mekanisme replay, retry, schedule sudah ada | Shortcuts dan schedule; recording pada klasik | Reuse backend, sederhanakan entry point saja. |
| Model | Switchboard memerlukan AI dari backend tersambung; tes saat ini terkendala HTTP 401 | Panel menggunakan model Claude yang dikonfigurasi pada ekosistemnya | Perbaiki model authentication dan real AI test, jangan simpan API key cloud di extension. |

## Desain target (minimal, tanpa banyak custom)

Satu panel utama: **Header (Switchboard + status koneksi + tab/grup aktif)** → **percakapan, tool progress dan bukti** → **input tugas + model yang dipakai + mode izin + Stop**. Izin baru muncul sebagai kartu konteks hanya saat dibutuhkan, dengan izin sekali / selalu / tolak. Pengaturan situs, daftar izin, rekaman workflow, dan diagnostik tersedia melalui Settings/overflow. Jangan buat dashboard KPI atau menu teknis yang menutupi pekerjaan utama.

Untuk Auto mode, setiap aksi harus melalui policy pre-execution dan pemeriksaan konten web. Jangan mengandalkan label atau pemeriksaan keyword sebagai pengganti keamanan. Untuk tindakan irreversible/sensitif, selalu minta persetujuan jelas. Setiap blokir harus dilaporkan sebagai error atau approval-needed, bukan PASS.

## Urutan perbaikan dan test wajib sebelum rilis berikutnya

1. **P0 browser engine**: rancang pilihan `chrome.debugger` CDP vs fallback DOM injection tanpa bypass izin; uji klik/form/screenshot, tab ID, frame, situs JS berat, dan properti target. Pastikan warning permission Chrome diterima secara sadar.
2. **P0 nyata**: side panel → model AI sungguhan → minimal 5 aksi → halaman website yang benar → verifikasi konten hasil, dengan izin situs yang disetujui pengguna. Saat ini AI provider 401 belum terselesaikan. Tidak boleh menggunakan provider mock untuk menandai end-to-end lulus.
3. **P0 keamanan**: prompt injection page text, false positive success, deny/revoke/timeout, password/card, download/otorisasi, Stop/cancel, penyalahgunaan tab. Uji tindakan diblokir tidak mutasi halaman dan tanpa klaim sukses.
4. **P1 sesi**: grup tab tugas, tidak bertindak pada tab pribadi/extension, tugas berjalan saat berpindah tab, reconnect/retry tanpa aksi ganda, indikator izin/progress/notifikasi.
5. **P1 chat UI**: sederhanakan menjadi chat-first; model/tool/permission inline; riwayat dan bukti tugas; tanpa dashboard custom.
6. **P2 produktivitas**: pakai workflow & schedule yang sudah ada sebagai shortcuts dan `/`; console/network untuk diagnosis; perluasan site support hanya berdasarkan test.
7. **Release gate**: seluruh tes unit, CI, Chrome visible developer-mode, situs nyata + provider nyata + panduan izin, lalu uji extension setelah pembaruan Web Store. Jangan kirim versi baru bila ada kasus penting belum PASS.

**Catatan:** Membandingkan fitur dokumentasi publik tidak membuktikan arsitektur internal/proprietary Claude. Tujuannya parity perilaku, bukan menyalin kode atau merek. Versi 0.4.2 sudah publik; riset ini tidak mengubah rilis tersebut.
