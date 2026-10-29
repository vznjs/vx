// A task's persistent dependencies on a worker (`localFloor`): two shards
// that land on one machine share its server, started once; each other
// machine starts its own (vx-dte's local-e2e test).
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import type { ExecuteRequest } from '../src/exec/executor.js'
import { localFloor } from '../src/orchestrator/local-floor.js'
import { isAlive } from './helpers/alive.js'

let dir = ''
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('starts a server two shards on one machine depend on once, for both', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-floor-srv-'))
  const log = path.join(dir, 'starts.log')
  const floor = localFloor()
  const shard = (n: number): ExecuteRequest => ({
    taskId: `s#shard${n}`,
    workspaceRoot: dir,
    outputs: { files: [], workspaceFiles: [] },
    command: 'test -e up && sleep 0.2',
    forwardArgs: [],
    cwd: dir,
    env: { PATH: process.env['PATH'] },
    envDefine: {},
    capture: { stdout: true, stderr: true },
    onStdout: () => {},
    onStderr: () => {},
    servers: [
      {
        taskId: 's#srv',
        command: `echo x >> ${log} && touch up && echo up && exec sleep 60`,
        cwd: dir,
        env: { PATH: process.env['PATH'] },
        readyWhen: 'up',
      },
    ],
  })
  try {
    const [a, b] = await Promise.all([floor.execute(shard(1)), floor.execute(shard(2))])
    expect([a.exitCode, b.exitCode]).toEqual([0, 0])
    expect((await readFile(log, 'utf8')).trim().split('\n')).toHaveLength(1)
  } finally {
    await floor.close()
  }
}, 20_000)

it('says why a server did not start through the stream a worker ships', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-floor-srv-'))
  const floor = localFloor()
  const heard: string[] = []
  try {
    const r = await floor.execute({
      taskId: 's#live',
      workspaceRoot: dir,
      outputs: { files: [], workspaceFiles: [] },
      command: 'true',
      forwardArgs: [],
      cwd: dir,
      env: { PATH: process.env['PATH'] },
      envDefine: {},
      capture: { stdout: false, stderr: false },
      onStdout: () => {},
      onStderr: (t) => heard.push(t),
      servers: [
        {
          taskId: 's#srv',
          command: 'echo "port is already allocated" >&2; exit 3',
          cwd: dir,
          env: { PATH: process.env['PATH'] },
          readyWhen: 'up',
        },
      ],
    })
    expect(r.exitCode).toBe(1)
    expect(heard.join('')).toContain('s#srv, which s#live depends on, did not start')
    // The server's own words, not only its exit code.
    expect(heard.join('')).toContain('its output:\nport is already allocated\n')
  } finally {
    await floor.close()
  }
}, 20_000)

// A worker's stop (a cancel, its shutdown) aborts the request: a task still
// waiting on a server that never prints its `readyWhen` line, with no
// timeout, waited for good, and the worker's shutdown waited on the task
// before it closed the floor that would have stopped the server.
it('a stop ends a task that waits on a server not yet ready', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-floor-srv-'))
  const floor = localFloor()
  const stop = new AbortController()
  try {
    const pending = floor.execute({
      taskId: 's#e2e',
      workspaceRoot: dir,
      outputs: { files: [], workspaceFiles: [] },
      command: 'true',
      forwardArgs: [],
      cwd: dir,
      env: { PATH: process.env['PATH'] },
      envDefine: {},
      capture: { stdout: false, stderr: false },
      onStdout: () => {},
      onStderr: () => {},
      signal: stop.signal,
      servers: [
        {
          taskId: 's#srv',
          command: 'echo booting; exec sleep 60',
          cwd: dir,
          env: { PATH: process.env['PATH'] },
          readyWhen: 'never',
        },
      ],
    })
    await Bun.sleep(100)
    stop.abort('SIGTERM')
    const r = await Promise.race([pending, Bun.sleep(3000).then(() => 'hung' as const)])
    expect(r === 'hung' ? r : r.exitCode).toBe(143)
  } finally {
    await floor.close()
  }
}, 20_000)

