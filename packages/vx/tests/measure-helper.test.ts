// vx-measure's binaries are committed (`scripts/build-observe.ts`), so a
// change to its source that was never built would ship the old program.
// And the program itself: one per vx forks every task shell, and what it
// says (pid, exit, peak) is what spawn-off.ts reads; where it cannot start
// or dies, the thread spawns as before.

import { createHash } from 'node:crypto'
import { closeSync, readFileSync, readSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { heldPipe } from '../src/exec/pipes.js'
import { measureHelper } from '../src/exec/measure-helper.js'
import { spawnOff } from '../src/exec/spawn-off.js'

const dir = path.join(import.meta.dir, '..', 'src', 'exec', 'measure')
const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined

it('the committed binaries were built from the committed source', () => {
  const source = readFileSync(path.join(dir, 'vx-measure.c'))
  expect(readFileSync(path.join(dir, 'source.sha256'), 'utf8').trim()).toBe(
    createHash('sha256').update(source).digest('hex'),
  )
})

/** Everything left in a pipe whose write ends are all closed. */
function drain(fd: number): string {
  const buf = Buffer.alloc(64 * 1024)
  let text = ''
  for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) text += buf.toString('utf8', 0, n)
  closeSync(fd)
  return text
}

/** Run `script` as a task shell is spawned: what it printed, how it ended, its peak. */
async function run(script: string, measure: string | undefined, onSpawn?: (pid: number) => void) {
  const [r, w] = heldPipe()!
  const child = await spawnOff({
    cmd: ['/bin/sh', '-c', script],
    argv0: 'sh',
    detached: true,
    stdio: ['ignore', w!, 'ignore'],
    measure,
  })
  closeSync(w!)
  onSpawn?.(child.pid)
  await child.exited
  return {
    stdout: drain(r!),
    pid: child.pid,
    exitCode: child.exitCode,
    signal: child.signalCode,
    peak: child.measuredPeak(),
  }
}

