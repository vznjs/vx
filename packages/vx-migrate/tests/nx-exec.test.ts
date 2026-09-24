// `nx-exec` against the FAKE `nx` package (`helpers/fake-nx.ts`), which
// records what the bin hands Nx's `runExecutor` and yields the results the
// injected options ask for. Real Nx is the live suite
// (`nx-exec-live.test.ts`, gated on VX_NX_MODULES); this one pins the bin's
// own contract — argv, the graph injection, the exit — without a network
// install.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { fakeNx } from './helpers/fake-nx.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'nx-exec.cjs')

const GRAPH = {
  nodes: {
    app: {
      name: 'app',
      type: 'app',
      data: {
        root: 'packages/app',
        targets: { build: { executor: '@nx/js:tsc', options: { fromProjectJson: true } } },
      },
    },
    lib: { name: 'lib', type: 'lib', data: { root: 'packages/lib', targets: {} } },
  },
  dependencies: { app: [{ source: 'app', target: 'lib', type: 'static' }], lib: [] },
}

let root: string
let cwd: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-exec-'))
  cwd = path.join(root, 'packages', 'app')
  await mkdir(cwd, { recursive: true })
  await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"name":"ws","private":true}')
  await writeFile(path.join(root, 'nx.json'), JSON.stringify({ namedInputs: { default: ['x'] } }))
  await writeFile(
    path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
    JSON.stringify(GRAPH),
  )
  await fakeNx(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

interface Ran {
  code: number
  out: string
  err: string
}

async function nxExec(args: string[], env: Record<string, string> = {}): Promise<Ran> {
  const clean = { ...process.env }
  delete clean['NX_DAEMON']
  const p = Bun.spawn(['node', BIN, ...args], {
    cwd,
    env: { ...clean, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, out, err }
}

async function record(): Promise<Record<string, unknown>> {
  return (await Bun.file(path.join(root, 'record.json')).json()) as Record<string, unknown>
}

describe('nx-exec', () => {
  it('runs the executor named on the command line with the options given, not project.json’s', async () => {
    const out = path.join(cwd, 'out.txt')
    const r = await nxExec([
      '@acme/thing:do',
      '--project',
      'app',
      '--target',
      'build',
      '--options',
      JSON.stringify({ writeFile: out, nested: { a: [1, 'two'] } }),
    ])
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
    const rec = await record()
    expect(rec['description']).toEqual({ project: 'app', target: 'build' })
    expect(rec['overrides']).toEqual({})
    // The injected target: the command line's executor and options,
    // project.json's `fromProjectJson` gone.
    expect(rec['target']).toEqual({
      executor: '@acme/thing:do',
      options: { writeFile: out, nested: { a: [1, 'two'] } },
    })
    expect(rec['context']).toEqual({
      root,
      cwd,
      projectName: 'app',
      targetName: 'build',
      configurationName: undefined,
      nxJson: { namedInputs: { default: ['x'] } },
      projects: ['app', 'lib'],
      taskGraph: 'absent',
    })
    // The daemon is off before nx loads; the executor ran (the file is there).
    expect(rec['env']).toEqual({ NX_DAEMON: 'false' })
    expect(await Bun.file(out).text()).toBe('executor wrote this')
  })

  it('a configuration is declared on the injected target and named in the description', async () => {
    const r = await nxExec(['x:y', '--project=app', '--target=build', '--configuration=production'])
    expect(r.code).toBe(0)
    const rec = await record()
    expect(rec['description']).toEqual({
      project: 'app',
      target: 'build',
      configuration: 'production',
    })
    expect(rec['target']).toEqual({
      executor: 'x:y',
      options: {},
      configurations: { production: {} },
    })
    expect((rec['context'] as { configurationName: string }).configurationName).toBe('production')
  })

  it('the exit is the LAST result’s, as `nx run` reports it', async () => {
    const results = (rs: { success: boolean }[]) => [
      'x:y',
      '--project',
      'app',
      '--target',
      'build',
      '--options',
      JSON.stringify({ results: rs }),
    ]
    expect((await nxExec(results([{ success: true }, { success: false }]))).code).toBe(1)
    expect((await nxExec(results([{ success: false }, { success: true }]))).code).toBe(0)
    // No result at all is a failure, not a silent pass.
    expect((await nxExec(results([]))).code).toBe(1)
  })

  it('what it does not know is Nx’s: overrides parsed by Nx’s createOverrides, a repeated own flag included (nx#12165)', async () => {
    const r = await nxExec([
      'x:y',
      '--project',
      'app',
      '--target',
      'build',
      '--options',
      '{"registry":"x"}',
      '--otp=123',
      'extra',
      '--project=other',
    ])
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
    const rec = await record()
    expect(rec['description']).toEqual({ project: 'app', target: 'build' })
    // Parsed by Nx; its unparsed copy is runExecutor's to derive, not a flag to pass.
    expect(rec['overrides']).toEqual({ otp: 123, project: 'other' })
    expect(rec['target']).toEqual({ executor: 'x:y', options: { registry: 'x' } })
  })

  it('a project the graph does not have is exit 1 with its name', async () => {
    const r = await nxExec(['x:y', '--project', 'nope', '--target', 'build'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('no project "nope" in the Nx project graph')
  })

  it('usage errors are exit 2 before nx is loaded', async () => {
    const rows: [string[], string][] = [
      [[], 'expected one executor (got 0)'],
      [['nocolon', '--project', 'app', '--target', 'build'], 'executor must be <package>:<name>'],
      [['x:y', '--target', 'build'], '--project is required'],
      [['x:y', '--project', 'app'], '--target is required'],
      [
        ['x:y', '--project', 'app', '--target', 'build', '--options', '{bad'],
        '--options is not JSON',
      ],
      [
        ['x:y', '--project', 'app', '--target', 'build', '--options', '[1]'],
        '--options must be a JSON object',
      ],
      [['x:y', '--project', 'app', '--target'], '--target needs a value'],
    ]
    for (const [args, message] of rows) {
      const r = await nxExec(args)
      expect({ args, code: r.code, hit: r.err.includes(message) }).toEqual({
        args,
        code: 2,
        hit: true,
      })
      expect(await Bun.file(path.join(root, 'record.json')).exists()).toBe(false)
    }
    const help = await nxExec(['--help'])
    expect({ code: help.code, out: help.out.startsWith('usage: nx-exec <executor>') }).toEqual({
      code: 0,
      out: true,
    })
  })

  it('no cached graph: computed in-process with the daemon off, then run', async () => {
    await rm(path.join(root, '.nx', 'workspace-data', 'project-graph.json'))
    await writeFile(path.join(root, 'fallback-graph.json'), JSON.stringify(GRAPH))
    const r = await nxExec(['x:y', '--project', 'app', '--target', 'build'])
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
    expect(await Bun.file(path.join(root, 'computed.marker')).text()).toBe('false')
    expect((await record())['description']).toEqual({ project: 'app', target: 'build' })
  })

  it('a cache file in `nx graph --file` shape (`{ graph: … }`) is unwrapped', async () => {
    await writeFile(
      path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
      JSON.stringify({ graph: GRAPH }),
    )
    const r = await nxExec(['x:y', '--project', 'lib', '--target', 't'])
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
    expect(await Bun.file(path.join(root, 'computed.marker')).exists()).toBe(false)
  })

  it('a cache with no nodes at all falls through to the computed graph', async () => {
    await writeFile(
      path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
      '{"version":"6.0"}',
    )
    await writeFile(path.join(root, 'fallback-graph.json'), JSON.stringify(GRAPH))
    const r = await nxExec(['x:y', '--project', 'app', '--target', 'build'])
    expect(r.code).toBe(0)
    expect(await Bun.file(path.join(root, 'computed.marker')).exists()).toBe(true)
  })

  it('NX_DAEMON set by the caller is kept', async () => {
    const r = await nxExec(['x:y', '--project', 'app', '--target', 'build'], { NX_DAEMON: 'true' })
    expect(r.code).toBe(0)
    expect((await record())['env']).toEqual({ NX_DAEMON: 'true' })
  })

  it('no nx in the workspace is exit 1 naming the directory', async () => {
    await rm(path.join(root, 'node_modules'), { recursive: true })
    const r = await nxExec(['x:y', '--project', 'app', '--target', 'build'])
    expect(r.code).toBe(1)
    expect(r.err).toContain(`cannot resolve \`nx\` from ${cwd}`)
  })
})
