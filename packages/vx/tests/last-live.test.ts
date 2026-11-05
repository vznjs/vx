// `vx last --live`: the run in progress, read from another shell while it
// runs. An agent that started `vx run` in the background asks what is
// running, what already failed and what it was warned of, without waiting
// for the run to end; `--follow` streams the run's events from then on.
// The run answers on a socket beside its run lock, and keeps nothing for
// it but which task started when.
import { existsSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { liveSocketPath } from '../src/orchestrator/index.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const env = { ...process.env, NO_COLOR: '1' }

let root: string
const go = () => path.join(root, 'go')
const vx = (...args: string[]) => {
  const p = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: root, env })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

interface Live {
  live: { runId: string; command: string; pid: number; startedAt: number; elapsedMs: number }
  tasks: Array<{
    taskId: string
    status: string
    startedAt: number | null
    durationMs: number | null
  }>
  warnings: string[]
}

/** The snapshot once `ready` holds, asked every 50 ms for up to 20 s. */
async function liveWhen(ready: (l: Live) => boolean): Promise<Live> {
  const until = Date.now() + 20_000
  for (;;) {
    const r = vx('last', '--live', '--format', 'json')
    if (r.code === 0) {
      const l = JSON.parse(r.out) as Live
      if (ready(l)) return l
    }
    if (Date.now() > until) throw new Error(`no live run: ${r.code} ${r.err}`)
    await Bun.sleep(50)
  }
}

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-last-live-' })
  const wait = `echo started; while [ ! -f ${path.join(root, 'go')} ]; do sleep 0.05; done; echo released`
  await addProject(
    root,
    'a',
    `export default { tasks: {
  quick: { exec: { command: 'echo quick' } },
  lost: { exec: { command: 'true' }, inputs: { files: ['nowhere/**'] }, cache: { outputs: { files: [] } } },
  slow: { exec: { command: ${JSON.stringify(wait)} } },
  after: { exec: { command: 'true' }, dependsOn: ['slow'] },
  all: { dependsOn: ['quick', 'lost', 'after'] },
} }
`,
  )
}, 60_000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('with no run in progress it says so, exit 1', () => {
  const r = vx('last', '--live')
  expect(r.code).toBe(1)
  expect(r.err).toContain('no run in progress')
})

// A run of another vx version answered a snapshot this one could not
// read: the throw inside the socket's handler was swallowed, and `--live`
// printed nothing and exited 0.
it('a run whose snapshot this vx cannot read says so, exit 1', async () => {
  const other = await makeWorkspace({ prefix: 'vx-last-live-other-' })
  try {
    for (const reply of ['nope', '{}', '{"live":{},"tasks":[],"warnings":[]}']) {
      const srv = Bun.listen({
        unix: liveSocketPath(other),
        socket: {
          data(s) {
            s.write(`${reply}\n`)
            s.end()
          },
        },
      })
      try {
        // Not spawnSync: this process answers on the socket meanwhile.
        const p = Bun.spawn({
          cmd: [process.execPath, BIN, 'last', '--live'],
          cwd: other,
          env,
          stderr: 'pipe',
        })
        expect([reply, await p.exited, await new Response(p.stderr).text()]).toEqual([
          reply,
          1,
          expect.stringContaining('answered in a form this vx does not read'),
        ])
      } finally {
        srv.stop(true)
      }
    }
  } finally {
    await rm(other, { recursive: true, force: true })
  }
}, 30_000)