describe.skipIf(process.platform !== 'linux' || arch === undefined)('vx-measure', () => {
  let helper: string
  let tmp: string
  beforeAll(async () => {
    helper = (await measureHelper())!
    tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-measure-'))
  })
  afterAll(() => rm(tmp, { recursive: true, force: true }))

  it('forks the shell: its own pid, a parent that is not this process, its peak and exit code', async () => {
    // A skip is a silent pass: the rows below need the helper.
    expect(helper).toBeString()
    const r = await run(
      'echo $$ $PPID; dd if=/dev/zero of=/dev/null bs=24M count=1 2>/dev/null; exit 5',
      helper,
    )
    const [pid, ppid] = r.stdout.trim().split(' ').map(Number)
    expect(r.exitCode).toBe(5)
    expect(r.pid).toBe(pid!)
    expect(ppid).not.toBe(process.pid)
    expect(readFileSync(`/proc/${ppid}/comm`, 'utf8')).toStartWith('vx-measure')
    // dd's 24 MB buffer, far under this process's own size.
    expect(r.peak!).toBeGreaterThanOrEqual(24 * 1024 * 1024)
    expect(r.peak!).toBeLessThan(40 * 1024 * 1024)
  })

  it('one helper forks every shell, and each exit reaches its own task', async () => {
    const rs = await Promise.all(
      Array.from({ length: 40 }, (_, i) => run(`echo $PPID; exit ${i + 1}`, helper)),
    )
    expect(rs.map((r) => r.exitCode)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
    expect(new Set(rs.map((r) => r.stdout)).size).toBe(1)
  })

  it('ends with the signal the shell died of, and `kill()` reaches the shell', async () => {
    const r = await run('kill -USR1 $$', helper)
    expect({ exitCode: r.exitCode, signal: r.signal }).toEqual({
      exitCode: null,
      signal: 'SIGUSR1',
    })
    const [rd, w] = heldPipe()!
    const child = await spawnOff({
      cmd: ['/bin/sh', '-c', 'echo up; exec sleep 30'],
      argv0: 'sh',
      detached: true,
      stdio: ['ignore', w!, 'ignore'],
      measure: helper,
    })
    closeSync(w!)
    // Started: its first line is in the pipe.
    expect(readSync(rd!, Buffer.alloc(3))).toBe(3)
    child.kill('SIGTERM')
    await child.exited
    closeSync(rd!)
    expect({ exitCode: child.exitCode, signal: child.signalCode }).toEqual({
      exitCode: null,
      signal: 'SIGTERM',
    })
  })

  it('a missing directory is the spawn’s own refusal, as before', async () => {
    const spawned = spawnOff({
      cmd: ['/bin/sh', '-c', 'true'],
      cwd: path.join(tmp, 'gone'),
      stdio: ['ignore', 'ignore', 'ignore'],
      measure: helper,
    })
    expect(
      await spawned.then(
        () => 'ran',
        (err: NodeJS.ErrnoException) => err.code,
      ),
    ).toBe('ENOENT')
  })

  // Each in a process of its own: the helper is one per process, and these end it.
  async function inProcess(body: string): Promise<string> {
    const file = path.join(tmp, `case-${Math.random().toString(36).slice(2)}.ts`)
    await writeFile(
      file,
      `import { closeSync, readSync } from 'node:fs'
import { heldPipe } from ${JSON.stringify(path.join(import.meta.dir, '..', 'src', 'exec', 'pipes.ts'))}
import { spawnOff } from ${JSON.stringify(path.join(import.meta.dir, '..', 'src', 'exec', 'spawn-off.ts'))}
const helper = ${JSON.stringify(helper)}
async function run(script, measure) {
  const [r, w] = heldPipe()
  const child = await spawnOff({ cmd: ['/bin/sh', '-c', script], argv0: 'sh', detached: true, stdio: ['ignore', w, 'ignore'], measure })
  closeSync(w)
  return { child, r }
}
function drain(fd) {
  const buf = Buffer.alloc(4096)
  let text = ''
  for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) text += buf.toString('utf8', 0, n)
  closeSync(fd)
  return text
}
${body}
`,
    )
    const p = Bun.spawn([process.execPath, file], { stdout: 'pipe', stderr: 'pipe' })
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    expect({ exitCode: p.exitCode, err }).toEqual({ exitCode: 0, err: '' })
    return out.trim()
  }

  it('a signal a task sends its parent reaches vx, as when vx was the parent', async () => {
    const out = await inProcess(`
let got = 0
process.on('SIGUSR2', () => got++)
const { child, r } = await run('kill -USR2 $PPID; exit 0', helper)
await child.exited
drain(r)
for (let i = 0; i < 200 && got === 0; i++) await Bun.sleep(10)
console.log(JSON.stringify({ got, exitCode: child.exitCode }))
`)
    expect(JSON.parse(out)).toEqual({ got: 1, exitCode: 0 })
  })

  it('a helper that cannot start leaves the spawn as it was', async () => {
    const out = await inProcess(`
const { child, r } = await run('echo $PPID; exit 3', '/nonexistent/vx-measure')
await child.exited
console.log(JSON.stringify({ ppid: Number(drain(r).trim()) === process.pid, exitCode: child.exitCode, peak: child.measuredPeak() ?? null }))
`)
    expect(JSON.parse(out)).toEqual({ ppid: true, exitCode: 3, peak: null })
  })

  it('a helper that dies ends the shells it forked, and the next spawns run as before', async () => {
    const out = await inProcess(`
const a = await run('echo $PPID; exec sleep 30', helper)
const buf = Buffer.alloc(64)
const zygote = Number(buf.toString('utf8', 0, readSync(a.r, buf)).trim())
process.kill(zygote, 'SIGKILL')
await a.child.exited
closeSync(a.r)
const b = await run('echo $PPID; exit 4', helper)
await b.child.exited
console.log(JSON.stringify({
  zygote: zygote !== process.pid,
  orphan: a.child.signalCode,
  next: { ppid: Number(drain(b.r).trim()) === process.pid, exitCode: b.child.exitCode },
}))
`)
    expect(JSON.parse(out)).toEqual({
      zygote: true,
      orphan: 'SIGKILL',
      next: { ppid: true, exitCode: 4 },
    })
  })
})
