// A deferred producer whose fetch put nothing under its declared outputs
// was saved as an empty artifact in silence, so the next run "restored" 0 B
// as a hit; the eager save warns on the same tree.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import type { TaskNode } from '../src/graph/index.js'
import { DeferredOutputs } from '../src/orchestrator/deferred-outputs.js'

async function fetchDeferred(write: (projectDir: string) => void): Promise<string[]> {
  const ws = mkdtempSync(path.join(tmpdir(), 'vx-deferred-empty-'))
  try {
    const projectDir = path.join(ws, 'app')
    mkdirSync(projectDir, { recursive: true })
    const producer = {
      id: 'app#build',
      projectName: 'app',
      taskName: 'build',
      projectDir,
      deps: [],
      config: { exec: { command: 'true' }, outputs: { files: ['dist/**'] }, cache: true },
    } as unknown as TaskNode
    const consumer = { ...producer, id: 'app#use', deps: ['app#build'] } as unknown as TaskNode
    const cache = new Cache(path.join(ws, '.vx', 'cache'))
    const warnings: string[] = []
    const deferred = new DeferredOutputs({
      nodes: new Map([
        [producer.id, producer],
        [consumer.id, consumer],
      ]),
      cache,
      workspaceRoot: ws,
      nestedDirsByProject: new Map(),
      localWrite: true,
      log: { status() {}, warn: (line: string) => void warnings.push(line) } as never,
    })
    deferred.register(producer.id, {
      materialize: async () => write(projectDir),
      hash: 'deferred',
      entry: { taskId: producer.id, command: 'true', durationMs: 1, stdout: '' },
    })
    await deferred.materializeFor(consumer)
    expect(await cache.get('deferred')).not.toBeNull()
    cache.close()
    return warnings
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

it('a deferred fetch that lands no output warns as the eager save does', async () => {
  expect(await fetchDeferred(() => {})).toEqual([
    '[vx] app#build: outputs matched no files (dist/**) — an empty artifact is saved; a later hit restores nothing',
  ])
})

it('a deferred fetch that lands its outputs says nothing', async () => {
  const write = (projectDir: string) => {
    mkdirSync(path.join(projectDir, 'dist'), { recursive: true })
    writeFileSync(path.join(projectDir, 'dist', 'out.txt'), 'x')
  }
  expect(await fetchDeferred(write)).toEqual([])
})
