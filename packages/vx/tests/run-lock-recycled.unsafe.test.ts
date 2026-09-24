// A recycled pid is told apart by the start time procfs records (item
// 740, nx#36473). Unsafe: a sandboxed shard sees a procfs mounted for
// another pid namespace, where vx records no start time and trusts the
// pid, so only an unsandboxed process can hold this row.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { acquireRunLock, runLockPath } from '../src/orchestrator/run-lock.js'
import { procfsIsOwn } from '../src/util/procfs.js'

describe.skipIf(process.platform !== 'linux')('the run lock on a procfs of its own', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-run-lock-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('an unsandboxed Linux process reads its own procfs', () => {
    expect(procfsIsOwn()).toBe(true)
  })

  it('a lock whose pid another process now wears is stale: the start time differs', async () => {
    // A restarted container's recycled pid now names some other process:
    // it is alive, so only the start time the holder recorded tells them
    // apart. The CONTROL row in run-lock.test.ts writes a live holder's
    // real one.
    const lines: string[] = []
    const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      await mkdir(runLockPath('/w/app', dir))
      await writeFile(path.join(runLockPath('/w/app', dir), 'pid'), `${child.pid} 1\n`)
      const acquired = acquireRunLock('/w/app', { dir, log: (l) => lines.push(l) })
      const first = await Promise.race([acquired, Bun.sleep(1_000).then(() => 'waiting' as const)])
      expect(first).not.toBe('waiting')
      await (
        await acquired
      )()
      expect(lines).toEqual([])
    } finally {
      child.kill()
    }
  })
})
