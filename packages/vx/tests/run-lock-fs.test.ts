// The run lock's refusals and windows, driven through a mocked
// `node:fs/promises` (item C-27): a refusal this user cannot provoke as
// root, an EEXIST Linux never answers, and an unlink held pending so a
// second taking lands inside a release (the item 867 method). procfs is
// mocked as not this namespace's, where every entry names no start time;
// `mock.module` holds for the whole test process, so every wrapper
// passes each call, arguments and all, through to the real one.

import * as fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import * as util from '../src/util/index.js'

const real = { ...fsPromises }
const realUtil = { ...util }

/** Throw this error code from the next call of each named function on the lock. */
const refuse = new Map<string, string>()
/** Holds the next unlink of a lock entry until released. */
let hold: { started: () => void; until: Promise<void> } | undefined
/** Reads of the lock directory: one per poll of a wait. */
let polls = 0
let lockDirOf = ''

function refused(fn: string, p: unknown): void {
  const code = refuse.get(fn)
  if (code === undefined || !String(p).startsWith(lockDirOf)) return
  refuse.delete(fn)
  throw Object.assign(new Error(`${code}: mocked, ${fn} '${String(p)}'`), { code })
}

await mock.module('node:fs/promises', () => ({
  ...real,
  readdir: async (p: string, ...rest: unknown[]) => {
    if (p === lockDirOf) polls++
    refused('readdir', p)
    return (real.readdir as (...a: unknown[]) => unknown)(p, ...rest)
  },
  rename: async (from: string, to: string) => {
    refused('rename', to)
    return real.rename(from, to)
  },
  unlink: async (p: string) => {
    refused('unlink', p)
    const h = hold
    if (h !== undefined && String(p).startsWith(`${lockDirOf}/`)) {
      hold = undefined
      h.started()
      await h.until
    }
    return real.unlink(p)
  },
}))
await mock.module('../src/util/index.js', () => ({ ...realUtil, procfsIsOwn: () => false }))
// A fresh instance: a shard-mate that loaded run-lock.ts first keeps the real
// `procfsIsOwn` binding, and the mock above never reached it (O-11's deal).
const FRESH: string = '../src/orchestrator/run-lock.js?procfs-mocked'
const { acquireRunLock, runLockPath } = (await import(
  FRESH
)) as typeof import('../src/orchestrator/run-lock.js')

