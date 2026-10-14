// The orchestrator end-to-end fixture, shared by the two halves of the
// suite (`orchestrator.test.ts`, `orchestrator-run.test.ts`) and the
// remote-cache suite (`orchestrator-remote.test.ts`): a workspace
// with a git repo, a logger that records status lines and per-task bodies,
// the two policy shapes the CLI flags resolve to, and a stamp command whose
// output changes on every real execution.

import type { Logger } from '../../src/orchestrator/index.js'
import type { EdgeMap } from './plugin.js'
import { makeWorkspace as makeWorkspaceRoot } from './workspace.js'

export { addProject } from './workspace.js'

export interface Fixture {
  root: string
  log: string[]
  err: string[]
}

export const TIMEOUT = 30_000

/** The 4-axis policy for `--no-cache`: everything off. */
export const NO_CACHE = {
  localRead: false,
  localWrite: false,
  remoteRead: false,
  remoteWrite: false,
} as const

/** `--force`: skip reads, keep writes (re-execute + refresh the cache). */
export const FORCE = {
  localRead: false,
  localWrite: true,
  remoteRead: false,
  remoteWrite: true,
} as const

export const silentLogger = (fixture: Fixture): Logger => {
  const buffers = new Map<string, string>()
  return {
    status(line) {
      fixture.log.push(line)
    },
    taskStdout(node, chunk) {
      buffers.set(node.id, (buffers.get(node.id) ?? '') + chunk)
    },
    taskStderr(node, chunk) {
      fixture.err.push(chunk.trimEnd())
      buffers.set(node.id, (buffers.get(node.id) ?? '') + chunk)
    },
    taskComplete(node, outcome) {
      const body = buffers.get(node.id) ?? ''
      buffers.delete(node.id)
      // Callers that grep `fixture.log` for the id (the only way they used
      // to detect task progress) keep working without coupling to the
      // exact framed-output format.
      fixture.log.push(`task ${node.id} ${outcome.status}`)
      if (body.trim().length > 0) fixture.log.push(body.trimEnd())
    },
  }
}

/** `edges`: project edges by name, from the `edges()` test plugin (`makeWorkspace` in workspace.ts). */
export async function makeWorkspace(prefix = 'nxt-e2e-', edges?: EdgeMap): Promise<Fixture> {
  const root = await makeWorkspaceRoot(edges === undefined ? { prefix } : { prefix, edges })
  return { root, log: [], err: [] }
}

export const STAMP_CMD = `node -e 'process.stdout.write(String(Date.now()))' > out.txt`
