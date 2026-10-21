import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { createRelay } from '@vzn/vx-dte-relay'
import { localEnv } from '../src/agent.js'
import { fromParts, outputFiles, pack, toParts, unpack } from '../src/bundle.js'
import { dte, local } from '../src/index.js'
import type { ExecuteRequest, TaskNode } from '@vzn/vx'
import { Orchestrator } from '../src/orchestrator.js'
import { join } from '../src/wire.js'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-unit-'))
  dirs.push(d)
  return d
}

it('a bundle carries files, links and modes, in parts under the relay’s 1 MiB', async () => {
  const from = await tmp()
  await mkdir(path.join(from, 'p/out/deep'), { recursive: true })
  await writeFile(path.join(from, 'p/out/deep/a.sh'), 'echo hi\n', { mode: 0o755 })
  await writeFile(
    path.join(from, 'p/out/big.bin'),
    crypto.getRandomValues(new Uint8Array(65536)).join(','),
  )
  await symlink('deep/a.sh', path.join(from, 'p/out/link'))
  await writeFile(path.join(from, 'p/out/skip.map'), '')
  const files = await outputFiles(from, 'p', {
    files: ['out/**', '!out/*.map'],
    workspaceFiles: [],
  })
  expect(files).toEqual(['p/out/big.bin', 'p/out/deep/a.sh', 'p/out/link'])
  const parts = toParts(await pack(from, files, { exitCode: 0 }))
  for (const part of parts) expect(part.length).toBeLessThan(1 << 20)
  const to = await tmp()
  expect(await unpack(to, fromParts(parts))).toEqual({ exitCode: 0 })
  expect(await readFile(path.join(to, 'p/out/deep/a.sh'), 'utf8')).toBe('echo hi\n')
  expect((await lstat(path.join(to, 'p/out/deep/a.sh'))).mode & 0o777).toBe(0o755)
  expect(await readlink(path.join(to, 'p/out/link'))).toBe('deep/a.sh')
})

it('a bundle may not write outside the root', async () => {
  const from = await tmp()
  await writeFile(path.join(from, 'x'), 'x')
  const bundle = await pack(from, ['x'], null)
  const raw = new Uint8Array(await Bun.zstdDecompress(bundle))
  // Rename `x` to `..`-something of the same length is not possible; build one.
  const evil = Buffer.concat([
    raw.subarray(0, 8),
    Buffer.from([0, 0, 0, 4]),
    Buffer.from('../x'),
    raw.subarray(13),
  ])
  await expect(unpack(await tmp(), await Bun.zstdCompress(evil))).rejects.toThrow(
    'unsafe path ../x',
  )
})

it('an agent runs the orchestrator’s env with its own root, host names and PATH', () => {
  const saved = { HOME: process.env['HOME'], PATH: process.env['PATH'] }
  process.env['HOME'] = '/agent/home'
  process.env['PATH'] = '/usr/bin'
  try {
    expect(
      localEnv(
        {
          HOME: '/orc/home',
          PATH: '/orc/ws/node_modules/.bin:/opt/orc',
          VX_RUN_WORKSPACE: '/orc/ws',
          X: '1',
        },
        '/orc/ws',
        '/agent/ws',
      ),
    ).toMatchObject({
      HOME: '/agent/home',
      PATH: '/agent/ws/node_modules/.bin:/usr/bin',
      VX_RUN_WORKSPACE: '/agent/ws',
      X: '1',
    })
  } finally {
    Object.assign(process.env, saved)
  }
})

it('an agent on another commit is refused', async () => {
  const relay = createRelay()
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => relay.fetch(r) })
  const url = `http://127.0.0.1:${server.port}`
  try {
    const o = new Orchestrator({
      me: await join(url, 'r', 'orchestrator', null, undefined),
      root: '/ws',
      commit: 'aaa',
      localSlots: 0,
      nodes: () => undefined,
      need: () => ({ cores: 1, memory: 0 }),
    })
    const agent = await join(
      url,
      'r',
      'agent',
      { v: 1, size: 's', cores: 1, memory: 1, commit: 'bbb' },
      undefined,
    )
    let got: unknown[] = []
    for (let i = 0; i < 20 && got.length === 0; i++) got = await agent.poll()
    expect(got).toEqual([
      {
        from: 'orchestrator',
        body: { type: 'refused', reason: 'checked out bbb, the run is on aaa' },
      },
    ])
    await o.close()
  } finally {
    relay.close()
    await server.stop(true)
  }
})

