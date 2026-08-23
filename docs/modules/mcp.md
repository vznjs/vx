# `src/cli/mcp.ts` (+ `mcp-rpc.ts`) — Model Context Protocol server

## Purpose

`vx mcp` exposes vx as a typed tool surface to AI agents (Claude Code,
Cursor, …) over stdio: workspace/task introspection, run history and
cache queries dispatched through internal JSON-RPC methods (the same
envelope the wire protocol commits to).

## Invariants

- stdio transport for `vx mcp`.
- Reports the real `VERSION`; read-only against cache.db.
