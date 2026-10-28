// A deferred producer's fetch-and-save passed no workspace root, so a link
// the eager save keeps (`dist/x -> ../../../shared/x.txt`, inside the
// workspace) was refused as "outside the workspace" and its consumer failed.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import type { TaskNode } from '../src/graph/index.js'
import { DeferredOutputs } from '../src/orchestrator/deferred-outputs.js'
import { saveMiss } from '../src/orchestrator/miss-save.js'

it('a fetched deferred output keeps a link the eager save keeps', async () => {
  const ws = mkdtempSync(path.join(tmpdir(), 'vx-deferred-link-'))
  try {
    const projectDir = path.join(ws, 'packages', 'app')
    mkdirSync(path.join(ws, 'shared'), { recursive: true })
    writeFileSync(path.join(ws, 'shared', 'x.txt'), 'x')
    mkdirSync(projectDir, { recursive: true })
    const write = () => {
      mkdirSync(path.join(projectDir, 'dist'), { recursive: true })
      rmSync(path.join(projectDir, 'dist', 'x'), { force: true })
      symlinkSync('../../../shared/x.txt', path.join(projectDir, 'dist', 'x'))
    }
    const producer = {
      id: 'app#build',
      projectName: 'app',
      taskName: 'build',
      projectDir,
      deps: [],
      config: { exec: { command: 'true' }, cache: { outputs: { files: ['dist/**'] } } },
    } as unknown as TaskNode
    const consumer = {
      ...producer,
      id: 'app#use',
      taskName: 'use',
      deps: ['app#build'],
    } as unknown as TaskNode
    const cache = new Cache(path.join(ws, '.vx', 'cache'))
    write()
    const { landed } = await saveMiss({
      node: producer,
      hash: 'eager',
      cache,
      log: { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} } as never,
      workspaceRoot: ws,
      nestedProjectDirs: [],
      outputs: ['dist/**'],
      wsOutputs: [],
      captured: [],
      command: 'true',
      durationMs: 1,
      stdout: '',
    })
    expect((await landed).saved).toBe(true)
    const deferred = new DeferredOutputs({
      nodes: new Map([
        [producer.id, producer],
        [consumer.id, consumer],
      ]),
      cache,
      workspaceRoot: ws,
      nestedDirsByProject: new Map(),
      localWrite: true,
    })
    deferred.register(producer.id, {
      materialize: async () => write(),
      hash: 'deferred',
      entry: { taskId: producer.id, command: 'true', durationMs: 1, stdout: '' },
    })
    await deferred.materializeFor(consumer)
    expect(deferred.pending()).toEqual([])
    expect(await cache.get('deferred')).not.toBeNull()
    cache.close()
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
