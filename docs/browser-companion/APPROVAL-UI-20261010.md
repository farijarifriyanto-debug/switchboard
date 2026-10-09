# Browser approval — transparansi aksi dan target

**Tanggal:** 10 Oktober 2026 (WIB)
**Branch:** `feat/chrome-browser-companion`
**Status:** PASS pada laptop Windows, UI Microsoft Edge, Browser Companion Chrome, model Agnes 3.0 Flash sungguhan.

## Perubahan

Persetujuan tool browser sekarang menampilkan:

- Nama tindakan manusiawi dan ID tool yang sebenarnya, misalnya `Click browser element (browser_click)`.
- CSS selector target, misalnya `#increment`.
- Origin situs aktif yang **terakhir dilaporkan extension**, atau `not verified` jika ID tab tidak cocok / belum tersedia. Ini informasi pratinjau, bukan janji bahwa tab tidak akan berubah.
- URL navigasi disederhanakan tanpa username, password, parameter query, atau fragment.
- Isi `browser_type` disembunyikan juga dari panel detail tool; hanya jumlah karakter ditampilkan.
- Keterangan yang jujur untuk **Allow for this session**: izin berikutnya berlaku untuk penggunaan tool yang sama, termasuk pada situs/selector lain. **Allow once** dan **Reject** tetap tersedia.

Tidak mengubah syarat approval default `risky`; penggunaan situs atau origin dibatasi lagi oleh Browser Companion.

## Pengujian Web UI dan Chrome asli

1. Model mengirim `browser_dom_snapshot`, mengamati situs `http://127.0.0.1:8999`.
2. Model meminta `browser_click` pada `#increment`.
3. Web UI menampilkan kartu persetujuan dengan situs, selector, dan nama aksi. Sebelum izin, halaman tetap `Clicks: 0`.
4. Tombol **Allow once** ditekan melalui Web UI uji.
5. Extension Chrome menjalankan klik, dan `browser_dom_snapshot` sesudahnya mengembalikan `Clicks: 1`.
6. Model menyelesaikan respons dalam bahasa Indonesia. Status `Completed`, tanpa kesalahan tool/provider.

Durasi lengkap: sekitar **9,4 detik** dalam pengujian ini.

## Pengujian regresi

- `scripts/test-browser-approval-ui.mjs`: PASS (tool names, selector, mismatch ID tab, sanitasi URL dan teks, API hanya membocorkan origin, keputusan Reject tetap efektif).
- `npm run typecheck && npm run build && npm test`: **PASS, exit 0**, durasi sekitar **223,4 detik** pada VPS setelah patch.
- Tidak dilakukan deploy production, merge `master`, atau publikasi extension.

## Bukti

- [Screenshot saat approval menunggu](./approval-clear-before.png)
- [Screenshot setelah Allow once dan jawaban AI](./approval-clear-after.png)
- [Hasil mesin E2E](./approval-clear-e2e.json)

Bukti screenshot telah dipangkas agar tidak menampilkan sidebar riwayat percakapan pribadi.