/** An orchestrator on a loopback relay, and agents of it that only listen. */
async function harness(nodes: Map<string, TaskNode>) {
  const relay = createRelay()
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (r) => relay.fetch(r) })
  const url = `http://127.0.0.1:${server.port}`
  const o = new Orchestrator({
    me: await join(url, 'r', 'orchestrator', null, undefined),
    root: '/ws',
    commit: 'c',
    localSlots: 0,
    nodes: () => nodes,
    need: () => ({ cores: 1, memory: 10 }),
  })
  const agent = async (cores: number) => {
    const me = await join(
      url,
      'r',
      'agent',
      { v: 1, size: 's', cores, memory: 100, commit: 'c' },
      undefined,
    )
    const batches = async (): Promise<string[][]> => {
      for (let i = 0; i < 20; i++) {
        const got = (await me.poll()).map(
          (m) => m.body as { type: string; tasks?: { task: string }[] },
        )
        const b = got.filter((m) => m.type === 'batch').map((m) => m.tasks!.map((t) => t.task))
        if (b.length > 0) return b
      }
      return []
    }
    const finish = async (task: string): Promise<void> => {
      const res = { exitCode: 0, durationMs: 1, stdout: '', stderr: '' }
      const parts = toParts(await pack('/nonexistent', [], res))
      for (const data of parts) await me.send('orchestrator', { type: 'part', task, data })
      await me.send('orchestrator', { type: 'end', task, parts: parts.length })
    }
    return { batches, finish }
  }
  const req = (taskId: string) =>
    ({
      taskId,
      workspaceRoot: '/ws',
      command: 'true',
      forwardArgs: [],
      cwd: '/ws',
      env: {},
      envDefine: {},
      outputs: { files: [], workspaceFiles: [] },
      onStdout() {},
      onStderr() {},
    }) as unknown as ExecuteRequest
  const stop = async () => {
    await o.close()
    relay.close()
    await server.stop(true)
  }
  return { o, agent, req, stop }
}

const node = (id: string, deps: string[] = []) =>
  [id, { id, deps, projectDir: '/ws', config: {} } as unknown as TaskNode] as const

it('fills an agent’s cores and a prefetch in one batch', async () => {
  const h = await harness(new Map([node('t1'), node('t2'), node('t3'), node('t4')]))
  try {
    const a = await h.agent(2)
    await Bun.sleep(50)
    for (const id of ['t1', 't2', 't3', 't4']) void h.o.execute(h.req(id))
    // 2 cores and 1 of prefetch: t4 waits for one to finish.
    expect(await a.batches()).toEqual([['t1', 't2', 't3']])
    await a.finish('t1')
    expect(await a.batches()).toEqual([['t4']])
  } finally {
    await h.stop()
  }
})

it('sends a task to the agent that holds its dependency’s outputs', async () => {
  const h = await harness(new Map([node('x'), node('y', ['x'])]))
  try {
    const small = await h.agent(1)
    await Bun.sleep(50)
    const ran = h.o.execute(h.req('x'))
    expect(await small.batches()).toEqual([['x']])
    await small.finish('x')
    await ran
    const big = await h.agent(8)
    await Bun.sleep(50)
    void h.o.execute(h.req('y'))
    expect(await small.batches()).toEqual([['y']])
    void big
  } finally {
    await h.stop()
  }
})

const refusal = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('refuses options it does not read and agents it cannot start', () => {
  const adapter = local()
  expect(refusal(() => dte({ agents: {}, adapter, relays: 'x' } as never))).toContain(
    'dte() has unknown option "relays"',
  )
  expect(refusal(() => dte({ agents: { s: { max: 1, cpu: 0 } }, adapter }))).toBe(
    'dte(): agents.s needs a whole max ≥ 0 and cpu ≥ 1',
  )
  expect(refusal(() => local({ prepar: 'x' } as never))).toContain(
    'local() has unknown option "prepar"',
  )
  expect(refusal(() => dte({ agents: {}, adapter }))).toBe('taken')
})

it('a run that is not distributed loads none of it', async () => {
  // Every run evaluates `.vx/workspace.ts`: importing the plugin may not
  // load the orchestrator, the agent or the relay.
  const probe = `
const seen = []
Bun.plugin({ name: 'seen', setup(b) {
  b.onLoad({ filter: /(vx-dte|vx-dte-relay)\\/src\\/[^/]+\\.ts$/ }, async (a) => {
    seen.push(a.path.split('/').slice(-3).join('/'))
    return { contents: await Bun.file(a.path).text(), loader: 'ts' }
  })
} })
const m = await import(process.argv[1])
m.dte({ agents: {}, adapter: m.local() })
console.log(JSON.stringify(seen.sort()))
`
  const p = Bun.spawnSync([
    process.execPath,
    '-e',
    probe,
    path.join(import.meta.dir, '..', 'src', 'index.ts'),
  ])
  expect(JSON.parse(p.stdout.toString())).toEqual([
    'vx-dte/src/index.ts',
    'vx-dte/src/local.ts',
    'vx-dte/src/plugin.ts',
  ])
})
