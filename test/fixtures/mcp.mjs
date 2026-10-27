// Local stdio MCP server for integration tests; no network or external account.
import { createInterface } from 'node:readline'
import { appendFile } from 'node:fs/promises'

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  let result
  switch (request.method) {
    case 'initialize': result = { protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'canvas-fixture', version: '1.0.0' } }; break
    case 'ping': result = {}; break
    case 'tools/list': result = { tools: [{ name: 'echo', description: 'Return a harmless canvas test keyword.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }; break
    case 'tools/call':
      if (process.env.CANVAS_MCP_LOG) await appendFile(process.env.CANVAS_MCP_LOG, JSON.stringify(request.params) + '\n')
      result = { content: [{ type: 'text', text: 'soft-jelly' }] }; break
    default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: -32601, message: 'Method not found' } }) + '\n'); continue
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
}
