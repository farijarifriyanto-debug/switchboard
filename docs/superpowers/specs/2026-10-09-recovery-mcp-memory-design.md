# Pemulihan background job, MCP, dan pencarian memory

Status: rancangan untuk ditinjau, belum diimplementasikan.

## Tujuan dan urutan

Permintaan pengguna: implementasikan pemulihan background job setelah restart,
lalu peningkatan MCP dan pencarian memory. Kerjakan dan verifikasi setiap tahap
sebelum beralih ke tahap berikutnya. Pertahankan perilaku tools dan preset yang
sudah ada serta dukungan Node 20/22.

Asumsi rancangan: "pemulihan" memulihkan antrean, hasil dan status pekerjaan.
Perintah yang sudah mulai dieksekusi tidak otomatis diulang karena tools dapat
memiliki efek eksternal yang tidak idempoten. Pengguna dapat meminta percobaan
baru setelah melihat pekerjaan yang terputus.

## Temuan dari kode saat ini

- `src/plugins/subagent.ts` menyimpan jobs dan pending injections hanya dalam
  Map di memori. Unload mengosongkan keduanya.
- Session anak memiliki `jobId` dan `parentSessionId`, tetapi TaskSpec lengkap
  dan status pengiriman hasil tidak disimpan.
- `appendInjections()` mengubah `session.messages` langsung. Memanggil
  `sessions.flush()` setelah itu tidak menjamin perubahan disimpan jika sesi
  tersebut tidak berada dalam dirty set.
- `SessionService.write()` menelan kegagalan tulis; ini tidak cukup untuk
  checkpoint yang harus berhasil sebelum worker mulai.
- Hydration memuat maksimal 200 sesi secara default. Recovery tidak boleh
  mengabaikan parent/child aktif hanya karena berada di luar batas tersebut.
- MCP ToolsService menghasilkan string; structuredContent hanya masuk log.
  Resources dan prompt templates belum dijembatani.
- Recall mencari substring dari sesi yang dimuat di memori. Notebook memory
  tidak memiliki tool pencarian sendiri.

## Tahap 1: checkpoint background job pada sesi induk

### Pilihan penyimpanan

Pilihan A, direkomendasikan: metadata job disimpan dalam JSON sesi induk.
Transcript, penerimaan hasil, dan checkpoint delivery dapat diperbarui dalam
satu penggantian file atomik. Ini memakai penyimpanan yang sudah ada.

Pilihan B: file jobs terpisah. Lebih mudah diakses tanpa sesi, tetapi memerlukan
rekonsiliasi atau journal lintas file agar hasil tidak hilang/terkirim ganda.

Pilihan C: SQLite untuk sesi dan job. Transaksi lebih kuat, tetapi menambah
dependensi, migrasi data, dan perubahan backend yang tidak diperlukan tahap ini.

### Data dan aturan

Tambahkan metadata opsional berversi pada SessionData untuk background jobs:
jobId, child sessionId, TaskSpec, status, timestamps, result/error, dan delivery
receipt. Metadata tidak masuk ke prompt model. Sesi lama tetap dapat dibaca.

Simpan TaskSpec, identitas parent/child, workspace, model/provider, dan antrean
sebelum mengembalikan descriptor job. Simpan transisi queued -> running sebelum
memulai model atau tool anak. Hasil final disimpan sebelum dijadwalkan untuk
dikirim. Pengiriman memperbarui transcript dan receipt dalam satu checkpoint
sesi induk, dengan deduplikasi berdasarkan jobId.

Persistence harus memiliki operasi checkpoint yang melaporkan kegagalan kepada
pemanggil, mengurutkan penulisan per sesi, dan memakai temporary file unik plus
rename. Worker background tidak mulai apabila checkpoint awal gagal. Autosave
umum tetap kompatibel. Tempat penyimpanan harus benar-benar lokal; rancangan ini
tidak menjanjikan durability terhadap kerusakan perangkat atau mati listrik.

### Perilaku restart

| Keadaan tersimpan | Pemulihan |
| --- | --- |
| queued | Lanjutkan antrean dengan TaskSpec, budget, workspace dan approval terkini. |
| running | Tandai failed dengan alasan interrupted by restart; jangan ulang eksekusi. |
| done/failed, hasil belum diterima parent | Kirim hasil sekali ke transcript parent. |
| hasil sudah diterima parent | Jangan kirim ulang. |
| wake parent sudah mulai tetapi terputus | Jangan otomatis ulang wake; tunggu input pengguna berikutnya. |
| parent dihapus | Jangan jalankan worker; catat diagnostic tanpa membuat ulang sesi. |
| persistence/loading/subagent dinonaktifkan | Jangan jalankan recovery. |

Sesi induk dengan pekerjaan belum selesai dan anak yang dirujuk harus tersedia
meskipun di luar hydration limit. Session yang berstatus working atau
waiting_approval dari proses lama direkonsiliasi sebelum menentukan busy.
Grant approval sesi lama tidak dipulihkan. Perintah dengan approval aktif dapat
menunggu keputusan baru; startup tidak mematikan approval.

Shutdown normal mempertahankan job queued, menandai worker running terputus,
menghentikan proses anak, dan menyimpan hasil pending sebelum disposal services.
Stop dari pengguna tetap pembatalan final, bukan alasan mengantre ulang.

