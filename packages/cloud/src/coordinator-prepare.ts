// Distributed-CI helper — adapt prepareRun for the coordinator role.
// The coordinator builds the same graph the local CLI does, then
// per-node computes the cache key used as the assignment hash.
// Workers receive only the resolved descriptor + the hash.

import { prepareRun, computeTaskHash, type PreparedRun, type TaskNode } from '@vzn/vx'

const silentLogger = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

export async function prepareForCoordinator(
  workspaceRoot: string,
  tasks: readonly string[],
): Promise<PreparedRun> {
  return await prepareRun(
    {
      cwd: workspaceRoot,
      tasks: [...tasks],
    },
    silentLogger,
  )
}

/**
 * Compute the cache key for a node in coordinator context — no upstream
 * outcomes yet (those land as workers finish), no forwardArgs (the
 * coordinator submits per-task assignments, not the full RunOptions).
 */
export async function computeTaskHashForCoord(
  node: TaskNode,
  prepared: PreparedRun,
): Promise<string> {
  // Coordinator dispatch ordering: compute the hash with empty
  // upstream outcomes (the first task to assign has no upstream;
  // downstream tasks fold their upstream hash via the same path the
  // local executor uses; we replicate that mapping when we have the
  // outcomes in hand). For v1, we use a stable per-node key based on
  // inputs only — enough for assignment and dedup; full transitive
  // folding is the next iteration.
  return await computeTaskHash({
    node,
    upstream: [],
    workspaceRoot: prepared.workspaceRoot,
    workspaceFingerprint: prepared.workspaceFingerprint,
    cache: prepared.cache,
    nestedProjectDirs: prepared.nestedDirsByProject.get(node.id) ?? [],
    gitFilesCache: prepared.gitFilesCache,
    hashCache: prepared.hashCache,
  })
}
