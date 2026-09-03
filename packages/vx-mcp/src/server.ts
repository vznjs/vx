// MCP over stdio, natively: newline-delimited JSON-RPC 2.0 in, the same
// out. The three methods an agent needs — `initialize`, `tools/list`,
// `tools/call` — plus `ping`; notifications are acknowledged by silence.
// Everything else is the standard "method not found".

import { isUserError, VERSION } from '@vzn/vx'
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
          // protocol error: it names what to fix ("taskId must be …"). By
          // name, not instanceof: inside a compiled vx the tools' core and
          // this plugin's `@vzn/vx` can be two copies of the same class.
          if (isUserError(err)) {
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

/**
 * Serve `input` until it ends, writing one JSON line per reply. Messages are
 * handled in order, one at a time. ONE streaming decoder for the whole
 * session: a chunk boundary can fall inside a multi-byte character, and a
 * per-chunk decode turned `pé#build` into `p��#build` — a tool answering
 * for a task that does not exist (reproduced 2026-09-03).
 */
export async function serve(
  input: AsyncIterable<Uint8Array>,
  write: (line: string) => void,
  options: ServerOptions,
): Promise<void> {
  const out = (r: Response): void => {
    write(`${JSON.stringify(r)}\n`)
  }
  const decoder = new TextDecoder()
  let buffer = ''
  const drain = async (): Promise<void> => {
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
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true })
    await drain()
  }
  buffer += decoder.decode()
  await drain()
  if (buffer.trim().length > 0) {
    const r = await handleMessage(buffer.trim(), options)
    if (r !== null) out(r)
  }
}

/** Serve stdin → stdout until stdin closes. */
export async function serveStdio(options: ServerOptions): Promise<void> {
  await serve(Bun.stdin.stream(), (line) => process.stdout.write(line), options)
}
