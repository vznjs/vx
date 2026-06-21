// `vx mcp` — Model Context Protocol server adapter.
//
// Exposes vx as a typed tool surface to AI agents (Claude Code, Cursor,
// Continue.dev, etc.). The MCP envelope is JSON-RPC 2.0 — the same
// envelope wire-protocol-2026-06.md commits to — so this adapter is a
// thin mapping layer: MCP tool calls dispatch to internal RPC methods.
//
// stdio transport in v1: every relevant agent client runs servers over
// stdio. Streamable HTTP is a follow-up; the SDK supports both, dispatch
// is identical, only the transport object changes.
//
// Tools exposed:
//   runTasks(tasks: string[], cwd?: string)
//   getCacheStats(scope?: 'all' | { project: string })
//   getRunHistory({ project?, task?, limit? })
//   explainCacheKey(taskId)
//   whyDidThisRerun({ runId, taskId })
//
// The implementations live in `src/cli/mcp-rpc.ts` so a future WS-side
// inspector can reuse them without duplicating logic.

import { UserError } from '../util/index.js'
import { handleMcpRequest, listMcpTools, type McpToolDef } from './mcp-rpc.js'

export interface McpArgs {
  /** stdio (default) | http (deferred to a follow-up) */
  transport: 'stdio'
}

export function parseMcpArgs(args: readonly string[]): McpArgs {
  for (const a of args) {
    if (a === '--http') {
      throw new UserError('vx mcp --http is not yet implemented; use stdio (default)')
    }
    if (a !== '--stdio') {
      throw new UserError(`vx mcp: unknown flag ${a}`)
    }
  }
  return { transport: 'stdio' }
}

export async function mcpCmd(args: readonly string[]): Promise<number> {
  parseMcpArgs(args) // validate flags; defaults to stdio
  let StdioServerTransport: any
  let McpServer: any
  try {
    const sdkServer = await import('@modelcontextprotocol/sdk/server/index.js')
    const sdkStdio = await import('@modelcontextprotocol/sdk/server/stdio.js')
    McpServer = (sdkServer as { Server: any }).Server
    StdioServerTransport = (sdkStdio as { StdioServerTransport: any }).StdioServerTransport
  } catch (err) {
    throw new UserError(
      `vx mcp requires @modelcontextprotocol/sdk to be installed. ` +
        `Add it to your package.json or install with: bun add @modelcontextprotocol/sdk`,
    )
  }

  const server = new McpServer(
    { name: 'vx', version: '0.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  )

  // Tool listing
  const sdkTypes = await import('@modelcontextprotocol/sdk/types.js')
  server.setRequestHandler(
    (sdkTypes as { ListToolsRequestSchema: any }).ListToolsRequestSchema,
    async () => ({
      tools: listMcpTools().map((t: McpToolDef) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }),
  )

  // Tool call dispatch
  server.setRequestHandler(
    (sdkTypes as { CallToolRequestSchema: any }).CallToolRequestSchema,
    async (req: { params: { name: string; arguments?: unknown } }) => {
      const result = await handleMcpRequest(req.params.name, req.params.arguments)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  await new Promise(() => undefined) // run until stdin closes
  return 0
}
