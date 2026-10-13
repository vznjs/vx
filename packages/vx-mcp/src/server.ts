// MCP over stdio, natively: newline-delimited JSON-RPC 2.0 in, the same
// out. The methods an agent needs — `initialize`, `tools/list`,
// `tools/call` — plus `ping`; notifications are acknowledged by silence.
// A request whose `_meta` names a stateless revision (2026-07-28) is
// answered as that revision: no handshake, `server/discover`, a
// `resultType` and the server's identity on every result. Everything else
// is the standard "method not found".

import { Console } from 'node:console'
import { isUserError, maskedLine, VERSION } from '@vzn/vx'
import { handleToolCall, listTools, type ToolContext } from './tools.js'

/** The newest revision `initialize` answers; an older client's version is echoed back. */
export const PROTOCOL_VERSION = '2025-11-25'
const KNOWN_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'])
/** Revisions with no handshake: each request names its own in `_meta`. */
const STATELESS_VERSIONS = new Set(['2026-07-28'])
const SUPPORTED_VERSIONS = [...STATELESS_VERSIONS, ...[...KNOWN_VERSIONS].reverse()]
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion'
// 2026-07-28 moved the version error into the spec's range (-32020…-32099).
const UNSUPPORTED_PROTOCOL_VERSION = -32022

interface ServerOptions extends ToolContext {}

interface Request {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

type Response =
  | { jsonrpc: '2.0'; id: number | string | null; result: unknown }
  | {
      jsonrpc: '2.0'
      id: number | string | null
      error: { code: number; message: string; data?: unknown }
    }

const INVALID: Response = {
  jsonrpc: '2.0',
  id: null,
  error: { code: -32600, message: 'invalid request' },
}

/**
 * One line in, at most one line out (a notification answers nothing). A
 * batch array is answered as one array of its replies: 2025-03-26, a
 * version this server echoes, requires batches, and they were refused
 * whole with -32600 (F-10). An empty batch is invalid, as JSON-RPC says.
 */
export async function handleMessage(
  raw: string,
  ctx: ToolContext,
): Promise<Response | Response[] | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }
  }
  if (!Array.isArray(parsed)) return handleOne(parsed, ctx)
  if (parsed.length === 0) return INVALID
  const replies: Response[] = []
  for (const item of parsed) {
    const r = await handleOne(item, ctx)
    if (r !== null) replies.push(r)
  }
  return replies.length === 0 ? null : replies
}

