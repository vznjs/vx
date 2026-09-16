// One run at a time per workspace, per machine (item 216): a second
// PROCESS waits for the holder's release and says so after a second; runs
// in one process share the lock; a killed run's lock is reclaimed; a lock
// that cannot be made is a warning, not a refusal.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { acquireRunLock, runLockPath } from '../src/orchestrator/run-lock.js'

describe('the run lock', () => {
  let dir: string
  let lines: string[]
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-run-lock-'))
    lines = []
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const log = (line: string): void => {
    lines.push(line)
  }
  const pidFile = (): string => path.join(runLockPath('/w/app', dir), 'pid')

  /** Another live process holding the lock: a sleeping child whose pid is in the file. */
  async function otherHolder(): Promise<{ pid: number; end: () => void }> {
    const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    await mkdir(runLockPath('/w/app', dir))
    await writeFile(pidFile(), `${child.pid}\n`)
    return { pid: child.pid, end: () => child.kill() }
  }

  it('is keyed by the resolved workspace root, wherever the cache lives', () => {
    expect(runLockPath('/w/app', '/t')).toBe(runLockPath('/w/./app', '/t'))
    expect(runLockPath('/w/app', '/t')).not.toBe(runLockPath('/w/other', '/t'))
    expect(path.dirname(runLockPath('/w/app', '/t'))).toBe('/t')
  })

  it('the second process waits for the holder to release', async () => {
    const other = await otherHolder()
    let acquiredAt = 0
    const second = acquireRunLock('/w/app', { dir, log }).then((release) => {
      acquiredAt = Date.now()
      return release
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(acquiredAt).toBe(0)
    const endedAt = Date.now()
    other.end()
    const release = await second
    expect(acquiredAt).toBeGreaterThanOrEqual(endedAt)
    expect(await Bun.file(pidFile()).text()).toBe(`${process.pid}\n`)
    await release()
    expect(await Bun.file(pidFile()).exists()).toBe(false)
    expect(lines).toEqual([])
  })

  it('a wait longer than a second names the holder once', async () => {
    const other = await otherHolder()
    const second = acquireRunLock('/w/app', { dir, log })
    await new Promise((r) => setTimeout(r, 1_300))
    expect(lines).toEqual([
      `[vx] waiting for another vx run (pid ${other.pid}) on this workspace to finish…`,
    ])
    other.end()
    await (
      await second
    )()
    expect(lines).toHaveLength(1)
  })

  it('runs in one process share the lock; the last release removes it', async () => {
    // An embedder running two at once coordinates them itself
    // (`RunOptions.inflight`); the lock is for processes.
    const release1 = await acquireRunLock('/w/app', { dir, log })
    const release2 = await acquireRunLock('/w/app', { dir, log })
    await release1()
    expect(await Bun.file(pidFile()).exists()).toBe(true)
    await release2()
    expect(await Bun.file(pidFile()).exists()).toBe(false)
    expect(lines).toEqual([])
  })

  it("a killed run's lock is reclaimed: its pid is gone", async () => {
    await mkdir(runLockPath('/w/app', dir))
    // A pid no process has: the highest allowed plus one is never assigned.
    await writeFile(pidFile(), '4194305\n')
    const release = await acquireRunLock('/w/app', { dir, log })
    expect(await Bun.file(pidFile()).text()).toBe(`${process.pid}\n`)
    await release()
    expect(lines).toEqual([])
  })

  it('CONTROL: a live holder is not reclaimed', async () => {
    const other = await otherHolder()
    let acquired = false
    const pending = acquireRunLock('/w/app', { dir, log }).then((r) => {
      acquired = true
      return r
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(acquired).toBe(false)
    other.end()
    await (
      await pending
    )()
  })

  it('a lock that cannot be made is a warning, and the run proceeds', async () => {
    const release = await acquireRunLock('/w/app', {
      dir: path.join(dir, 'missing', 'deeper'),
      log,
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /^\[vx\] no run lock for this workspace \(ENOENT: .*\) — another vx run on it at the same time may race this one$/,
    )
    await release()
  })

  it('an aborted wait returns without the lock', async () => {
    const other = await otherHolder()
    const ac = new AbortController()
    const second = acquireRunLock('/w/app', { dir, log, signal: ac.signal })
    setTimeout(() => ac.abort(), 120)
    await (
      await second
    )()
    expect(await Bun.file(pidFile()).text()).toBe(`${other.pid}\n`)
    other.end()
  })
})