Recovery otomatis hanya dimiliki proses berumur panjang (`sbx web` dan
`sbx channels`), setelah UI/channel approval siap. Boot perintah sekali jalan
tidak boleh diam-diam menjalankan antrean. Tambahkan kunci kepemilikan recovery
yang tidak dapat direbut hanya berdasarkan usia, supaya dua host tidak
menjalankan antrean yang sama. Jika pemilik masih hidup atau tidak dapat
dipastikan mati, host kedua hanya membaca status dan tidak mengeksekusi job.
Pembuktian pemilik mati memakai identitas proses dan host yang disimpan;
kepemilikan host lain tidak otomatis diambil alih.

### Pengujian wajib

Gunakan child process dan stub LLM, bukan hanya unload/reload plugin:

- Hard kill proses saat job queued, running, selesai sebelum delivery, dan
  sesudah delivery; start host baru dan periksa keadaan serta jumlah eksekusi.
- Hasil yang tertunda saat parent busy bertahan setelah restart.
- Tidak ada pengiriman ganda atau replay tool yang sudah berjalan.
- Stop, autoResume=false, limit workers/token/biaya, parent dihapus, dan sesi
  lama tetap berperilaku benar.
- Kegagalan checkpoint menghentikan dispatch; concurrent writes terserialisasi.
- Job di luar hydration limit pulih; dua host tidak merebut antrean.
- Akses sesi read-only/once-shot tidak memicu kerja background.

## Tahap 2: MCP terstruktur, Resources, dan prompt templates

Tambahkan jalur hasil terstruktur yang bersifat additive pada ToolsService;
`call()` tetap mengembalikan string untuk kompatibilitas agent loop dan plugin.
Pemanggil programatik dapat memperoleh content, structuredContent, dan isError.
Structured-only results juga dirender sebagai JSON terbatas agar model tidak
lagi menerima `(empty result)` saat server mengembalikan data yang berguna.
Metadata terstruktur tidak dicetak utuh dalam log.

Untuk server yang mengiklankan capability terkait, sediakan operasi namespaced
list/read Resources, list Resource templates, serta list/get prompt templates.
Tangani pagination, timeouts, cancellation, reconnect, notifications perubahan
list bila server mendukung, dan server tanpa capability. Validasi argumen dan
URI harus terjadi sebelum request. Jangan otomatis mengambil URL resource di
luar transport MCP: resource dibaca melalui server yang dipilih.

Nama bridge melalui perencanaan nama yang sama dengan tool MCP; tabrakan dengan
tool server ditolak secara eksplisit. Operasi melewati approval dan pembatasan
preset yang sudah ada. Prompt server adalah data yang diminta, bukan system
instruction yang otomatis dipercaya atau disuntikkan. Resource binary tetap
diagnostic terbatas; attachment storage, OAuth, dan hot reload konfigurasi
tidak termasuk tahap ini.

Tes menggunakan fixtures stdio dan streamable-http untuk structured-only,
text+structured, isError, resource teks/binary, templates, prompts, pagination,
capability absent, cancellation, reconnect, collision, dan pembatasan preset.

## Tahap 3: pencarian notebook dan arsip sesi

Tambahkan `search_memory` read-only untuk catatan project/global, dengan scope,
limit, dan cuplikan yang menunjukkan asal. Respect memory.enabled dan tool
allowlist; reviewer/researcher tidak otomatis mendapat akses notebook.

Perluas `search_sessions` untuk sesi tersimpan di disk yang tidak terhidrasi,
tanpa memuat seluruhnya ke live session registry. `read_session` dapat membaca
hasil tersebut secara read-only. Session live menjadi sumber terbaru saat id
yang sama juga ada di disk. Penelusuran hanya membaca file sesi yang valid dari
direktori yang dikonfigurasi; batasi ukuran file, concurrency, jumlah hasil,
dan panjang cuplikan. Konten malformed dilewati dengan diagnostic terbatas.

Gunakan pencocokan kata Unicode dan normalisasi case untuk bahasa Indonesia
serta Inggris, dengan ranking relevansi dan recency deterministik. Pertahankan
default semua istilah cocok; mode kecocokan sebagian merupakan opsi eksplisit.
Tidak ada dependency embedding, panggilan provider, atau vector database.
Notebook tetap Markdown yang dapat diedit tangan.

Tes mencakup sesi di luar hydration limit, archived messages, deduplikasi
live/disk, file rusak atau terlalu besar, edit/hapus notebook, memory disabled,
Unicode, ranking, batas hasil, dan preset yang tidak boleh membaca history.

## Delivery dan verifikasi

Kerjakan tiga tahap secara berurutan pada branch terisolasi, dengan regression
test yang gagal sebelum perubahan perilaku. Update README, CHANGELOG, serta
script test untuk setiap tahap. Jalankan typecheck, build, tes terkait, lalu
suite repository. Laporkan sandbox/browser checks yang skip dan keterbatasan
pengujian provider nyata. Perubahan ini tidak memerlukan key provider nyata.
Tidak ada publish, merge, atau perubahan layanan eksternal dalam scope ini.
