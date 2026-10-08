import { existsSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// When the crash flag exists at spawn time the server refuses to come up —
// used to simulate a permanently failing respawn (reconnect budget tests).
const crashFile = process.env.SBX_MCP_CRASH_FILE
if (crashFile && existsSync(crashFile)) process.exit(1)

const INSTRUCTIONS = process.env.SBX_MCP_INSTRUCTIONS || 'Fixture server for Switchboard MCP tests.'
const tools = [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'failing', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Sleeps before answering', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  { name: 'mutate', description: 'Adds a tool and fires list_changed', inputSchema: { type: 'object', properties: {} } },
  { name: 'breaklist', description: 'Makes the next tools/list fail', inputSchema: { type: 'object', properties: {} } },
  { name: 'heal', description: 'Restores tools/list', inputSchema: { type: 'object', properties: {} } },
  { name: 'shutdown', description: 'Kills this server process', inputSchema: { type: 'object', properties: {} } },
  { name: 'pid', description: 'Reports the server pid', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'env', description: 'Reports scrubbed env facts', inputSchema: { type: 'object', properties: {} } },
]
let failList = false

const server = new Server(
  { name: 'fake-mcp', version: '1.0.0' },
  { instructions: INSTRUCTIONS, capabilities: { tools: { listChanged: true } } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (failList) throw new Error('list broken on purpose')
  return { tools }
})

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name
  const args = req.params.arguments ?? {}
  switch (name) {
    case 'echo':
      return { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }] }
    case 'failing':
      return { content: [{ type: 'text', text: 'fixture failure' }], isError: true }
    case 'slow':
      await sleep(Number(args.ms ?? 500))
      return { content: [{ type: 'text', text: 'slow done' }] }
    case 'mutate':
      if (!tools.some((t) => t.name === 'extra')) {
        tools.push({ name: 'extra', description: 'added later', inputSchema: { type: 'object', properties: {} } })
      }
      await server.sendToolListChanged()
      return { content: [{ type: 'text', text: 'added extra' }] }
    case 'breaklist':
      failList = true
      return { content: [{ type: 'text', text: 'list now fails' }] }
    case 'heal':
      failList = false
      return { content: [{ type: 'text', text: 'list healed' }] }
    case 'shutdown':
      process.exit(1)
      break
    case 'pid':
      return { content: [{ type: 'text', text: String(process.pid) }] }
    case 'env':
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            hasBotconnectorKey: Boolean(process.env.BOTCONNECTOR_API_KEY),
            hasSecret: Boolean(process.env.SOME_SECRET_KEY),
            override: process.env.SBX_MCP_OVERRIDE ?? null,
            hasHome: Boolean(process.env.HOME ?? process.env.USERPROFILE),
          }),
        }],
      }
    default:
      throw new Error(`unknown tool ${name}`)
  }
})

await server.connect(new StdioServerTransport())
