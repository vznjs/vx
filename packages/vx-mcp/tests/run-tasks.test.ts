// `runTasks`: an agent runs tasks and reads the run's summary, not the
// frame. The tool spawns `vx run --format json`, so each row drives a real
// vx: the handler with the context's argv, and once through `vx mcp`
// itself, where that argv comes from the verb's own context.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { handleToolCall, listTools } from '../src/tools.js'
import { handleMessage } from '../src/server.js'
import { mcp } from '../src/index.js'

const CORE_BIN = path.resolve(import.meta.dir, '../../vx/src/bin.ts')
const PLUGIN_ENTRY = path.resolve(import.meta.dir, '../src/index.ts')

let root: string
let ctx: { cacheDir: string; workspaceRoot: string; vx: readonly string[] }

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-mcp-run-'))
  ctx = {
    cacheDir: path.join(root, '.vx', 'cache'),
    workspaceRoot: root,
    vx: [process.execPath, CORE_BIN],
  }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  for (const name of ['a', 'b']) {
    await mkdir(path.join(root, 'packages', name), { recursive: true })
    await writeFile(path.join(root, 'packages', name, 'package.json'), JSON.stringify({ name }))
  }
  await writeFile(
    path.join(root, 'packages', 'a', 'vx.config.mjs'),
    `export default { tasks: {
      build: { exec: { command: 'echo built-a' } },
      fail: { exec: { command: 'echo token=s3cr3t-value >&2; exit 3', env: { secret: ['TOKEN'] } } },
    } }\n`,
  )
  await writeFile(
    path.join(root, 'packages', 'b', 'vx.config.mjs'),
    `export default { tasks: { build: { exec: { command: 'echo built-b' } } } }\n`,
  )
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `import { mcp } from ${JSON.stringify(PLUGIN_ENTRY)}\nexport default { plugins: [mcp()] }\n`,
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

interface Summary {
  ok: boolean
  tasks: Array<{ id: string; status: string }>
}

const ids = (s: Summary): string[] => s.tasks.map((t) => `${t.id}:${t.status}`).sort()

describe('runTasks', () => {
  it('runs the tasks the flags select and answers the run summary', async () => {
    const all = (await handleToolCall('runTasks', { tasks: ['build'], all: true }, ctx)) as {
      exitCode: number
      summary: Summary
    }
    expect({ exitCode: all.exitCode, ok: all.summary.ok, tasks: ids(all.summary) }).toEqual({
      exitCode: 0,
      ok: true,
      tasks: ['a#build:success', 'b#build:success'],
    })
    // CONTROL: the filter narrows the run, so the flags reach the CLI.
    const one = (await handleToolCall('runTasks', { tasks: ['build'], filter: ['b'] }, ctx)) as {
      summary: Summary
    }
    expect(ids(one.summary)).toEqual(['b#build:success'])
  })

  it('a failed task is a summary with ok false and the exit code', async () => {
    const r = (await handleToolCall('runTasks', { tasks: ['a#fail'] }, ctx)) as {
      exitCode: number
      summary: Summary
    }
    expect({ exitCode: r.exitCode, ok: r.summary.ok, tasks: ids(r.summary) }).toEqual({
      exitCode: 1,
      ok: false,
      tasks: ['a#fail:failed'],
    })
  })

  it('a refusal before the run answers the CLI message, not a summary', async () => {
    const r = await handleToolCall('runTasks', { tasks: ['nope'], all: true }, ctx)
    expect(Object.keys(r).sort()).toEqual(['code', 'error', 'exitCode'])
    expect([r['exitCode'], r['code']]).toEqual([1, 'VX_E_UNKNOWN_TASK'])
    expect(r['error']).toContain('no projects declare task(s): nope')
  })

  it('refuses an argument that would pass as a flag or is the wrong shape', async () => {
    const refusal = (args: unknown): Promise<string> =>
      handleToolCall('runTasks', args, ctx).then(
        () => 'answered',
        (e: Error) => e.message,
      )
    expect(await refusal({ tasks: ['--all'] })).toContain('none starting with "-"')
    expect(await refusal({ tasks: [] })).toContain('non-empty array')
    expect(await refusal({ tasks: ['build'], all: 'yes' })).toBe('runTasks: all must be a boolean')
    expect(await refusal({ tasks: ['build'], filter: 'a' })).toContain('filter must be an array')
    expect(await refusal({ tasks: ['build'], affected: 5 })).toContain('affected must be')
  })

  it('runs through `vx mcp`, which hands the tool the argv of its own vx', async () => {
    const p = Bun.spawn({
      cmd: [process.execPath, CORE_BIN, 'mcp'],
      cwd: root,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    void p.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'runTasks', arguments: { tasks: ['a#build'] } },
      }) + '\n',
    )
    void p.stdin.end()
    const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()])
    expect(code).toBe(0)
    const reply = JSON.parse(out.trim()) as { result: { content: Array<{ text: string }> } }
    const answer = JSON.parse(reply.result.content[0]!.text) as {
      exitCode: number
      summary: Summary
    }
    expect({ exitCode: answer.exitCode, tasks: ids(answer.summary) }).toEqual({
      exitCode: 0,
      tasks: ['a#build:success'],
    })
  })
})

// `mcp({ run })`: a workspace narrows what an agent may run.
describe('mcp({ run })', () => {
  it('false takes runTasks off the list and refuses a call', async () => {
    const off = { ...ctx, run: false }
    expect(listTools(off).map((t) => t.name)).not.toContain('runTasks')
    // CONTROL: the default lists it.
    expect(listTools(ctx).map((t) => t.name)).toContain('runTasks')
    const viaServer = (await handleMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'runTasks', arguments: { tasks: ['a#build'] } },
      }),
      off,
    )) as { error: { message: string } }
    expect(viaServer.error.message).toBe('tools/call: unknown tool: runTasks')
    const direct = await handleToolCall('runTasks', { tasks: ['a#build'] }, off).then(
      () => 'ran',
      (e: Error) => e.message,
    )
    expect(direct).toBe('runTasks: off in this workspace (mcp({ run: false }))')
  })

  it('a list runs the tasks it names and refuses the rest before anything runs', async () => {
    const only = { ...ctx, run: ['build'] }
    const ok = (await handleToolCall('runTasks', { tasks: ['a#build'], force: true }, only)) as {
      summary: Summary
    }
    expect(ids(ok.summary)).toEqual(['a#build:success'])
    const refused = await handleToolCall('runTasks', { tasks: ['build', 'a#fail'] }, only).then(
      () => 'ran',
      (e: Error) => e.message,
    )
    expect(refused).toBe('runTasks: a#fail not allowed here — mcp({ run }) allows build')
  })

  it('refuses a run option that is not true, false or task names', () => {
    for (const run of ['build', [''], [1]] as unknown as boolean[]) {
      expect(() => mcp({ run })).toThrow(
        'mcp({ run }): run must be true, false or an array of task names',
      )
    }
    // CONTROL: each accepted shape builds.
    for (const run of [true, false, ['test']]) expect(() => mcp({ run })).not.toThrow()
  })
})
