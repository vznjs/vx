// MCP over stdio, natively: newline-delimited JSON-RPC 2.0 in, the same
// out. The three methods an agent needs — `initialize`, `tools/list`,
// `tools/call` — plus `ping`; notifications are acknowledged by silence.
// Everything else is the standard "method not found".

import { UserError, VERSION } from '@vzn/vx'
import { handleToolCall, listTools, type ToolContext } from './tools.js'

/** The newest protocol revision this server speaks; an older client's version is echoed back. */
export const PROTOCOL_VERSION = '2025-06-18'
const KNOWN_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])

export interface ServerOptions extends ToolContext {}

interface Request {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

type Response =
  | { jsonrpc: '2.0'; id: number | string | null; result: unknown }
  | { jsonrpc: '2.0'; id: number | string | null; error: { code: number; message: string } }

/** One message in, at most one message out (a notification answers nothing). */
export async function handleMessage(raw: string, ctx: ToolContext): Promise<Response | null> {
  let msg: Request
  try {
    msg = JSON.parse(raw) as Request
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }
  }
  const id = msg.id ?? null
  if (typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid request' } }
  }
  // A notification carries no id and expects no reply.
  const isNotification = msg.id === undefined
  const reply = (result: unknown): Response | null =>
    isNotification ? null : { jsonrpc: '2.0', id, result }
  try {
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.['protocolVersion']
        const protocolVersion =
          typeof asked === 'string' && KNOWN_VERSIONS.has(asked) ? asked : PROTOCOL_VERSION
        return reply({
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'vx', version: VERSION },
          instructions:
            'Read-only view of this workspace’s vx cache and run history. Nothing here runs a task.',
        })
      }
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: listTools() })
      case 'tools/call': {
        const name = msg.params?.['name']
        if (typeof name !== 'string') {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'tools/call: name must be a string' },
          }
        }
        try {
          const result = await handleToolCall(name, msg.params?.['arguments'], ctx)
          return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
        } catch (err) {
          // A tool's own refusal is a RESULT the agent should read, not a
          // protocol error: it names what to fix ("taskId must be …").
          if (err instanceof UserError) {
            return reply({ content: [{ type: 'text', text: err.message }], isError: true })
          }
          throw err
        }
      }
      default:
        if (isNotification) return null
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `method not found: ${msg.method}` },
        }
    }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    }
  }
}

/** Serve until stdin closes. Messages are handled in order, one at a time. */
export async function serveStdio(options: ServerOptions): Promise<void> {
  const out = (r: Response): void => {
    process.stdout.write(`${JSON.stringify(r)}\n`)
  }
  let buffer = ''
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk)
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line.length > 0) {
        const r = await handleMessage(line, options)
        if (r !== null) out(r)
      }
      nl = buffer.indexOf('\n')
    }
  }
  if (buffer.trim().length > 0) {
    const r = await handleMessage(buffer.trim(), options)
    if (r !== null) out(r)
  }
}