async function handleOne(parsed: unknown, ctx: ToolContext): Promise<Response | null> {
  // Valid JSON that is not a request object (`null`, `5`) is an invalid
  // request. Read as one, `null` threw outside every catch and ended the
  // session: the next request was never answered (item 808).
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return INVALID
  const msg = parsed as Request
  // JSON-RPC 2.0's envelope: `jsonrpc` is exactly "2.0" and an id is a
  // string, a number or null. A missing or "1.0" version and an object or
  // boolean id were answered as valid requests, the bad id echoed back
  // (item 1067); an id that is no id is answered as none.
  const idOk =
    msg.id === undefined ||
    msg.id === null ||
    typeof msg.id === 'string' ||
    typeof msg.id === 'number'
  const id = idOk ? (msg.id ?? null) : null
  if (msg.jsonrpc !== '2.0' || !idOk || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid request' } }
  }
  // A notification carries no id and expects no reply.
  const isNotification = msg.id === undefined
  const reply = (result: unknown): Response | null =>
    isNotification ? null : { jsonrpc: '2.0', id, result }
  // Errors too: JSON-RPC 2.0 never answers a notification, and a bad tool
  // name or a tool's crash was answered with `id: null` (item 925).
  const fail = (code: number, message: string, data?: unknown): Response | null =>
    isNotification
      ? null
      : { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
  const meta = msg.params?.['_meta']
  const asked =
    meta !== null && typeof meta === 'object'
      ? (meta as Record<string, unknown>)[VERSION_KEY]
      : undefined
  // Named but not ours (or not a string): the spec's error, listing what is.
  if (asked !== undefined && (typeof asked !== 'string' || !STATELESS_VERSIONS.has(asked))) {
    return fail(UNSUPPORTED_PROTOCOL_VERSION, 'unsupported protocol version', {
      supported: SUPPORTED_VERSIONS,
      requested: asked,
    })
  }
  const stateless = asked !== undefined
  const instructions =
    ctx.run === false
      ? 'Read-only view of this workspace’s vx cache and run history. Nothing here runs a task.'
      : 'This workspace’s vx tasks, cache and run history. runTasks runs tasks; every other tool only reads.'
  const serverInfo = { name: 'vx', version: VERSION }
  // A stateless revision's result says it is complete and who answered.
  const answer = (result: Record<string, unknown>): Response | null =>
    reply(
      stateless
        ? {
            ...result,
            resultType: 'complete',
            _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
          }
        : result,
    )
  // The tools differ by workspace and by --read-only: never shared across contexts.
  const cacheable = { ttlMs: 0, cacheScope: 'private' }
  // The handshake and `ping` are gone from the stateless revisions.
  if (stateless && (msg.method === 'initialize' || msg.method === 'ping')) {
    return fail(-32601, `method not found: ${msg.method}`)
  }
  try {
    switch (msg.method) {
      // Any client may probe with it, before choosing a revision (stdio's backward-compatibility check).
      case 'server/discover':
        return reply({
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          instructions,
          ...cacheable,
          resultType: 'complete',
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        })
      case 'initialize': {
        const version = msg.params?.['protocolVersion']
        const protocolVersion =
          typeof version === 'string' && KNOWN_VERSIONS.has(version) ? version : PROTOCOL_VERSION
        return reply({
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo,
          instructions,
        })
      }
      case 'ping':
        return reply({})
      case 'tools/list':
        return answer({ tools: listTools(ctx), ...(stateless ? cacheable : {}) })
      case 'tools/call': {
        const name = msg.params?.['name']
        if (typeof name !== 'string') return fail(-32602, 'tools/call: name must be a string')
        // Both are the call's shape, not a tool's answer: the spec lists an
        // unknown tool as -32602, and `arguments` is an object or absent. A
        // string or an array was read as no arguments and answered the full
        // unfiltered history (item 1067).
        if (!listTools(ctx).some((t) => t.name === name)) {
          return fail(-32602, `tools/call: unknown tool: ${name}`)
        }
        const args = msg.params?.['arguments']
        if (
          args !== undefined &&
          (args === null || typeof args !== 'object' || Array.isArray(args))
        ) {
          return fail(-32602, 'tools/call: arguments must be an object')
        }
        try {
          const result = await handleToolCall(name, args, ctx)
          return answer({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
        } catch (err) {
          // A tool's own refusal is a RESULT the agent should read, not a
          // protocol error: it names what to fix ("taskId must be …"). By
          // name, not instanceof: inside a compiled vx the tools' core and
          // this plugin's `@vzn/vx` can be two copies of the same class.
          // Masked, as the CLI masks the error it ends on: a config's
          // refusal quotes the config's own strings, and the agent is
          // often a remote model (L-11).
          if (isUserError(err)) {
            return answer({
              content: [{ type: 'text', text: maskedLine(err.message) }],
              isError: true,
            })
          }
          throw err
        }
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`)
    }
  } catch (err) {
    return fail(-32603, maskedLine(err instanceof Error ? err.message : String(err)))
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
  const out = (r: Response | Response[]): void => {
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

/**
 * Serve stdin → stdout until stdin closes. Stdout IS the JSON-RPC stream, and
 * a tool that loads the workspace evaluates configs and plugin stages, whose
 * `console.log` landed in it: a strict client drops a connection on a line
 * that is not JSON-RPC (item 922). The server keeps the real writer; every
 * other stdout write and console method goes to stderr while it serves.
 * Bun's `console.log` writes to fd 1 without `process.stdout.write`, so the
 * console is replaced too, and so are Bun's own routes to it:
 * `Bun.write(Bun.stdout, …)` and `Bun.stdout.writer()` reached the stream
 * past both (item 1069). A process a config spawns with fd 1 inherited
 * still writes there; nothing short of the descriptor itself reaches it.
 */
export async function serveStdio(options: ServerOptions): Promise<void> {
  const stdout = process.stdout
  const write = stdout.write.bind(stdout)
  const ownWrite = stdout.write
  const ownConsole = globalThis.console
  const bun = Bun as { write: typeof Bun.write }
  const ownBunWrite = Bun.write
  const bunStdout = Bun.stdout as { writer: typeof Bun.stdout.writer }
  const ownWriter = Object.getOwnPropertyDescriptor(Bun.stdout, 'writer')
  bun.write = ((dest: unknown, ...rest: unknown[]) =>
    (ownBunWrite as (...a: unknown[]) => Promise<number>)(
      dest === Bun.stdout ? Bun.stderr : dest,
      ...rest,
    )) as typeof Bun.write
  bunStdout.writer = ((...args: Parameters<typeof Bun.stderr.writer>) =>
    Bun.stderr.writer(...args)) as typeof Bun.stdout.writer
  stdout.write = ((...args: Parameters<typeof process.stderr.write>) =>
    process.stderr.write(...args)) as typeof stdout.write
  // Bun's console adds `write`, which the node Console lacks.
  globalThis.console = Object.assign(new Console(process.stderr, process.stderr), {
    write: (...data: string[]) => {
      const text = data.join('')
      process.stderr.write(text)
      return text.length
    },
  })
  try {
    await serve(Bun.stdin.stream(), (line) => write(line), options)
  } finally {
    stdout.write = ownWrite
    globalThis.console = ownConsole
    bun.write = ownBunWrite
    if (ownWriter === undefined) delete (bunStdout as { writer?: unknown }).writer
    else Object.defineProperty(Bun.stdout, 'writer', ownWriter)
  }
}
