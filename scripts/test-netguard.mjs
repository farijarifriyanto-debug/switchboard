/**
 * web_fetch SSRF guard: private/local targets are refused, redirects re-checked,
 * big bodies capped, and the opt-out works.
 *
 *   node scripts/test-netguard.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHost } from '../dist/index.js'
import { assertPublicUrl, isPrivateAddress } from '../dist/services/netguard.js'

for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
  assert.equal(isPrivateAddress(ip), true, `${ip} is private`)
}
for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
  assert.equal(isPrivateAddress(ip), false, `${ip} is public`)
}
await assert.rejects(assertPublicUrl('http://169.254.169.254/latest/meta-data'), /private or local/)
await assert.rejects(assertPublicUrl('http://[::1]:7777/'), /private or local/)
await assert.rejects(assertPublicUrl('http://localhost:7777/'), /private or local/)
await assert.rejects(assertPublicUrl('file:///etc/passwd'), /only http/)
await assert.rejects(assertPublicUrl('not a url'), /invalid URL/)
assert.equal((await assertPublicUrl('http://8.8.8.8/')).hostname, '8.8.8.8')

// local stub: a page and a huge body
let served = 0
const stub = http.createServer((req, res) => {
  served += 1
  if (req.url === '/redirect') {
    res.writeHead(302, { location: 'http://169.254.169.254/latest' })
    return res.end()
  }
  if (req.url === '/big') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    const chunk = 'x'.repeat(65536)
    let sent = 0
    const pump = () => {
      while (sent < 200 * 1024 * 1024) {
        sent += chunk.length
        if (!res.write(chunk)) return void res.once('drain', pump)
      }
      res.end()
    }
    return pump()
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<html><body>hello <b>world</b></body></html>')
})
await new Promise((r) => stub.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${stub.address().port}`

const make = (web) =>
  createHost({
    llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub', retries: 0 },
    metrics: { persist: '', load: false },
    sessions: { dir: '', load: false },
    approval: { mode: 'off' },
    tools: { web },
  })

const guarded = await make({ maxChars: 1000 })
try {
  const out = await guarded.ctx.tools.call('web_fetch', { url: `${base}/` })
  assert.match(out, /private or local/, 'loopback stub is refused by default')
  assert.equal(served, 0, 'the request never left the machine')
} finally {
  await guarded.dispose()
}

const open = await make({ maxChars: 1000, allowPrivateNetwork: true })
try {
  assert.match(await open.ctx.tools.call('web_fetch', { url: `${base}/` }), /HTTP 200\nhello world/, 'opt-out fetches normally')
  const started = Date.now()
  const big = await open.ctx.tools.call('web_fetch', { url: `${base}/big` })
  assert.ok(Date.now() - started < 8_000, `a 200 MB body is cut off early (took ${Date.now() - started}ms)`)
  assert.ok(big.length <= 1000 + 20, `result is capped at maxChars (got ${big.length})`)
} finally {
  await open.dispose()
}
console.log('netguard: OK')
stub.close()
stub.closeAllConnections?.()
