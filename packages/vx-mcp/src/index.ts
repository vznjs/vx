// `@vzn/vx-mcp` — a Model Context Protocol server as a vx plugin.
//
//   import { defineWorkspace } from '@vzn/vx'
//   import { mcp } from '@vzn/vx-mcp'
//   export default defineWorkspace({ plugins: [mcp(), …] })
//
// Declaring it adds `vx mcp` (the `commands` seam): a JSON-RPC 2.0 server
// over stdio that AI coding agents speak natively, exposing READ-ONLY tools
// over the workspace's local cache.db — the same queries `vx why`,
// `vx last` and `vx info` read. `listTools` is how many and which; a count
// here is the same second copy the tool list was, and it had drifted to
// "four" of six. Nothing here can run a task or write the cache; a plugin
// that could would be an executor, and this is not one.
//
// No SDK: MCP over stdio is newline-delimited JSON-RPC and the methods
// `initialize`, `tools/list`, `tools/call` and `ping`. It pulls in nothing
// where the reference SDK pulls in an HTTP stack this transport never uses,
// and server.ts is about 150 lines — a number a test holds to the file.

import { definePlugin, type VxPlugin } from '@vzn/vx'
import { serveStdio } from './server.js'

export function mcp(): VxPlugin {
  return definePlugin(import.meta, {
    commands: {
      mcp: {
        description: 'serve cache stats + run history to AI agents (MCP over stdio)',
        async run(argv, ctx) {
          for (const a of argv) {
            if (a !== '--stdio') {
              ctx.warn(`vx mcp: unknown flag ${a} (only --stdio, the default, is supported)`)
              return 1
            }
          }
          await serveStdio({ cacheDir: ctx.cacheDir, workspaceRoot: ctx.workspaceRoot })
          return 0
        },
      },
    },
  })
}
