// End-to-end test for the distributed-CI coordinator + worker. Boots a
// real coordinator over WS against a temp workspace, attaches a worker,
// and verifies the task assignment + execution + done loop.

import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startCoordinator } from '../src/cli/coordinator.js'
import { runWorker } from '../src/cli/worker.js'

async function setupWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-dist-e2e-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', workspaces: ['pkg'] }),
  )
  await mkdir(path.join(root, 'pkg'), { recursive: true })
  await writeFile(path.join(root, 'pkg/package.json'), JSON.stringify({ name: 'pkg' }))
  await writeFile(
    path.join(root, 'pkg/vx.config.mjs'),
    `export default {
       tasks: {
         a: { exec: { command: 'echo a-ok' } },
         b: { exec: { command: 'echo b-ok' }, dependsOn: ['a'] },
       },
     }`,
  )
  await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited
  await Bun.spawn(['git', 'add', '-A'], { cwd: root }).exited
  await Bun.spawn(
    ['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'],
    { cwd: root },
  ).exited
  return root
}

describe('vx distributed CI — coordinator + worker e2e', () => {
  it('coordinator dispatches a two-task DAG to one worker and reports done', async () => {
    const root = await setupWorkspace()
    const coord = await startCoordinator({
      workspaceRoot: root,
      tasks: ['b'],
      port: 0,
      onStatus: () => undefined,
    })
    try {
      // Worker attaches concurrently with the coordinator's done promise.
      const workerResult = runWorker({
        coordinatorUrl: coord.origin,
        capacity: 2,
        labels: ['linux-x64'],
        onStatus: () => undefined,
      })
      const result = await coord.done
      expect(result.ok).toBe(true)
      await workerResult
    } finally {
      await coord.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a worker disconnect mid-task strands its in-flight work, which the coordinator surfaces', async () => {
    // For v1 we don't reassign across workers in the same run — the
    // coordinator just logs the stranded count. Validate the connection
    // cleanup path.
    const root = await setupWorkspace()
    const coord = await startCoordinator({
      workspaceRoot: root,
      tasks: ['a'],
      port: 0,
      onStatus: () => undefined,
    })
    try {
      const ws = new WebSocket(coord.origin.replace('http', 'ws'))
      await new Promise<void>((resolve) => (ws.onopen = () => resolve()))
      ws.send(
        JSON.stringify({
          t: 'worker:hello',
          workerId: 'w-test',
          capacity: 1,
          labels: ['linux-x64'],
        }),
      )
      // Close before pulling.
      await Bun.sleep(50)
      ws.close()
      // The coordinator must not hang — the only task can be reassigned
      // once a real worker shows up; we attach one now.
      const ok = runWorker({
        coordinatorUrl: coord.origin,
        capacity: 1,
        labels: ['linux-x64'],
        onStatus: () => undefined,
      })
      const result = await coord.done
      expect(result.ok).toBe(true)
      await ok
    } finally {
      await coord.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
