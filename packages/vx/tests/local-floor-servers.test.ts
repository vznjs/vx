// A task's persistent dependencies on a worker (`localFloor`): two shards
// that land on one machine share its server, started once; each other
// machine starts its own (vx-dte's local-e2e test).
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import type { ExecuteRequest } from '../src/exec/executor.js'
import { localFloor } from '../src/orchestrator/local-floor.js'

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
