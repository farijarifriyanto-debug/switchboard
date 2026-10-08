/**
 * Dev helper: calls the real endpoint and reports whether inline-` thinking`
 * blocks were separated out of `content`. Prints base64 so the raw payload
 * survives terminals that themselves parse think tags.
 *
 *   node scripts/debug-live.mjs [model]
 */
import { createHost } from '../dist/index.js'

const model = process.argv[2] || 'gpt-oss-120b'
const host = await createHost({ llm: { defaultModel: model } })
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

try {
  const messages = [{ role: 'user', content: 'What is 6*7? Answer with just the number after thinking briefly.' }]
  const r = await host.ctx.llm.generate({ messages })

  const open = '<' + 'think' + '>'
  const close = '<' + '/' + 'think' + '>'
  console.log('model        :', r.model)
  console.log('ttftMs       :', r.ttftMs, 'tok/s:', r.tokensPerSec)
  console.log('content b64  :', b64(r.content))
  console.log('reasoning b64:', b64(r.reasoning))
  console.log('leak open    :', r.content.includes(open) || r.content.includes('<' + 'thinking' + '>'))
  console.log('leak close   :', r.content.includes(close) || r.content.includes('<' + '/' + 'thinking' + '>'))
  console.log('reasoningLen :', r.reasoning.length)
} finally {
  await host.dispose()
}