it('a run in progress: what runs, what ended, what waits, and its warnings', async () => {
  const run = Bun.spawn({
    cmd: [process.execPath, BIN, 'run', 'a#all'],
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  try {
    const l = await liveWhen(
      (s) =>
        s.tasks.find((t) => t.taskId === 'a#lost')?.status === 'success' &&
        s.tasks.find((t) => t.taskId === 'a#quick')?.status === 'success',
    )
    expect(l.live.pid).toBe(run.pid)
    expect(l.live.command).toContain('run a#all')
    expect(l.live.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(l.live.elapsedMs).toBeGreaterThanOrEqual(0)
    const by = Object.fromEntries(l.tasks.map((t) => [t.taskId, t]))
    // Groups are scheduling, not work: never listed.
    expect(Object.keys(by).sort()).toEqual(['a#after', 'a#lost', 'a#quick', 'a#slow'])
    expect(by['a#slow']).toMatchObject({ status: 'running', durationMs: null })
    expect(typeof by['a#slow']!.startedAt).toBe('number')
    expect(by['a#after']).toEqual({
      taskId: 'a#after',
      status: 'waiting',
      startedAt: null,
      durationMs: null,
    })
    expect(typeof by['a#quick']!.durationMs).toBe('number')
    // Running first, then what ended, then what waits.
    expect(l.tasks[0]!.taskId).toBe('a#slow')
    expect(l.tasks.at(-1)!.taskId).toBe('a#after')
    expect(l.warnings.some((w) => w.includes('matched no files') && !w.includes('\x1b['))).toBe(
      true,
    )

    const pretty = vx('last', '--live')
    expect(pretty.code).toBe(0)
    expect(pretty.out).toStartWith(`─ Run ${l.live.runId} `)
    expect(pretty.out).toMatch(/\n {2}status +running /)
    expect(pretty.out).toMatch(/\n {2}running +a#slow +\d/)
    expect(pretty.out).toMatch(/\n {2}waiting +a#after *\n/)
    expect(pretty.out).toMatch(/\n─ Warnings \d+ /)

    // --follow streams the run's events from now to its end, then exits.
    const follow = Bun.spawn({
      cmd: [process.execPath, BIN, 'last', '--live', '--follow', '--format', 'json'],
      cwd: root,
      env,
      stdout: 'pipe',
    })
    // The snapshot line first: the follower is attached once it is out.
    const reader = follow.stdout.getReader()
    let text = ''
    while (!text.includes('\n')) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    writeFileSync(go(), '')
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    expect(await follow.exited).toBe(0)
    const lines = text
      .trimEnd()
      .split('\n')
      .map((x) => JSON.parse(x) as Record<string, unknown>)
    expect((lines[0] as unknown as Live).live.runId).toBe(l.live.runId)
    const events = lines.slice(1)
    expect(events).toContainEqual({ kind: 'task:stdout', taskId: 'a#slow', chunk: 'released\n' })
    expect(events.some((e) => e['kind'] === 'task:complete')).toBe(true)
    expect(events.at(-1)).toEqual({ kind: 'run:done' })
    expect(await run.exited).toBe(0)
  } finally {
    run.kill()
  }
}, 60_000)

it('once the run ended there is none in progress, and no socket is left', async () => {
  const r = vx('last', '--live')
  expect(r.code).toBe(1)
  expect(r.err).toContain('no run in progress')
  expect(existsSync(go())).toBe(true)
  expect(existsSync(liveSocketPath(root))).toBe(false)
})

it('a socket a killed run left is no run in progress, and the next run takes its place', async () => {
  const run = Bun.spawn({
    cmd: [process.execPath, BIN, 'run', 'a#slow', '--force'],
    cwd: root,
    env,
  })
  await rm(go(), { force: true })
  await liveWhen((s) => s.tasks.some((t) => t.status === 'running'))
  run.kill('SIGKILL')
  await run.exited
  expect(existsSync(liveSocketPath(root))).toBe(true)
  const r = vx('last', '--live')
  expect(r.code).toBe(1)
  expect(r.err).toContain('no run in progress')
  writeFileSync(go(), '')
  expect(vx('run', 'a#quick').code).toBe(0)
  expect(existsSync(liveSocketPath(root))).toBe(false)
}, 60_000)

it('--follow needs --live, and --live combines only with --follow, --format and --cache-dir', () => {
  expect(vx('last', '--follow').err).toContain('--follow needs --live')
  for (const extra of [
    ['--list'],
    ['--failed'],
    ['--stats'],
    ['--log', 'a#slow'],
    ['--sql', 'SELECT 1'],
  ]) {
    const r = vx('last', '--live', ...extra)
    expect(r.code).toBe(1)
    expect(r.err).toContain('--live combines only with --follow, --format and --cache-dir')
  }
})
