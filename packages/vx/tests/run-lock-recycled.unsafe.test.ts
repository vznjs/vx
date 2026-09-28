// A recycled pid is told apart by the start time procfs records (item
// 740, nx#36473). Unsafe: a sandboxed shard sees a procfs mounted for
// another pid namespace, where vx records no start time and trusts the
// pid, so only an unsandboxed process can hold this row. `node:fs` and
// `node:fs/promises` are wrapped to count procfs reads and the wait's
// polls (C-27); both pass every call through.
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'

const realFs = { ...fs }
const real = { ...fsPromises }
/** Paths `readFileSync` was asked for. */
const reads: string[] = []
/** Reads of the lock directory: one per poll of a wait. */
let polls = 0
let lockDirOf = ''
await mock.module('node:fs', () => ({
  ...realFs,
  readFileSync: ((p: fs.PathOrFileDescriptor, o?: unknown) => {
    if (String(p).startsWith('/proc/')) reads.push(String(p))
    return realFs.readFileSync(p, o as undefined)
  }) as typeof fs.readFileSync,
}))
await mock.module('node:fs/promises', () => ({
  ...real,
  readdir: async (p: string, ...rest: unknown[]) => {
    if (p === lockDirOf) polls++
    return (real.readdir as (...a: unknown[]) => unknown)(p, ...rest)
  },
}))
const { acquireRunLock, runLockPath } = await import('../src/orchestrator/run-lock.js')
const { procfsIsOwn } = await import('../src/util/procfs.js')

function startOf(pid: number): string {
  const stat = realFs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!
}

describe.skipIf(process.platform !== 'linux')('the run lock on a procfs of its own', () => {
  let dir: string
  let lines: string[] = []
  const log = (l: string): void => {
    lines.push(l)
  }
  const lockDir = (): string => runLockPath('/w/app', dir)
  beforeAll(async () => {
    dir = await real.mkdtemp(path.join(os.tmpdir(), 'vx-run-lock-'))
    lockDirOf = lockDir()
  })
  beforeEach(() => {
    lines = []
    polls = 0
    reads.length = 0
  })
  afterAll(async () => {
    await real.rm(dir, { recursive: true, force: true })
  })

  /** Resolves once the wait has read the lock `n` times and found it held. */
  async function polled(n: number): Promise<void> {
    const deadline = Date.now() + 4_000
    while (polls < n && Date.now() < deadline) await Bun.sleep(5)
    expect(polls).toBeGreaterThanOrEqual(n)
  }

  const quick = <T>(p: Promise<T>): Promise<T | 'waiting'> =>
    Promise.race([p, Bun.sleep(1_000).then(() => 'waiting' as const)])

  /** A wait on a live holder that must still be waiting after `n` polls. */
  async function waitsFor(end: () => void, n = 3): Promise<void> {
    let acquired = false
    const pending = acquireRunLock('/w/app', { dir, log }).then((r) => {
      acquired = true
      return r
    })
    await polled(n)
    expect(acquired).toBe(false)
    end()
    await (
      await pending
    )()
    expect(lines).toEqual([])
  }

  it('an unsandboxed Linux process reads its own procfs', () => {
    expect(procfsIsOwn()).toBe(true)
  })

  it('a lock whose pid another process now wears is stale: the start time differs', async () => {
    // A restarted container's recycled pid now names some other process:
    // it is alive, so only the start time the holder recorded tells them
    // apart. The CONTROL row in run-lock.test.ts writes a live holder's
    // real one.
    const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      await real.mkdir(lockDir())
      await real.writeFile(path.join(lockDir(), `h-${child.pid}-1-1`), '')
      const acquired = acquireRunLock('/w/app', { dir, log })
      const first = await quick(acquired)
      expect(first).not.toBe('waiting')
      await (
        await acquired
      )()
      expect(lines).toEqual([])
    } finally {
      child.kill()
    }
  })

  it("an older vx's pid file whose pid another process now wears is stale", async () => {
    const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      await real.mkdir(lockDir())
      await real.writeFile(path.join(lockDir(), 'pid'), `${child.pid} 1\n`)
      const acquired = acquireRunLock('/w/app', { dir, log })
      expect(await quick(acquired)).not.toBe('waiting')
      await (
        await acquired
      )()
      expect(lines).toEqual([])
    } finally {
      child.kill()
    }
  })

  it('a live holder whose entry names no start time is waited for', async () => {
    // Written off Linux, or under another namespace's procfs: the pid is
    // all there is to go on, even where procfs could read a start time.
    const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      await real.mkdir(lockDir())
      await real.writeFile(path.join(lockDir(), `h-${child.pid}-x-1`), '')
      await waitsFor(() => child.kill())
    } finally {
      child.kill()
    }
  })

  it('a live holder whose name holds ") " is read by its real start time', async () => {
    // comm sits in parentheses and may hold both: the fields start after the LAST ')'.
    const bin = path.join(dir, 's) 1 2 3')
    await real.copyFile(Bun.which('sleep')!, bin)
    await real.chmod(bin, 0o755)
    const child = Bun.spawn([bin, '30'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      const deadline = Date.now() + 4_000
      while (!realFs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').includes('(s) 1 2 3)')) {
        expect(Date.now()).toBeLessThan(deadline)
        await Bun.sleep(5)
      }
      await real.mkdir(lockDir())
      await real.writeFile(path.join(lockDir(), `h-${child.pid}-${startOf(child.pid)}-1`), '')
      await waitsFor(() => child.kill())
    } finally {
      child.kill()
    }
  })

  it("a wait reads a live holder's start time once, not once per poll", async () => {
    const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      await real.mkdir(lockDir())
      await real.writeFile(path.join(lockDir(), `h-${child.pid}-${startOf(child.pid)}-1`), '')
      await waitsFor(() => {
        expect(reads.filter((r) => r === `/proc/${child.pid}/stat`)).toEqual([
          `/proc/${child.pid}/stat`,
        ])
        child.kill()
      }, 5)
    } finally {
      child.kill()
    }
  })

  it("an older vx's pid file rewritten mid-wait is read again: a new holder's start is checked", async () => {
    // The entry is `pid` both times; only the start time says the holder changed.
    const first = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    const second = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      await real.mkdir(lockDir())
      const pidFile = path.join(lockDir(), 'pid')
      await real.writeFile(pidFile, `${first.pid} ${startOf(first.pid)}\n`)
      const acquired = acquireRunLock('/w/app', { dir, log })
      await polled(2)
      // Renamed into place: a poll between a truncate and its bytes reads no holder.
      await real.writeFile(`${pidFile}.new`, `${second.pid} 1\n`)
      await real.rename(`${pidFile}.new`, pidFile)
      expect(await quick(acquired)).not.toBe('waiting')
      await (
        await acquired
      )()
      expect(lines).toEqual([])
    } finally {
      first.kill()
      second.kill()
    }
  })
})
