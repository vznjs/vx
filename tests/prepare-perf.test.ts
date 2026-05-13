// Tests for `prepareRun`'s perf-related behaviors: parallel project
// config loading + the git-files cache plumbed into PreparedRun.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { prepareRun } from '../src/orchestrator/prepare.ts'
import { defaultLogger } from '../src/orchestrator/logger.ts'

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-prepare-perf-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
  await mkdir(path.join(root, 'packages'), { recursive: true })
  return root
}

async function addProject(root: string, name: string): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
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
      expect(prepared.projects.size).toBe(5)
      for (const n of ['a', 'b', 'c', 'd', 'e']) {
        expect(prepared.projects.has(n)).toBe(true)
        expect(prepared.projects.get(n)?.config.tasks?.build).toBeDefined()
      }
    } finally {
      prepared.cache.close()
    }
  })

  it('exposes a fresh `gitFilesCache` Map (empty at start of run)', async () => {
    await addProject(root, 'pkg')
    const prepared = await prepareRun({ cwd: root, tasks: ['build'] }, log)
    try {
      expect(prepared.gitFilesCache).toBeInstanceOf(Map)
      expect(prepared.gitFilesCache.size).toBe(0)
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
      expect(prepared.projects.has('configured')).toBe(true)
      expect(prepared.projects.has('bare')).toBe(false)
    } finally {
      prepared.cache.close()
    }
  })
})
