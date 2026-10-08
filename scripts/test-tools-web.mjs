/**
 * web_search provider routing — default must stay Keenable (keyless, no quota),
 * `provider: "botconnector"` opts into the native BotConnector Cloud endpoint
 * with automatic fallback to Keenable on error/empty/no-key.
 *
 *   node scripts/test-tools-web.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHost } from '../dist/index.js'

const RESULT = { title: 'TypeScript 5.9', url: 'https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html', snippet: 'Release notes.' }

/** Search stub that records every request and answers with a fixed payload. */
async function searchStub({ results = [RESULT], status = 200 } = {}) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    calls.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
    })
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ provider: 'stub', results }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    calls,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function withHost(search, fn) {
  const host = await createHost({
    llm: { baseURL: 'http://127.0.0.1:9/v1', defaultModel: 'stub', retries: 0 },
    metrics: { persist: '', load: false },
    sessions: { dir: '', load: false },
    tools: { web: { search } },
  })
  try {
    return await fn(host)
  } finally {
    await host.dispose()
  }
}

const envKey = process.env.BOTCONNECTOR_API_KEY
delete process.env.BOTCONNECTOR_API_KEY

try {
  // ------------------------------------------------- default = Keenable only
  {
    const keenable = await searchStub()
    const native = await searchStub()
    try {
      await withHost({ apiUrl: keenable.origin, botconnectorBaseURL: `${native.origin}/v1`, botconnectorApiKey: 'should-not-be-used' }, async (host) => {
        const out = await host.ctx.tools.call('web_search', { query: 'typescript 5.9', max_results: 3 })
        assert.match(out, /Results for: typescript 5.9/, 'formatted results are returned')
        assert.match(out, /TypeScript 5\.9/, 'the result title is rendered')
        assert.equal(keenable.calls.length, 1, 'the default path hits Keenable')
        assert.equal(keenable.calls[0].url, '/v1/search/public', 'keyless Keenable endpoint is used')
        assert.equal(keenable.calls[0].headers['x-keenable-title'], 'Switchboard', 'attribution title is sent')
        assert.equal(keenable.calls[0].body.max_results, 3, 'max_results is forwarded')
        assert.equal(native.calls.length, 0, 'without opt-in the native endpoint must not be called')
      })
    } finally {
      await keenable.close()
      await native.close()
    }
    console.log('ok: default stays on Keenable (no native call)')
  }

  // -------------------------------- opt-in: native first, Keenable untouched
  {
    const keenable = await searchStub()
    const native = await searchStub()
    try {
      await withHost(
        {
          provider: 'botconnector',
          botconnectorBaseURL: `${native.origin}/v1`,
          botconnectorApiKey: 'k-123',
          apiUrl: keenable.origin,
        },
        async (host) => {
          const out = await host.ctx.tools.call('web_search', { query: 'native first', max_results: 15 })
          assert.match(out, /Results for: native first/)
          assert.match(out, /TypeScript 5\.9/)
          assert.equal(native.calls.length, 1, 'the opted-in native endpoint is used')
          assert.equal(native.calls[0].url, '/v1/web/search', 'native path is /v1/web/search')
          assert.equal(native.calls[0].headers.authorization, 'Bearer k-123', 'the API key is sent as a bearer token')
          assert.equal(native.calls[0].body.max_results, 15, 'no client-side clamp — the server owns its cap')
          assert.equal(keenable.calls.length, 0, 'a successful native call must not touch Keenable')
        },
      )
    } finally {
      await keenable.close()
      await native.close()
    }
    console.log('ok: opt-in uses the native endpoint first')
  }

  // ------------------------------------- opt-in + native failure -> fallback
  {
    const keenable = await searchStub()
    const native = await searchStub({ status: 500 })
    try {
      await withHost(
        { provider: 'botconnector', botconnectorBaseURL: `${native.origin}/v1`, botconnectorApiKey: 'k', apiUrl: keenable.origin },
        async (host) => {
          const out = await host.ctx.tools.call('web_search', { query: 'fallback please' })
          assert.match(out, /Results for: fallback please/, 'fallback still returns results')
          assert.equal(keenable.calls.length, 1, 'Keenable catches the native failure')
        },
      )
    } finally {
      await keenable.close()
      await native.close()
    }
    console.log('ok: native failure falls back to Keenable')
  }

  // ------------------------------------ opt-in + empty native results -> Keenable
  {
    const keenable = await searchStub()
    const native = await searchStub({ results: [] })
    try {
      await withHost(
        { provider: 'botconnector', botconnectorBaseURL: `${native.origin}/v1`, botconnectorApiKey: 'k', apiUrl: keenable.origin },
        async (host) => {
          const out = await host.ctx.tools.call('web_search', { query: 'empty native' })
          assert.match(out, /Results for: empty native/, 'empty native results fall back')
          assert.equal(keenable.calls.length, 1)
        },
      )
    } finally {
      await keenable.close()
      await native.close()
    }
    console.log('ok: empty native results fall back to Keenable')
  }

  // ------------------------------------- opt-in without any key -> direct Keenable
  {
    const keenable = await searchStub()
    const native = await searchStub()
    try {
      await withHost({ provider: 'botconnector', botconnectorBaseURL: `${native.origin}/v1`, apiUrl: keenable.origin }, async (host) => {
        const out = await host.ctx.tools.call('web_search', { query: 'no key at all' })
        assert.match(out, /Results for: no key at all/)
        assert.equal(native.calls.length, 0, 'without a key the native endpoint is skipped')
        assert.equal(keenable.calls.length, 1)
      })
    } finally {
      await keenable.close()
      await native.close()
    }
    console.log('ok: opted-in but keyless goes straight to Keenable')
  }

  // --------------------------------- opt-in key falls back to BOTCONNECTOR_API_KEY
  {
    const keenable = await searchStub()
    const native = await searchStub()
    try {
      process.env.BOTCONNECTOR_API_KEY = 'env-key-9'
      await withHost({ provider: 'botconnector', botconnectorBaseURL: `${native.origin}/v1`, apiUrl: keenable.origin }, async (host) => {
        await host.ctx.tools.call('web_search', { query: 'env key' })
        assert.equal(native.calls.length, 1, 'the env-provided key opts into the native endpoint')
        assert.equal(native.calls[0].headers.authorization, 'Bearer env-key-9')
      })
    } finally {
      delete process.env.BOTCONNECTOR_API_KEY
      await keenable.close()
      await native.close()
    }
    console.log('ok: BOTCONNECTOR_API_KEY supplies the key when opted in')
  }

  // ------------------------------------------------------- both providers fail
  {
    const keenable = await searchStub({ status: 500 })
    const native = await searchStub({ status: 503 })
    try {
      await withHost(
        { provider: 'botconnector', botconnectorBaseURL: `${native.origin}/v1`, botconnectorApiKey: 'k', apiUrl: keenable.origin },
        async (host) => {
          const out = await host.ctx.tools.call('web_search', { query: 'both fail' })
          assert.match(out, /^Error: web search failed/, 'failures surface as an error string')
          assert.match(out, /BotConnector: HTTP 503/, 'the native error is named')
          assert.match(out, /Keenable: HTTP 500/, 'the Keenable error is named')
        },
      )
    } finally {
      await keenable.close()
      await native.close()
    }
    console.log('ok: combined errors name both providers')
  }

  console.log('test-tools-web: all checks passed')
} finally {
  if (envKey === undefined) delete process.env.BOTCONNECTOR_API_KEY
  else process.env.BOTCONNECTOR_API_KEY = envKey
}
