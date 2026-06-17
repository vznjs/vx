// Run → `vx dev` forwarding. A `vx run` checks for a live hub socket and,
// if present, forwards its events there. The IRON RULE: this can never
// block, slow, or fail a run. Every failure mode — no hub, stale socket,
// hub crashed, a write error mid-run — degrades silently to "no
// forwarding" and the run proceeds exactly as it would without `vx dev`.

import { existsSync } from 'node:fs'
import { findWorkspaceRoot } from '../workspace/index.js'
import { devSocketPath } from './dev.js'

export interface DevForwarder {
  /** Fire-and-forget NDJSON line write; swallows its own failures. */
  write: (line: string) => void
  close: () => Promise<void>
}

/**
 * Connect to a running `vx dev` hub for this workspace, or return null if
 * none is reachable. Gated on the socket file existing (a cheap stat) so
 * the common no-hub case never even attempts a connect.
 */
export async function connectDevForwarder(cwd: string): Promise<DevForwarder | null> {
  let sockPath: string
  try {
    sockPath = devSocketPath(await findWorkspaceRoot(cwd))
  } catch {
    return null
  }
  // No socket file → no hub. Skip the connect entirely (the common path).
  // NB: `Bun.file().exists()` is false for socket files — use fs.existsSync.
  if (!existsSync(sockPath)) return null

  let socket: Awaited<ReturnType<typeof Bun.connect>>
  try {
    socket = await Bun.connect({
      unix: sockPath,
      socket: { data() {}, open() {}, close() {}, error() {} },
    })
  } catch {
    // Stale socket (hub crashed) or refused — forward nothing.
    return null
  }

  return {
    write: (line) => {
      try {
        socket.write(line)
      } catch {
        // dropped chunk — never propagate to the run
      }
    },
    close: async () => {
      try {
        socket.end()
      } catch {
        // already closed
      }
    },
  }
}