// A server that crashed after it became ready was handed to every later
// task as up: the dependant ran against nothing and failed on its own
// "connection refused", with no word that the server had died.
it('a task after its server crashed is told the server exited', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-floor-srv-'))
  const floor = localFloor()
  const heard: string[] = []
  const task = (n: number, command: string): ExecuteRequest => ({
    taskId: `s#t${n}`,
    workspaceRoot: dir,
    outputs: { files: [], workspaceFiles: [] },
    command,
    forwardArgs: [],
    cwd: dir,
    env: { PATH: process.env['PATH'] },
    envDefine: {},
    capture: { stdout: false, stderr: false },
    onStdout: () => {},
    onStderr: (t) => heard.push(t),
    servers: [
      {
        taskId: 's#srv',
        command: 'echo up; while [ ! -f down ]; do sleep 0.02; done; exit 3',
        cwd: dir,
        env: { PATH: process.env['PATH'] },
        readyWhen: 'up',
      },
    ],
  })
  try {
    expect((await floor.execute(task(1, 'touch down; sleep 0.3'))).exitCode).toBe(0)
    const r = await floor.execute(task(2, 'true'))
    expect([r.exitCode, heard.join('')]).toEqual([
      1,
      's#srv, which s#t2 depends on, exited with code 3 after it was ready\n',
    ])
  } finally {
    await floor.close()
  }
}, 20_000)

it('CONTROL: a server that exited 0 (a setup step) still serves the next task', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-floor-srv-'))
  const floor = localFloor()
  const task = (n: number): ExecuteRequest => ({
    taskId: `s#t${n}`,
    workspaceRoot: dir,
    outputs: { files: [], workspaceFiles: [] },
    command: 'sleep 0.1',
    forwardArgs: [],
    cwd: dir,
    env: { PATH: process.env['PATH'] },
    envDefine: {},
    capture: { stdout: false, stderr: false },
    onStdout: () => {},
    onStderr: () => {},
    servers: [
      { taskId: 's#srv', command: 'echo migrated', cwd: dir, env: { PATH: process.env['PATH'] } },
    ],
  })
  try {
    expect((await floor.execute(task(1))).exitCode).toBe(0)
    expect((await floor.execute(task(2))).exitCode).toBe(0)
  } finally {
    await floor.close()
  }
}, 20_000)

// A shell that exits before ready can leave what it forked running
// (`server & …; exit`): the next task starts the server again, and the
// leftover held its port until the worker closed (as persistent-task.ts
// stops it in a run).
it('a server that exits before ready leaves nothing it forked running', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-floor-srv-'))
  const floor = localFloor()
  try {
    const r = await floor.execute({
      taskId: 's#t',
      workspaceRoot: dir,
      outputs: { files: [], workspaceFiles: [] },
      command: 'true',
      forwardArgs: [],
      cwd: dir,
      env: { PATH: process.env['PATH'] },
      envDefine: {},
      capture: { stdout: false, stderr: false },
      onStdout: () => {},
      onStderr: () => {},
      servers: [
        {
          taskId: 's#srv',
          command: 'sleep 30 & echo $! > bg.pid; exit 3',
          cwd: dir,
          env: { PATH: process.env['PATH'] },
          readyWhen: 'up',
        },
      ],
    })
    const pid = Number(await readFile(path.join(dir, 'bg.pid'), 'utf8'))
    expect([r.exitCode, isAlive(pid)]).toEqual([1, false])
  } finally {
    await floor.close()
  }
}, 20_000)

it('says why a server could not spawn, and closes after it', async () => {
  // `runPersistent` hands back no child when the spawn throws: the floor
  // read `.exited` off it, so the dependant failed on a TypeError instead
  // of the reason, and `close()` threw on the same missing child.
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-floor-srv-'))
  const floor = localFloor()
  const heard: string[] = []
  const r = await floor.execute({
    taskId: 's#live',
    workspaceRoot: dir,
    outputs: { files: [], workspaceFiles: [] },
    command: 'true',
    forwardArgs: [],
    cwd: dir,
    env: { PATH: process.env['PATH'] },
    envDefine: {},
    capture: { stdout: false, stderr: false },
    onStdout: () => {},
    onStderr: (t) => heard.push(t),
    servers: [
      {
        taskId: 's#srv',
        command: 'exec sleep 60',
        cwd: path.join(dir, 'gone'),
        env: { PATH: process.env['PATH'] },
      },
    ],
  })
  expect(r.exitCode).toBe(1)
  expect(heard.join('')).toContain(
    `s#srv, which s#live depends on, did not start: failed to spawn persistent task: its working directory ${path.join(dir, 'gone')} does not exist`,
  )
  await floor.close()
}, 20_000)
