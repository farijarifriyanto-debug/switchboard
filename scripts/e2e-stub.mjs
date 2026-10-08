/**
 * Deterministic OpenAI-compatible stub for E2E testing of the workbench.
 *
 * Serves /v1/models with BotConnector-style capability flags and streams
 * chat completions that exercise the full agent loop:
 *   - prompt mentioning "command"/"approval" -> run_command tool (approval gate)
 *   - anything else                          -> list_dir tool, then a final answer
 *
 *   node scripts/e2e-stub.mjs [port]
 */
import http from 'node:http'

const port = Number(process.argv[2] ?? 7791)

const MODELS = [
  { id: 'stub-alpha', owned_by: 'botconnector', botconnector_route: 'e2e', botconnector_access: 'test',
    botconnector_capabilities: { tools: true, vision: true, reasoning: true, context: 128000 }, context_length: 128000 },
  { id: 'stub-beta', owned_by: 'botconnector', botconnector_route: 'e2e', botconnector_access: 'test',
    botconnector_capabilities: { tools: false, vision: false, reasoning: false, context: 32000 }, context_length: 32000 },
]

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: MODELS }))
    return
  }

  if (url.pathname === '/v1/chat/completions') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    const messages = body.messages ?? []
    const sawTool = messages.some((m) => m.role === 'tool')
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const promptText = typeof lastUser?.content === 'string' ? lastUser.content : ''
    const wantsCommand = /\b(command|approval|npm test)\b/i.test(promptText)

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)

    if (!sawTool) {
      send({ choices: [{ delta: { reasoning_content: 'I should inspect the workspace first. ' } }] })
      const call = wantsCommand
        ? { index: 0, id: 'call_cmd', function: { name: 'run_command', arguments: JSON.stringify({ command: 'npm test' }) } }
        : { index: 0, id: 'call_ls', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }
      send({ choices: [{ delta: { tool_calls: [call] } }] })
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    const toolMessage = [...messages].reverse().find((m) => m.role === 'tool')
    const failed = String(toolMessage?.content ?? '').startsWith('Error:')

    // "slow story" -> long streamed reply so stop/cancel and duplicate-send can be tested.
    if (/\bslow story\b/i.test(promptText)) {
      const word = 'The quick brown fox jumps over the lazy dog. '
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 200))
        send({ choices: [{ delta: { content: word } }] })
        if (res.writableEnded || res.destroyed) return
      }
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 90, completion_tokens: 420, total_tokens: 510 } })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    const text = wantsCommand
      ? failed ? 'The command failed — see the output above.' : 'All checks passed: smoke, retry, context, web, approval.'
      : 'The workspace holds a package.json with the usual scripts.'
    send({ choices: [{ delta: { content: text.slice(0, Math.ceil(text.length / 2)) } }] })
    send({ choices: [{ delta: { content: text.slice(Math.ceil(text.length / 2)) } }] })
    send({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144, prompt_tokens_details: { cached_tokens: 32 } },
    })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(port, '127.0.0.1', () => {
  console.log(`e2e stub listening on http://127.0.0.1:${port}/v1`)
})
