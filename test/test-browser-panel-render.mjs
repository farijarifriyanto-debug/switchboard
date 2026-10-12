// Side panel chat rendering: model/page text must never become markup, and step labels
// must describe the action without exposing typed values.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync('browser-extension/panel.js', 'utf8')
const slice = (from, to) => {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `panel.js section ${from} .. ${to} is present`)
  return source.slice(start, end)
}
const render = new Function(slice('function escapeHtml(', 'function hostOf(') + '\nreturn { escapeHtml, formatReply }')()
const steps = new Function(slice('function hostOf(', 'function note(') + '\nreturn { stepLabel }')()

// Markup from the model or a web page is escaped.
{
  const html = render.formatReply('<img src=x onerror=alert(1)> <script>alert(1)</script>')
  assert.ok(!html.includes('<img') && !html.includes('<script'), 'raw tags are escaped')
  assert.ok(html.includes('&lt;img') && html.includes('&lt;script'), 'escaped tags stay visible as text')
  console.log('PASS raw HTML in a reply is escaped')
}

// Links: only http(s); quotes cannot break out of the attribute.
{
  const attack = render.formatReply('[klik](https://a.example/"onmouseover="alert(1))')
  assert.ok(!attack.includes('"onmouseover'), 'quote cannot start a new attribute')
  assert.ok(attack.includes('&quot;'), 'quotes are escaped inside the link')
  const js = render.formatReply('[x](javascript:alert(1))')
  assert.ok(!js.includes('<a '), 'javascript: links are not turned into anchors')
  const ok = render.formatReply('[halaman uji](http://127.0.0.1:8999/form.html)')
  assert.match(ok, /<a href="http:\/\/127\.0\.0\.1:8999\/form\.html" target="_blank" rel="noopener noreferrer">halaman uji<\/a>/)
  console.log('PASS links are limited to http(s) and cannot inject attributes')
}

// Formatting the reply needs: bold, italic, inline code, lists, code fences.
{
  const html = render.formatReply('**Terkirim** dan *selesai* dengan `#kirim`.\n\nYang diisi:\n- Nama: Budi\n- Kota: Bandung\n\n1. Buka\n2. Klik\n\n```js\nconst a = "<b>"\n```')
  assert.ok(html.includes('<strong>Terkirim</strong>'), 'bold')
  assert.ok(html.includes('<em>selesai</em>'), 'italic')
  assert.ok(html.includes('<code>#kirim</code>'), 'inline code')
  assert.ok(/<ul><li>Nama: Budi<\/li><li>Kota: Bandung<\/li><\/ul>/.test(html), 'bullet list')
  assert.ok(/<ol><li>Buka<\/li><li>Klik<\/li><\/ol>/.test(html), 'numbered list')
  assert.ok(html.includes('<pre><code>const a = &quot;&lt;b&gt;&quot;</code></pre>'), 'code fence is escaped and has no language line')
  console.log('PASS replies render bold, italic, code, lists and code blocks')
}

// Step labels describe the action and never include typed text.
{
  assert.equal(steps.stepLabel('browser_navigate', { url: 'http://127.0.0.1:8999/form.html' }), 'Membuka 127.0.0.1:8999')
  const typed = steps.stepLabel('browser_type', { selector: '#nama', text: 'rahasia-123' })
  assert.equal(typed, 'Mengisi #nama')
  assert.ok(!typed.includes('rahasia'), 'typed text is never shown')
  assert.equal(steps.stepLabel('browser_dom_snapshot', {}), 'Membaca halaman')
  assert.equal(steps.stepLabel('browser_tab_close', {}), 'Menutup tab')
  assert.equal(steps.stepLabel('browser_key', { key: 'Enter' }), 'Menekan tombol')
  assert.equal(steps.stepLabel('browser_unknown_tool', {}), 'unknown tool')
  console.log('PASS step labels are readable and never expose typed values')
}

console.log('=== Side panel chat rendering PASSED ===')