describe('the run lock, through a mocked file system', () => {
  let dir = ''
  let lines: string[] = []
  const log = (line: string): void => {
    lines.push(line)
  }
  const lockDir = (): string => runLockPath('/w/app', dir)
  beforeEach(async () => {
    dir = await real.mkdtemp(path.join(os.tmpdir(), 'vx-run-lock-fs-'))
    lockDirOf = lockDir()
    lines = []
    polls = 0
  })
  afterEach(async () => {
    refuse.clear()
    hold = undefined
    await real.rm(dir, { recursive: true, force: true })
  })

  /** A live process whose entry, naming `start`, holds the lock. */
  async function liveHolder(start: string): Promise<{ pid: number; end: () => void }> {
    const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    await real.mkdir(lockDir())
    await real.writeFile(path.join(lockDir(), `h-${child.pid}-${start}-1`), '')
    return { pid: child.pid, end: () => child.kill() }
  }

  /** Resolves once the wait has read the lock `n` times and found it held. */
  async function polled(n: number): Promise<void> {
    // performance.now: one row stands the Date clock still.
    const deadline = performance.now() + 4_000
    while (polls < n && performance.now() < deadline) await Bun.sleep(5)
    expect(polls).toBeGreaterThanOrEqual(n)
  }

  const quick = <T>(p: Promise<T>): Promise<T | 'waiting'> =>
    Promise.race([p, Bun.sleep(1_000).then(() => 'waiting' as const)])

  it('where procfs is not this namespace, an entry names no start time', async () => {
    const release = await acquireRunLock('/w/app', { dir, log })
    expect(await real.readdir(lockDir())).toEqual([
      expect.stringMatching(new RegExp(`^h-${process.pid}-x-\\d+$`)),
    ])
    await release()
  })

  it('a start time procfs cannot check is trusted: the live holder is waited for', async () => {
    // A lock taken outside the sandbox names a start time the sandbox's
    // procfs cannot read back; the pid alone says the holder lives.
    const other = await liveHolder('999')
    try {
      let acquired = false
      const pending = acquireRunLock('/w/app', { dir, log }).then((r) => {
        acquired = true
        return r
      })
      await polled(3)
      expect(acquired).toBe(false)
      other.end()
      await (
        await pending
      )()
    } finally {
      other.end()
    }
  })

  it("another user's live holder (EPERM) is waited for, polling, not spinning", async () => {
    // The dead pid's probe answers EPERM, as another user's process does:
    // alive, not ours to reclaim. The wait polls: a slow runner reads the
    // lock fewer times by the notice, never more.
    await real.mkdir(lockDir())
    await real.writeFile(path.join(lockDir(), 'h-4194305-x-1'), '')
    const kill = process.kill.bind(process)
    const spy = spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      if (pid === 4194305) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      return kill(pid, sig)
    }) as typeof process.kill)
    const ac = new AbortController()
    try {
      const pending = acquireRunLock('/w/app', { dir, log, signal: ac.signal })
      const deadline = Date.now() + 4_000
      while (lines.length === 0 && Date.now() < deadline) await Bun.sleep(20)
      expect(lines).toEqual([
        '[vx] waiting for another vx run (pid 4194305) on this workspace to finish…',
      ])
      expect(polls).toBeLessThanOrEqual(1_000 / 50 + 5)
      ac.abort()
      await (
        await pending
      )()
      expect(await real.readdir(lockDir())).toEqual(['h-4194305-x-1'])
    } finally {
      spy.mockRestore()
    }
  })

  it('a rename refused with EEXIST reads as held, as ENOTEMPTY does', async () => {
    // POSIX lets a rename onto a non-empty directory answer either.
    refuse.set('rename', 'EEXIST')
    const release = await acquireRunLock('/w/app', { dir, log })
    expect(refuse.has('rename')).toBe(false)
    expect(lines).toEqual([])
    expect(await real.readdir(lockDir())).toHaveLength(1)
    await release()
  })

  it('a lock whose holder cannot be read is a warning, not a spin', async () => {
    const other = await liveHolder('x')
    try {
      refuse.set('readdir', 'EACCES')
      const first = await quick(acquireRunLock('/w/app', { dir, log }))
      expect(first).not.toBe('waiting')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/^\[vx\] no run lock for this workspace \(EACCES: mocked, readdir /)
    } finally {
      other.end()
    }
  })

  it("a dead holder's entry this user cannot unlink is a warning, not a spin", async () => {
    // The as-root twin of run-lock.test.ts's chmod row, which skips as root.
    await real.mkdir(lockDir())
    await real.writeFile(path.join(lockDir(), 'h-4194305-x-1'), '')
    refuse.set('unlink', 'EACCES')
    const first = await quick(acquireRunLock('/w/app', { dir, log }))
    expect(first).not.toBe('waiting')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[vx\] no run lock for this workspace \(EACCES: mocked, unlink /)
    expect(await real.readdir(lockDir())).toEqual(['h-4194305-x-1'])
  })

  it("an older vx's lock with no pid yet is left for one poll, then reclaimed", async () => {
    // Its pid file is there but empty: the older vx is between its write's
    // open and its bytes. The clock stands still, so every poll is inside
    // the grace.
    await real.mkdir(lockDir())
    await real.writeFile(path.join(lockDir(), 'pid'), '')
    const now = Date.now()
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    let acquired = false
    let pending: Promise<() => Promise<void>> | undefined
    try {
      pending = acquireRunLock('/w/app', { dir, log }).then((r) => {
        acquired = true
        return r
      })
      await polled(3)
      expect(acquired).toBe(false)
      expect(await real.readdir(lockDir())).toEqual(['pid'])
    } finally {
      clock.mockRestore()
    }
    await (
      await pending
    )()
    expect(lines).toEqual([])
  })

  it('a taking that lands inside a release keeps its entry and its exit cleanup', async () => {
    // A release's unlink is held; a run of this process that starts then
    // finds its own pid's stale entry, reclaims it and takes the lock.
    // The late unlink must miss the new entry (each taking names its own),
    // and the release must not unlist the new taking from the exit hook.
    const releaseA = await acquireRunLock('/w/app', { dir, log })
    const [a] = await real.readdir(lockDir())
    let go!: () => void
    const started = new Promise<void>((r) => {
      hold = {
        started: r,
        until: new Promise((u) => {
          go = u
        }),
      }
    })
    const releasing = releaseA()
    await started
    const releaseB = await acquireRunLock('/w/app', { dir, log })
    const [b] = await real.readdir(lockDir())
    expect(b).not.toBe(a)
    go()
    await releasing
    expect(await real.readdir(lockDir())).toEqual([b!])
    process.emit('exit', 0)
    const left = await real.readdir(lockDir()).catch(() => 'gone')
    await releaseB()
    expect(left).toBe('gone')
    expect(lines).toEqual([])
  })
})
