// Tests for `prepareRun`'s perf-related behaviors: parallel project
// config loading + the git-files cache plumbed into PreparedRun.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import {
  addProject as addProjectTo,
  makeWorkspace as makeWorkspaceRoot,
} from './helpers/workspace.js'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { prepareRun } from './helpers/orchestrator.js'
import { defaultLogger } from '../src/report/logger.ts'

function makeWorkspace(): Promise<string> {
  return makeWorkspaceRoot({ prefix: 'vx-prepare-perf-', rootName: 'root' })
}

async function addProject(root: string, name: string): Promise<void> {
  await addProjectTo(
    root,
    name,
    `export default { tasks: { build: { exec: { command: 'echo ${name}' } } } }`,
  )
}

describe('prepareRun perf surface', () => {
  let root: string
  let log: ReturnType<typeof defaultLogger>

  beforeEach(async () => {
    root = await makeWorkspace()
    log = defaultLogger({ enabled: false })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('loads project configs in parallel (Promise.all) — all configs visible after one prepareRun', async () => {
    for (const n of ['a', 'b', 'c', 'd', 'e']) await addProject(root, n)
    const prepared = await prepareRun({ cwd: root, tasks: ['build'] }, log)
    try {
      // After parallel config load, the task graph should contain a
      // `<name>#build` node for every project that declared the task.
      expect(prepared.nodes.size).toBe(5)
      for (const n of ['a', 'b', 'c', 'd', 'e']) {
        expect(prepared.nodes.has(`${n}#build`)).toBe(true)
      }
    } finally {
      prepared.cache.close()
    }
  })

  it('exposes a `gitFilesCache` Map pre-populated by a single bulk git ls-files', async () => {
    // Bulk-population (one `git ls-files` at workspace root, partitioned
    // by project) gives every project a cache entry up-front — saves
    // one fork+exec per project on the cache-hit path. When the
    // workspace isn't a git repo, the value is `null` and resolveFiles
    // falls back to the Bun.Glob walker.
    await addProject(root, 'pkg')
    const prepared = await prepareRun({ cwd: root, tasks: ['build'] }, log)
    try {
      expect(prepared.gitFilesCache).toBeInstanceOf(Map)
      // One entry per project (the fixture has just 'pkg').
      expect(prepared.gitFilesCache.size).toBe(1)
      const pkgDir = path.join(root, 'packages', 'pkg')
      expect(prepared.gitFilesCache.has(pkgDir)).toBe(true)
    } finally {
      prepared.cache.close()
    }
  })

  it('handles a package without vx.config.* (no parallel-Promise.all crash)', async () => {
    // Regression: the parallel-load path filters out projects that
    // have no configPath; we still successfully prepare with the
    // remaining configured projects.
    await addProject(root, 'configured')
    const bareDir = path.join(root, 'packages', 'bare')
    await mkdir(bareDir, { recursive: true })
    await writeFile(
      path.join(bareDir, 'package.json'),
      JSON.stringify({ name: 'bare', version: '0.0.0' }),
    )
    // Intentionally no vx.config.* in 'bare'.

    const prepared = await prepareRun({ cwd: root, tasks: ['build'] }, log)
    try {
      // Configured project has a node; bare project has no vx.config
      // so it never enters the graph.
      expect(prepared.nodes.has('configured#build')).toBe(true)
      expect(prepared.nodes.has('bare#build')).toBe(false)
    } finally {
      prepared.cache.close()
    }
  })
})
