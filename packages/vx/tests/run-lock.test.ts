// One run at a time per workspace, per machine (item 216): a second
// PROCESS waits for the holder's release and says so after a second; runs
// in one process share the lock; a killed run's lock is reclaimed; a lock
// that cannot be made is a warning, not a refusal. A lock naming this
// process's own pid is stale; one another process now wears is too, where
// procfs gives start times (run-lock-recycled.unsafe.test.ts).
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { acquireRunLock, runLockPath } from '../src/orchestrator/run-lock.js'
import { procfsIsOwn } from '../src/util/procfs.js'
import { skipAsRoot } from './helpers/nonroot-gate.js'

/** How long the contention row's processes contend. */
const STRESS_MS = 2_500

/**
 * Field 22 of /proc/<pid>/stat — what the lock records beside the pid
 * where procfs is this pid namespace's (not in the sandbox's nested one).
 */
function startOf(pid: number): string | null {
  if (!procfsIsOwn()) return null
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!
}

/** The pid file's line an older vx wrote for a process: its pid, and its start time where the platform has one. */
function lineOf(pid: number): string {
  const start = startOf(pid)
  return start === null ? `${pid}\n` : `${pid} ${start}\n`
}

/** The holder a lock entry names, without the taking's number: `h-<pid>-<start or x>`. */
function holderOf(pid: number): string {
  return `h-${pid}-${startOf(pid) ?? 'x'}`
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
  const lockDir = (): string => runLockPath('/w/app', dir)
  const pidFile = (): string => path.join(lockDir(), 'pid')
  /** The holders the lock names, each entry without its taking's number; [] when there is no lock. */
  const held = async (): Promise<string[]> =>
    (await readdir(lockDir()).catch(() => [])).map((e) => e.replace(/-\d+$/, ''))

  it('an exit while a release is under way still removes the lock', async () => {
    // A release unlinks its entry, then the directory, asynchronously. A
    // signal exit between the two (the second Ctrl-C of a run whose tasks
    // had just ended) found no taker listed and left the directory: the
    // release had unlisted its taking before it began (item 867, macOS
    // CI). The exit hook runs synchronously, so the directory is gone the
    // moment the event returns.
    const release = await acquireRunLock('/w/app', { dir, log })
    expect(existsSync(lockDir())).toBe(true)
    const releasing = release()
    process.emit('exit', 0)
    const left = existsSync(lockDir())
    await releasing
    expect(left).toBe(false)
    expect(lines).toEqual([])
  })

  /** Another live process holding the lock: a sleeping child whose entry is in it. */
  async function otherHolder(): Promise<{ pid: number; end: () => void }> {
    const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    await mkdir(lockDir())
    await writeFile(path.join(lockDir(), `${holderOf(child.pid)}-1`), '')
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
    expect(await held()).toEqual([holderOf(process.pid)])
    await release()
    expect(await held()).toEqual([])
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
    expect(await held()).toEqual([holderOf(process.pid)])
    await release2()
    expect(await held()).toEqual([])
    expect(lines).toEqual([])
  })

  it('a release removes only its own taking: a lock another run took since stays', async () => {
    // A holder judged dead while it still runs (a vx in another pid
    // namespace sharing this temp directory reads as ESRCH) has its lock
    // reclaimed and taken by the next run; its release then comes late and
    // must leave the new holder's lock alone.
    const release = await acquireRunLock('/w/app', { dir, log })
    const [mine] = await readdir(lockDir())
    await rm(path.join(lockDir(), mine!))
    const other = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      await writeFile(path.join(lockDir(), `${holderOf(other.pid)}-1`), '')
      await release()
      expect(await held()).toEqual([holderOf(other.pid)])
    } finally {
      other.kill()
    }
  })

  it("a killed run's lock is reclaimed: its pid is gone", async () => {
    await mkdir(lockDir())
    // A pid no process has: the highest allowed plus one is never assigned.
    await writeFile(path.join(lockDir(), 'h-4194305-x-1'), '')
    const release = await acquireRunLock('/w/app', { dir, log })
    expect(await held()).toEqual([holderOf(process.pid)])
    await release()
    expect(lines).toEqual([])
  })

  it("an older vx's pid file is read: a dead one is reclaimed, a live one waited for", async () => {
    await mkdir(lockDir())
    await writeFile(pidFile(), '4194305\n')
    const release = await acquireRunLock('/w/app', { dir, log })
    expect(await held()).toEqual([holderOf(process.pid)])
    await release()
    const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    await mkdir(lockDir())
    await writeFile(pidFile(), lineOf(child.pid))
    let acquired = false
    const pending = acquireRunLock('/w/app', { dir, log }).then((r) => {
      acquired = true
      return r
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(acquired).toBe(false)
    child.kill()
    await (
      await pending
    )()
    expect(lines).toEqual([])
  })

  it('an empty lock directory is free: an older vx between its mkdir and its write', async () => {
    await mkdir(lockDir())
    const acquired = acquireRunLock('/w/app', { dir, log })
    const first = await Promise.race([acquired, Bun.sleep(1_000).then(() => 'waiting' as const)])
    expect(first).not.toBe('waiting')
    expect(await held()).toEqual([holderOf(process.pid)])
    await (
      await acquired
    )()
  })

  it("a lock naming this process's own pid is stale: a restarted container's vx wears it", async () => {
    // The temp directory outlives a container restart, and the new vx got
    // the dead run's pid (1): it waited for itself forever, "waiting for
    // another vx run (pid 1)" (nx#36473 reproduced on vx, 2026-09-24). A
    // run of THIS process would share the lock, not meet its file.
    await mkdir(lockDir())
    await writeFile(path.join(lockDir(), `h-${process.pid}-x-1`), '')
    const acquired = acquireRunLock('/w/app', { dir, log })
    const first = await Promise.race([acquired, Bun.sleep(1_000).then(() => 'waiting' as const)])
    expect(first).not.toBe('waiting')
    expect(await held()).toEqual([holderOf(process.pid)])
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

  it(
    'contending processes never hold it at once, and holders that die holding it are reclaimed',
    async () => {
      // The lock was a bare mkdir, then the pid write, and left as an unlink,
      // then the rmdir: visible without its pid for a moment each way, and a
      // waiter that had waited past its grace removed it as abandoned. Four
      // contenders for four seconds ran two at once 22 times and a release
      // threw ENOENT (item 759). A holder that dies holding it is what a
      // reclaim races on, so every third taking here dies: its entry is
      // renamed to a pid no process has, the state a SIGKILLed holder leaves
      // (a real one, spawned and killed, joins beside them).
      const contender = path.join(dir, 'contender.ts')
      const dier = path.join(dir, 'dier.ts')
      const src = JSON.stringify(path.resolve(import.meta.dir, '../src/orchestrator/run-lock.ts'))
      const locks = path.join(dir, 'locks')
      const lock = runLockPath('/w/app', locks)
      await mkdir(locks)
      await writeFile(
        contender,
        `import { acquireRunLock } from ${src}
import { closeSync, openSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
const inside = ${JSON.stringify(path.join(dir, 'inside'))}
const lock = ${JSON.stringify(lock)}
const tally = { rounds: 0, died: 0, overlaps: 0, throws: 0, warnings: [] }
const end = Date.now() + ${STRESS_MS}
while (Date.now() < end) {
  // A contender may wait past a second and say so; that notice is the lock working.
  const release = await acquireRunLock('/w/app', { dir: ${JSON.stringify(locks)}, log: (l) => { if (!l.includes('waiting for another vx run')) tally.warnings.push(l) } })
  try { closeSync(openSync(inside, 'wx')) } catch { tally.overlaps++ }
  await Bun.sleep(1)
  try { unlinkSync(inside) } catch {}
  if (++tally.rounds % 3 === 0) {
    // Never assigned: the highest pid allowed plus one.
    for (const e of readdirSync(lock)) renameSync(\`\${lock}/\${e}\`, \`\${lock}/h-4194305-x-\${process.pid}\${tally.rounds}\`)
    tally.died++
  }
  try { await release() } catch { tally.throws++ }
}
console.log(JSON.stringify(tally))
`,
      )
      await writeFile(
        dier,
        `import { acquireRunLock } from ${src}
await acquireRunLock('/w/app', { dir: ${JSON.stringify(locks)}, log: () => {} })
process.kill(process.pid, 'SIGKILL')
`,
      )
      const contenders = [1, 2, 3, 4, 5, 6].map(() =>
        Bun.spawn([process.execPath, contender], { stdout: 'pipe', stderr: 'inherit' }),
      )
      const end = Date.now() + STRESS_MS
      let killed = 0
      while (Date.now() < end) {
        await Bun.spawn([process.execPath, dier], { stdout: 'ignore', stderr: 'ignore' }).exited
        killed++
      }
      const tallies = await Promise.all(
        contenders.map(async (c) => JSON.parse(await new Response(c.stdout).text())),
      )
      expect(killed).toBeGreaterThan(0)
      for (const t of tallies) {
        expect(t.died).toBeGreaterThan(0)
        expect({ overlaps: t.overlaps, throws: t.throws, warnings: t.warnings }).toEqual({
          overlaps: 0,
          throws: 0,
          warnings: [],
        })
      }
      // The last holder to die may outlive every contender: one more take
      // reclaims it. Then nothing built beside the lock is left behind.
      await (
        await acquireRunLock('/w/app', { dir: locks, log })
      )()
      expect(await readdir(locks)).toEqual([])
      expect(lines).toEqual([])
    },
    STRESS_MS + 20_000,
  )

  it.skipIf(skipAsRoot("a dead holder's lock this user cannot unlink from"))(
    "a dead holder's lock this user cannot reclaim is a warning, not a spin",
    async () => {
      // Another user's lock: its directory refuses this user's unlink. The
      // reclaim's refusal once read as "gone already" and the wait retried
      // at once, without its poll, for as long as the process lived.
      await mkdir(lockDir())
      await writeFile(path.join(lockDir(), 'h-4194305-x-1'), '')
      await chmod(lockDir(), 0o555)
      try {
        const acquired = acquireRunLock('/w/app', { dir, log })
        const first = await Promise.race([
          acquired,
          Bun.sleep(1_000).then(() => 'spinning' as const),
        ])
        expect(first).not.toBe('spinning')
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatch(/^\[vx\] no run lock for this workspace \(EACCES: /)
        expect(await held()).toEqual(['h-4194305-x'])
      } finally {
        await chmod(lockDir(), 0o755)
      }
    },
  )

  it('an aborted wait returns without the lock', async () => {
    const other = await otherHolder()
    const ac = new AbortController()
    const second = acquireRunLock('/w/app', { dir, log, signal: ac.signal })
    setTimeout(() => ac.abort(), 120)
    await (
      await second
    )()
    expect(await held()).toEqual([holderOf(other.pid)])
    other.end()
  })
})
