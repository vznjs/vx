// One run at a time per workspace, per machine (item 216): a second
// PROCESS waits for the holder's release and says so after a second; runs
// in one process share the lock; a killed run's lock is reclaimed; a lock
// that cannot be made is a warning, not a refusal. A lock naming this
// process's own pid is stale; one another process now wears is too, where
// procfs gives start times (run-lock-recycled.unsafe.test.ts).
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { acquireRunLock, runLockPath } from '../src/orchestrator/run-lock.js'
import { procfsIsOwn } from '../src/util/procfs.js'

/**
 * Field 22 of /proc/<pid>/stat — what the lock records beside the pid
 * where procfs is this pid namespace's (not in the sandbox's nested one).
 */
function startOf(pid: number): string | null {
  if (!procfsIsOwn()) return null
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!
}

/** The pid file's line for a process: its pid, and its start time where the platform has one. */
function lineOf(pid: number): string {
  const start = startOf(pid)
  return start === null ? `${pid}\n` : `${pid} ${start}\n`
}

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
    await writeFile(pidFile(), lineOf(child.pid))
    return { pid: child.pid, end: () => child.kill() }
  }

  it('is keyed by the resolved workspace root, wherever the cache lives', () => {
    expect(runLockPath('/w/app', '/t')).toBe(runLockPath('/w/./app', '/t'))
    expect(runLockPath('/w/app', '/t')).not.toBe(runLockPath('/w/other', '/t'))
    expect(path.dirname(runLockPath('/w/app', '/t'))).toBe('/t')
  })

  it('a root reached through a symlink names the same lock as its real path', async () => {
    // macOS's temp dir is /var -> /private/var: a caller holding the
    // mkdtemp spelling and a CLI whose cwd came back canonical hashed two
    // strings, and `vx cache prune` never saw the run's lock (CI, darwin).
    const real = path.join(dir, 'real')
    await mkdir(real)
    await symlink(real, path.join(dir, 'link'))
    expect(runLockPath(path.join(dir, 'link', '.'), '/t')).toBe(runLockPath(real, '/t'))
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
    expect(await Bun.file(pidFile()).text()).toBe(lineOf(process.pid))
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
    expect(await Bun.file(pidFile()).text()).toBe(lineOf(process.pid))
    await release()
    expect(lines).toEqual([])
  })

  it("a lock naming this process's own pid is stale: a restarted container's vx wears it", async () => {
    // The temp directory outlives a container restart, and the new vx got
    // the dead run's pid (1): it waited for itself forever, "waiting for
    // another vx run (pid 1)" (nx#36473 reproduced on vx, 2026-09-24). A
    // run of THIS process would share the lock, not meet its file.
    await mkdir(runLockPath('/w/app', dir))
    await writeFile(pidFile(), `${process.pid}\n`)
    const acquired = acquireRunLock('/w/app', { dir, log })
    const first = await Promise.race([acquired, Bun.sleep(1_000).then(() => 'waiting' as const)])
    expect(first).not.toBe('waiting')
    expect(await Bun.file(pidFile()).text()).toBe(lineOf(process.pid))
    await (
      await acquired
    )()
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
    expect(await Bun.file(pidFile()).text()).toBe(lineOf(other.pid))
    other.end()
  })
})
