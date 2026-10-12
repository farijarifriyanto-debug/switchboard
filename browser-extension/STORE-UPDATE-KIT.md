# Chrome Web Store update kit — Switchboard Browser Companion

Dibuat 12 Oktober 2026 untuk pemilik akun developer. Chrome tidak mengizinkan extension (termasuk Claude in Chrome) mengendalikan dashboard Chrome Web Store, jadi pengunggahan dan "Submit for review" dilakukan manual oleh pemilik. Semua isian di bawah siap ditempel.

## Paket

| Item | Nilai |
| --- | --- |
| Berkas | `C:\Users\farij\cl\sb\switchboard-chrome.zip` |
| Versi di manifest | `0.4.2` |
| SHA-256 | `603f22ac873713dfd6de1887160e1657c55d3a880f04ee3eec237bc1f876c9b0` |
| Dibangun dari | commit `52032e4` (branch `fix/browser-action-errors-20261011`), dengan `npm run package:extension` |

**Aturan versi:** Web Store hanya menerima versi yang lebih tinggi dari yang sedang tayang. Lihat versi yang tayang di dashboard. Jika sudah `0.4.2` atau lebih tinggi, naikkan `version` di `manifest.json` (misalnya `0.4.3`), jalankan `npm run package:extension`, dan pakai ZIP baru. Jangan membuat item baru: perbarui item yang sudah ada.

## Hal yang berubah dan memicu peninjauan lebih lama

Izin baru dibanding versi sebelumnya: `debugger`, `downloads`, `nativeMessaging`, `notifications`, `tabGroups`. `debugger` menampilkan peringatan izin yang menonjol, dan pengguna lama bisa diminta menyetujui izin baru sebelum extension aktif kembali. Siapkan justifikasi di bawah dan jelaskan di catatan reviewer.

## Langkah di dashboard

1. Buka https://chrome.google.com/webstore/devconsole dengan akun publisher yang benar, lalu pilih item Switchboard Browser Companion. Pastikan ID item dan kepemilikannya sesuai.
2. **Package** → Upload new package → pilih ZIP di atas.
3. **Store listing**: periksa nama, deskripsi, kategori (Productivity), dan unggah screenshot baru (lihat di bawah).
4. **Privacy** → isi bagian di bawah, lalu masukkan URL kebijakan privasi (lihat Hambatan).
5. **Submit for review**. Tunggu konfirmasi dan status tayang dari store.

## Single purpose

Control the user's own approved browser tabs from the Switchboard agent that runs on the same computer.

## Justifikasi izin (tempel per izin)

| Izin | Justifikasi |
| --- | --- |
| activeTab | User-initiated temporary access to the current tab and limited screenshot permission. |
| scripting | Run approved page inspection and controlled actions in the tab the user's task targets. |
| tabs | Identify and select tabs and show the current tab in the side panel. |
| tabGroups | Group the tabs Switchboard opens under one labeled group; only those tabs can be closed by the agent. |
| storage | Store the local pairing credential, settings, permitted sites and a bounded activity log (300 entries). |
| sidePanel | The chat and permission controls. |
| alarms | Reconnect to the local Switchboard service after the browser suspends the background worker. |
| debugger | Send trusted clicks and key presses and capture screenshots through the DevTools Protocol. Attached to a tab only while one approved action runs, then detached. |
| downloads | Report a file download that the user approved (name and source). File contents are not read. |
| nativeMessaging | Read the local pairing credential from a helper that the user installed on the same computer, so no code has to be typed. The helper makes no network requests. |
| notifications | Tell the user that a site permission request is waiting. |
| Host access `127.0.0.1` and `localhost` | Talk only to the Switchboard service on this computer. |
| Optional host access (http/https) | Requested for one site at a time after the user clicks Allow; necessary to automate pages the user approves. No global grant. |

## Remote code

No. All code is in the package. The extension does not load or execute remote scripts.

## Data usage (Privacy practices)

Declare these categories as handled: **Website content**, **Web history** (URLs and page titles of tabs the user targets), **User activity** (clicks, typing, navigation requested by the user). Certify that the data is **not sold**, **not used for unrelated purposes**, and **not used for creditworthiness or lending**. State that data is processed on the user's computer, and that the local Switchboard agent can send selected page content to the AI provider the user chose. This matches `PRIVACY.md`.

## Catatan untuk reviewer (Notes for the reviewer)

The extension needs the open-source Switchboard agent running locally (https://github.com/farijarifriyanto-debug/switchboard) and does nothing on its own. To test: install Switchboard, run `sbx web --preset browser`, open the extension, press Connect, then give a task in the side panel such as "open example.com and summarize it". Chrome asks for access to each site; the user can decline. The native messaging helper is optional (manual pairing with a code also works).

## Screenshot yang perlu disiapkan (dari Chrome bersih, tanpa tab pribadi)

1. Panel kosong dengan saran awal.
2. Percakapan dengan langkah tool yang terlipat dan jawaban berformat.
3. Kartu persetujuan di atas kolom input.
4. Pengaturan: pilihan Manual / Auto / Skip dan daftar situs yang diizinkan.

Panel bisa dirender dengan `C:\Users\farij\cl\exp\render-panel.cjs` untuk draf, tapi screenshot final sebaiknya dari Chrome asli.

## Hambatan sebelum mengirim

1. **URL kebijakan privasi**: `https://github.com/farijarifriyanto-debug/switchboard/blob/master/browser-extension/PRIVACY.md` mengarah ke branch `master`. Pembaruan kebijakan (bagian "Browser permissions") baru ada di branch `fix/browser-action-errors-20261011`, yang belum di-merge atau di-push. Reviewer membaca versi yang tayang, jadi merge dulu, atau pakai URL halaman kebijakan lain yang sudah memuat pembaruan.
2. **ID extension di store berbeda dari ID unpacked.** Helper native host harus diizinkan untuk ID dari store (`install-native-host.mjs` menerima ID sebagai argumen). Pengguna dari store perlu menjalankan installer dengan ID itu; tanpanya mereka memakai pairing dengan kode.
3. **Gerbang rilis internal** (`docs/browser-parity-gate-20261011.md`): daftar tab yang menandai tab agen belum terverifikasi di Chrome, dan izin situs per situs belum teruji karena profil Chrome saat ini memberi izin semua situs. Pemilik memutuskan apakah ini diterima untuk rilis.
4. **Aturan penerbitan**: pengiriman ke store adalah tindakan publik. Dilakukan oleh pemilik, bukan otomatis.
