// The fixture the sandbox-*.unsafe test files share: a workspace, the log
// its tasks write, and the checks that read it.

import path from 'node:path'
import { type RunSummary } from '../../src/orchestrator/index.js'
import { type Logger } from '../../src/report/index.js'
import { makeWorkspace as makeWorkspaceRoot } from './workspace.js'
import { type EdgeMap } from './plugin.js'

export const TIMEOUT = 60_000

export interface Fixture {
  root: string
  log: string[]
}

/**
 * `expectOk(r, fixture)` with the task's own output in the failure: a
 * sandboxed task that fails on CI only (a bubblewrap or seccomp error on
 * the runner) otherwise leaves nothing in the log but `Received: false`.
 */
export function expectOk(r: RunSummary, fixture: Fixture): void {
  if (r.ok) return
  const exits = r.outcomes.map((o) => `${o.node.id} ${o.status} exit=${o.exitCode}`).join(', ')
  throw new Error(`run was not ok (${exits}); task output:\n${fixture.log.join('\n')}`)
}

// Where a traced task's log lives: the task root in the sandbox runtime's
// temp dir, which every sandbox replaces with its own (L-25).
export function taskRoot(env: NodeJS.ProcessEnv = process.env): string {
  const named = env['CLAUDE_CODE_TMPDIR'] ?? env['CLAUDE_TMPDIR']
  return path.join(named !== undefined && named !== '' ? named : '/tmp/claude', 'vx-tasks')
}

export const collectingLogger = (fixture: Fixture): Logger => ({
  status(line) {
    fixture.log.push(line)
  },
  taskStdout(_node, chunk) {
    fixture.log.push(chunk.trimEnd())
  },
  taskStderr(_node, chunk) {
    fixture.log.push(chunk.trimEnd())
  },
  taskComplete(node, outcome) {
    fixture.log.push(`task ${node.id} ${outcome.status}`)
  },
})

export async function makeWorkspace(edges?: EdgeMap): Promise<Fixture> {
  const root = await makeWorkspaceRoot(
    edges === undefined ? { prefix: 'vx-sandbox-' } : { prefix: 'vx-sandbox-', edges },
  )
  return { root, log: [] }
}
