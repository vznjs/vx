// Unit tests for the restore-tier stability gate. `dependsOnSiblingOutputs`
// decides whether a task's cache key is provably independent of any upstream's
// OUTPUTS — a wrong "stable" verdict is a stale-hit vector, because execute-task
// reuses a preProbed hash WITHOUT recomputing. `deriveStableKeys` feeds it the
// TRANSITIVE-upstream output producers (a producer reached through a no-output
// intermediate still poisons the key), which these cases exercise directly.

import { describe, expect, it } from 'bun:test'
import { dependsOnSiblingOutputs, workspaceInputsReach } from '../src/orchestrator/stable-keys.js'
import type { TaskNode } from '../src/graph/index.js'

const node = (
  project: string,
  cache: { files?: string[]; workspaceFiles?: string[] } | undefined,
): TaskNode =>
  ({
    projectName: project,
    config:
      cache === undefined
        ? {}
        : {
            cache: {
              inputs: { files: cache.files ?? ['**'], workspaceFiles: cache.workspaceFiles ?? [] },
              outputs: { files: [] },
            },
          },
  }) as unknown as TaskNode

describe('dependsOnSiblingOutputs — restore-tier stability gate', () => {
  it('a cache-disabled task is never gated here (caller filters on cacheEnabled)', () => {
    expect(dependsOnSiblingOutputs(node('B', undefined), new Set(['B']), true)).toBe(false)
  })

  it('a project-relative reader with a same-project outputs.files producer upstream → unstable', () => {
    // Direct or TRANSITIVE: `outputProjects ∋ own project` is all that matters.
    expect(dependsOnSiblingOutputs(node('B', { files: ['**'] }), new Set(['B']), false)).toBe(true)
  })

  it('a project-relative reader whose only upstream producer is ANOTHER project → STABLE', () => {
    // Project boundaries are hard: pkg-A's outputs.files land in pkg-A's dir,
    // which pkg-B's project-relative `**` cannot read. Must NOT over-mark — this
    // is the common-case optimization (cross-project build → test).
    expect(dependsOnSiblingOutputs(node('B', { files: ['**'] }), new Set(['A']), false)).toBe(false)
  })

  it('a workspaceFiles reader with ANY cross-project outputs.files producer upstream → unstable', () => {
    // A boundary-free ws-glob can reach into any project's dir.
    expect(
      dependsOnSiblingOutputs(
        node('B', { files: [], workspaceFiles: ['packages/a/**'] }),
        new Set(['A']),
        false,
      ),
    ).toBe(true)
  })

  it('a workspaceFiles reader with only an outputs.workspaceFiles producer upstream → unstable', () => {
    // Root-anchored outputs (no outputs.files anywhere) are carried by the
    // separate hasWsOutputUpstream boolean.
    expect(
      dependsOnSiblingOutputs(
        node('B', { files: [], workspaceFiles: ['shared/**'] }),
        new Set<string>(),
        true,
      ),
    ).toBe(true)
  })

  it('a PROJECT-RELATIVE reader with an outputs.workspaceFiles producer upstream → unstable', () => {
    // The asymmetry that produced a real stale hit. A root-anchored output is
    // boundary-IGNORING by design, so it can land inside THIS task's own
    // project dir — where an ordinary project-relative `**` reads it. Neither
    // of the other two clauses sees that: `upstreamOutputProjects` holds the
    // PRODUCER's project, not this one, and the workspace-reader clause needs
    // this task to read workspace-anchored inputs, which it does not.
    //
    // So `hasWsOutputUpstream` alone has to make the key preliminary,
    // regardless of how this task reads. That is the conservative direction
    // the gate's own contract demands ("when in doubt, unstable"), and it
    // matches the graph-wide restore-tier disable that already exists for
    // exactly this escape hatch.
    expect(dependsOnSiblingOutputs(node('B', { files: ['**'] }), new Set(['A']), true)).toBe(true)
    // Even with NO outputs.files producer anywhere upstream.
    expect(dependsOnSiblingOutputs(node('B', { files: ['**'] }), new Set<string>(), true)).toBe(
      true,
    )
  })

  it('a task with no output producers upstream at all → STABLE', () => {
    expect(dependsOnSiblingOutputs(node('B', { files: ['**'] }), new Set<string>(), false)).toBe(
      false,
    )
    expect(
      dependsOnSiblingOutputs(
        node('B', { files: ['**'], workspaceFiles: ['x/**'] }),
        new Set<string>(),
        false,
      ),
    ).toBe(false)
  })
})

describe('workspaceInputsReach — a workspace reader against its producers', () => {
  it('a root literal reaches no package; a package-tree glob reaches that package', () => {
    expect(workspaceInputsReach(['turbo.json'], ['packages/a', 'packages/b'])).toBe(false)
    expect(workspaceInputsReach(['tsconfig.base.json', '!README.md'], ['packages/a'])).toBe(false)
    expect(workspaceInputsReach(['packages/a/src/**'], ['packages/a'])).toBe(true)
    expect(workspaceInputsReach(['packages/a/src/**'], ['packages/b'])).toBe(false)
    // An ancestor literal reaches everything under it; a bare glob everything.
    expect(workspaceInputsReach(['packages'], ['packages/a'])).toBe(true)
    expect(workspaceInputsReach(['packages/**'], ['packages/a'])).toBe(true)
    expect(workspaceInputsReach(['**/*.md'], ['packages/a'])).toBe(true)
    expect(workspaceInputsReach(['{packages,apps}/**'], ['packages/a'])).toBe(true)
    // A producer at the workspace root is reachable by anything.
    expect(workspaceInputsReach(['turbo.json'], ['.'])).toBe(true)
    // Negations never reach.
    expect(workspaceInputsReach(['!packages/a/**'], ['packages/a'])).toBe(false)
  })

  it('the gate uses the reach when it knows the dirs, and stays conservative when it does not', () => {
    const dirs = new Map([
      ['A', 'packages/a'],
      ['B', 'packages/b'],
    ])
    const reader = node('A', { workspaceFiles: ['turbo.json'] })
    // Old answer without dirs: any producer upstream → preliminary.
    expect(dependsOnSiblingOutputs(reader, new Set(['B']), false)).toBe(true)
    // With dirs: a root literal cannot see packages/b → stable.
    expect(dependsOnSiblingOutputs(reader, new Set(['B']), false, dirs)).toBe(false)
    // A glob into the producer's tree is still preliminary.
    const treeReader = node('A', { workspaceFiles: ['packages/b/dist/**'] })
    expect(dependsOnSiblingOutputs(treeReader, new Set(['B']), false, dirs)).toBe(true)
    // A producer whose dir is unknown keeps the conservative answer.
    expect(dependsOnSiblingOutputs(reader, new Set(['C']), false, dirs)).toBe(true)
    // The other clauses are untouched: same-project producer, workspace-output producer.
    expect(dependsOnSiblingOutputs(reader, new Set(['A']), false, dirs)).toBe(true)
    expect(dependsOnSiblingOutputs(reader, new Set(['B']), true, dirs)).toBe(true)
  })
})
