import http from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

/**
 * In-process Streamable HTTP MCP server (stateless mode: a fresh server +
 * transport per request, exactly the SDK's documented pattern). Returns a
 * handle so the test suite owns the lifecycle.
 */
export function startFakeMcpHttp() {
  const makeServer = () => {
    const server = new Server(
      { name: 'fake-mcp-http', version: '1.0.0' },
      { instructions: 'HTTP fixture for Switchboard MCP tests.', capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'ping', description: 'HTTP ping', inputSchema: { type: 'object', properties: {} } }],
    }))
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
    return server
  }
  const readJson = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : undefined)
      })
      req.on('error', reject)
    })
  const server = http.createServer(async (req, res) => {
    try {
      const body = req.method === 'POST' ? await readJson(req) : undefined
      const mcp = makeServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        transport.close().catch(() => {})
        mcp.close().catch(() => {})
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error) }))
      }
    }
  })
  return {
    url: () => `http://127.0.0.1:${server.address().port}/mcp`,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
    // close() alone waits for idle keep-alive sockets owned by still-running
    // hosts; force them down so the suite never hangs here.
    close: () => {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}
