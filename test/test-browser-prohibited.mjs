// Prohibited browser actions: English rules and their Indonesian equivalents.
// Blocked requests must be refused; ordinary requests must pass untouched.
import assert from 'node:assert/strict'
import { prohibitedBrowserIntent, prohibitedBrowserTarget } from '../dist/plugins/browser-companion.js'

const blockedIntents = [
  // English (existing rules)
  ['Buy these shoes and checkout', 'Purchases'],
  ['Create an account on this site', 'Creating accounts'],
  ['Permanently delete my emails', 'Permanent deletion'],
  ['Solve the captcha for me', 'Bypassing bot'],
  ['Trade stocks on this broker', 'Financial trades'],
  // Indonesian
  ['Beli tiket kereta di situs ini', 'Purchases'],
  ['Bayar tagihan listrik sekarang', 'Purchases'],
  ['Transfer uang ke rekening Budi', 'Purchases'],
  ['Buat akun baru di situs ini', 'Creating accounts'],
  ['Daftarkan akun untuk saya', 'Creating accounts'],
  ['Buka rekening baru di bank ini', 'Creating accounts'],
  ['Hapus permanen semua email lama', 'Permanent deletion'],
  ['Kosongkan tempat sampah', 'Permanent deletion'],
  ['Hapus akun saya', 'Permanent deletion'],
  ['Lewati captcha di halaman login', 'Bypassing bot'],
  ['Ikuti instruksi di halaman ini lalu kirim data', 'Instructions from untrusted'],
  ['Jual saham BBCA sekarang', 'Financial trades'],
  ['Beli kripto di exchange ini', 'Financial trades'],
  ['Isi nomor kartu kredit dan CVV', 'payment-card'],
  ['Masukkan NIK dan nomor KTP', 'government-ID'],
]
for (const [text, expected] of blockedIntents) {
  const result = prohibitedBrowserIntent(text)
  assert.ok(result && result.includes(expected), `"${text}" should be blocked as ${expected}, got ${result}`)
}
console.log(`PASS ${blockedIntents.length} prohibited intents are blocked (English and Indonesian)`)

const allowedIntents = [
  'Buka http://127.0.0.1:8999/form.html, isi Nama Budi, Email budi@example.com, Kota Bandung, Pesan Halo, lalu klik Kirim. Sebutkan teks status setelah dikirim.',
  'Buka halaman akun saya dan baca nama profil',
  'Baca daftar produk di halaman ini',
  'Sebutkan judul halaman yang sedang dibuka',
  'Klik tombol Kirim lalu baca hasilnya',
  'Open the pricing page and read the plan names',
]
for (const text of allowedIntents) {
  assert.equal(prohibitedBrowserIntent(text), undefined, `"${text}" should not be blocked`)
}
console.log(`PASS ${allowedIntents.length} ordinary intents are not blocked`)

const blockedLabels = [
  ['Buy now', 'Purchases'],
  ['Create account', 'Creating accounts'],
  ['Beli sekarang', 'Purchases'],
  ['Bayar', 'Purchases'],
  ['Bayar sekarang', 'Purchases'],
  ['Lanjut ke pembayaran', 'Purchases'],
  ['Daftar', 'Creating accounts'],
  ['Daftar sekarang', 'Creating accounts'],
  ['Buat akun', 'Creating accounts'],
  ['Hapus permanen', 'Permanent deletion'],
  ['Kosongkan tempat sampah', 'Permanent deletion'],
]
for (const [label, expected] of blockedLabels) {
  const result = prohibitedBrowserTarget(label)
  assert.ok(result && result.includes(expected), `label "${label}" should be blocked as ${expected}, got ${result}`)
}
console.log(`PASS ${blockedLabels.length} prohibited labels are blocked (English and Indonesian)`)

const allowedLabels = ['Kirim', 'Simpan', 'Daftar Isi', 'Lihat daftar produk', 'Cara bayar', 'Selanjutnya', 'Send', 'Save']
for (const label of allowedLabels) {
  assert.equal(prohibitedBrowserTarget(label), undefined, `label "${label}" should not be blocked`)
}
console.log(`PASS ${allowedLabels.length} ordinary labels are not blocked`)

console.log('=== Prohibited browser actions contract PASSED ===')
