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
// and server.ts is about 210 lines — a number a test holds to the file.

import { definePlugin, type VxPlugin } from '@vzn/vx'

export function mcp(): VxPlugin {
  return definePlugin(import.meta, {
    commands: {
      mcp: {
        description: 'serve cache stats + run history to AI agents (MCP over stdio)',
        async run(argv, ctx) {
          // A plugin verb owns its help; completions offer `--help` for every verb.
          if (argv.includes('--help') || argv.includes('-h')) {
            process.stdout.write(
              "Usage: vx mcp [--stdio]\n\nServe this workspace's cache stats and run history to an AI agent: MCP over stdio, read-only.\n",
            )
            return 0
          }
          for (const a of argv) {
            if (a !== '--stdio') {
              ctx.warn(`vx mcp: unknown flag ${a} (only --stdio, the default, is supported)`)
              return 1
            }
          }
          // Loaded by the verb alone: every run evaluates the workspace config,
          // and the server's modules cost it ~12 ms there.
          const { serveStdio } = await import('./server.js')
          await serveStdio({ cacheDir: ctx.cacheDir, workspaceRoot: ctx.workspaceRoot })
          return 0
        },
      },
    },
  })
}
