/**
 * Console access token: required off loopback, cookie handshake, Bearer, no leaks.
 *
 *   node scripts/test-web-token.mjs
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createHost } from '../dist/index.js'

const base = {
  llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub', retries: 0 },
  metrics: { persist: '', load: false },
  sessions: { dir: '', load: false },
}
const TOKEN = `t-${randomBytes(12).toString('hex')}`

// A non-loopback bind without a token must refuse to start.
await assert.rejects(
  createHost({ ...base, web: { enabled: true, port: 0, host: '0.0.0.0' } }),
  /not loopback/,
  'binding off loopback without a token is refused',
)

const host = await createHost({ ...base, web: { enabled: true, port: 0, token: TOKEN } })
try {
  const { url, accessUrl } = await host.ctx.web.ready()
  assert.equal(accessUrl, `${url}?token=${TOKEN}`, 'accessUrl carries the token, url does not')

  assert.equal((await fetch(`${url}api/state`)).status, 401, 'api without credentials')
  assert.equal((await fetch(url)).status, 401, 'console page without credentials')
  assert.equal((await fetch(`${url}?token=wrong`, { redirect: 'manual' })).status, 401, 'wrong token')
  assert.equal((await fetch(`${url}api/state`, { headers: { cookie: 'sbx_token=wrong' } })).status, 401, 'wrong cookie')

  // Bearer works for scripts.
  assert.equal((await fetch(`${url}api/state`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200)

  // Browser handshake: token in the URL once -> HttpOnly SameSite=Strict cookie, URL cleaned.
  const hello = await fetch(`${url}?token=${TOKEN}`, { redirect: 'manual' })
  assert.equal(hello.status, 302)
  assert.equal(hello.headers.get('location'), '/', 'token is dropped from the URL')
  const cookie = hello.headers.get('set-cookie') ?? ''
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  const pair = cookie.split(';')[0]
  assert.equal((await fetch(`${url}api/state`, { headers: { cookie: pair } })).status, 200, 'cookie authenticates')
  assert.equal((await fetch(url, { headers: { cookie: pair } })).status, 200, 'console page loads with the cookie')

  // The token never shows up in a response body.
  const state = await (await fetch(`${url}api/state`, { headers: { cookie: pair } })).text()
  assert.ok(!state.includes(TOKEN), 'state does not echo the token')
  console.log('web-token: OK')
} finally {
  await host.dispose()
}
