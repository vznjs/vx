// A distributed run end to end: a worker's life in it, from a worker killed
// mid-task to a relay that restarts and a relay two runs share
// (local-e2e-fixture.ts).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import {
  CORE_BIN,
  DTE,
  children,
  root,
  setup,
  teardown,
  vx,
  workerOf,
} from './local-e2e-fixture.ts'

let marks = ''

beforeEach(async () => {
  await setup()
  marks = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-life-'))
  const first = path.join(marks, 'first')
  const started = path.join(marks, 'started')
  const ran = path.join(marks, 'ran.log')
  await mkdir(path.join(root, 'l'))
  await writeFile(
    path.join(root, 'l/vx.config.mjs'),
    `const cached = (out, command) => ({ exec: { command }, inputs: { files: ['vx.config.mjs'] }, outputs: { files: [out + '/**'] }, cache: true })
export default { name: 'l', tasks: {
  // Its first attempt writes half its output and hangs; the next writes it whole.
  part: cached('out', 'mkdir -p out && if [ -e ' + ${JSON.stringify(first)} + ' ]; then echo whole > out/x.txt; else touch ' + ${JSON.stringify(first)} + ' && echo partial > out/x.txt && sleep 60; fi'),
  slow: { exec: { command: 'echo >> ' + ${JSON.stringify(ran)} + ' && touch ' + ${JSON.stringify(started)} + ' && sleep 3 && echo slept' } },
  a: cached('oa', 'mkdir -p oa && echo a > oa/a.txt'),
  b: cached('ob', 'mkdir -p ob && echo b > ob/b.txt'),
} }
`,
  )
  expect(vx(['lock']).exitCode).toBe(0)
  commit(root, 'l')
})
afterEach(async () => {
  await teardown()
  await rm(marks, { recursive: true, force: true })
})

function commit(at: string, m: string): void {
  Bun.spawnSync(['git', 'add', '-A'], { cwd: at })
  Bun.spawnSync(['git', '-c', 'user.email=t@vx.local', '-c', 'user.name=t', 'commit', '-qm', m], {
    cwd: at,
  })
}

const until = async (f: () => Promise<boolean>, tries = 300): Promise<boolean> => {
  for (let i = 0; i < tries && !(await f()); i++) await Bun.sleep(100)
  return f()
}

const { VX_DTE_RUN: _run, VX_DTE_WORKER: _worker, ...env } = process.env

// The worker running a task is killed after it wrote half its output: the
// task runs again elsewhere, its whole output lands here, and only that one
// is saved under its key.
it('lands the output of the attempt that ended, not of a killed worker’s', async () => {
  const run = Bun.spawn([process.execPath, CORE_BIN, 'run', 'l#part'], {
    cwd: root,
    env: { ...env, VX_DTE_RUN: crypto.randomUUID(), NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await until(() => Bun.file(path.join(marks, 'first')).exists())).toBe(true)
  const pids = children(run.pid, 'dte worker')
  expect(pids).toHaveLength(1)
  process.kill(pids[0]!, 'SIGKILL')
  const out = (await new Response(run.stdout).text()) + (await new Response(run.stderr).text())
  expect([await run.exited, out.includes('l#part')]).toEqual([0, true])
  expect(await readFile(path.join(root, 'l/out/x.txt'), 'utf8')).toBe('whole\n')
  await rm(path.join(root, 'l/out'), { recursive: true })
  const again = vx(['run', 'l#part'], 'part-again')
  expect([again.exitCode, again.stdout.toString().includes('restored')]).toEqual([0, true])
  expect(await readFile(path.join(root, 'l/out/x.txt'), 'utf8')).toBe('whole\n')
}, 90_000)

/** Points the workspace at a relay this process serves, and commits it. */
async function hosted(url: string): Promise<void> {
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `import { dte } from ${JSON.stringify(DTE)}
export default { plugins: [dte({ relay: ${JSON.stringify(url)} })] }
`,
  )
  commit(root, 'relay')
}

function runAndWorker(at: string, task: string, id = crypto.randomUUID()) {
  const shared = { ...env, VX_DTE_RUN: id, VX_DTE_SECRET: `secret-${id}`, NO_COLOR: '1' }
  const run = Bun.spawn([process.execPath, CORE_BIN, 'run', task], {
    cwd: at,
    env: shared,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const worker = workerOf(
    () =>
      Bun.spawn([process.execPath, CORE_BIN, 'dte', 'worker'], {
        cwd: at,
        env: shared,
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    run,
  )
  return { run, worker, out: new Response(run.stdout).text() }
}

// The relay restarts while a worker runs a task: both join again, the
// task's end arrives, and it ran once.
it('carries a run and its running task across a relay restart', async () => {
  const { serveRelay } = await import('@vzn/vx-dte-server')
  let relay = serveRelay({ port: 0, hostname: '127.0.0.1' })
  const port = Number(new URL(relay.url).port)
  try {
    await hosted(relay.url)
    const { run, worker, out } = runAndWorker(root, 'l#slow')
    expect(await until(() => Bun.file(path.join(marks, 'started')).exists())).toBe(true)
    await relay.stop()
    await Bun.sleep(500)
    relay = serveRelay({ port, hostname: '127.0.0.1' })
    const text = await out
    expect([await run.exited, text]).toEqual([
      0,
      expect.stringMatching(/└─ l#slow · worker#1 ── .*success/),
    ])
    expect(text).toContain('slept')
    expect((await readFile(path.join(marks, 'ran.log'), 'utf8')).split('\n').length - 1).toBe(1)
    expect((await worker).exited).toBe(0)
  } finally {
    await relay.stop()
  }
}, 90_000)

// Two runs on one relay at once, each with its own worker: each worker runs
// its own run's task only, and each run's files land in its own workspace.
it('keeps two runs on one relay apart', async () => {
  const { serveRelay } = await import('@vzn/vx-dte-server')
  const relay = serveRelay({ port: 0, hostname: '127.0.0.1' })
  const other = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-other-'))
  try {
    await hosted(relay.url)
    Bun.spawnSync(['git', 'clone', '-q', root, other])
    const one = runAndWorker(root, 'l#a')
    const two = runAndWorker(other, 'l#b')
    const [o1, o2] = await Promise.all([one.out, two.out])
    expect([await one.run.exited, await two.run.exited]).toEqual([0, 0])
    expect([o1, o2]).toEqual([
      expect.stringMatching(/└─ l#a · worker#1 ── .*success/),
      expect.stringMatching(/└─ l#b · worker#1 ── .*success/),
    ])
    const [w1, w2] = await Promise.all([one.worker, two.worker])
    expect([w1.out.includes('l#a'), w1.out.includes('l#b')]).toEqual([true, false])
    expect([w2.out.includes('l#b'), w2.out.includes('l#a')]).toEqual([true, false])
    expect([
      await Bun.file(path.join(root, 'l/oa/a.txt')).exists(),
      await Bun.file(path.join(root, 'l/ob/b.txt')).exists(),
      await Bun.file(path.join(other, 'l/ob/b.txt')).exists(),
      await Bun.file(path.join(other, 'l/oa/a.txt')).exists(),
    ]).toEqual([true, false, true, false])
  } finally {
    await relay.stop()
    await rm(other, { recursive: true, force: true })
  }
}, 90_000)
