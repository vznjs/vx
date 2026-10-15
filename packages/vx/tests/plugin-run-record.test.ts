// A run explorer can be built on the plugin API alone (spec
// org/product/run-explorer-spec.md): a CI run that writes the remote keeps
// a failed task's log and outputs and an uncached task's log (core does,
// under run names), a plugin writes its own manifest from the report its
// teardown gets, and its verb reads all of it back from the remote on a
// machine with no local cache.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { gitInitCommit } from './helpers/workspace.js'
import { run } from './helpers/orchestrator.js'
import { run as cli } from './helpers/cli.js'
import { pluginSource } from './helpers/plugin.js'

let root = ''
const prevCwd = process.cwd()
afterEach(() => {
  process.chdir(prevCwd)
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

const RECORDER = pluginSource(
  'org/recorder',
  `(() => {
    let ctx
    return {
      setup(c) { ctx = c },
      async teardown(run) {
        if (run === undefined || !run.tasks.some((t) => t.log || t.outputs)) return
        await ctx.cache.put('run/' + run.runId, new TextEncoder().encode(JSON.stringify(run)))
        ctx.warn('run ' + run.runId)
      },
      commands: { 'show-run': { description: 'print a run', async run([id], c) {
        const run = JSON.parse(new TextDecoder().decode(await c.cache.get('run/' + id)))
        for (const t of run.tasks) {
          if (t.log) t.log = new TextDecoder().decode(await c.cache.getRun(t.log))
          if (t.outputs) t.outputs = await c.cache.getRun(t.outputs)
        }
        globalThis.__vxShown = run
        return 0
      } } },
    }
  })()`,
)

const WIRE = pluginSource(
  'org/wire',
  `{ cache: () => ({
      has: async (h) => globalThis.__vxWire.has(h),
      get: async (h) => globalThis.__vxWire.has(h) ? { body: new Blob([globalThis.__vxWire.get(h)]), durationMs: undefined } : null,
      put: async (h, b) => { globalThis.__vxWire.set(h, new Uint8Array(await b.arrayBuffer())) },
    }) }`,
)

it("core keeps a CI run's logs and failed outputs, a plugin its manifest, and a verb reads both from the remote", async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'vx-run-record-')))
  await Bun.write(
    path.join(root, 'lib/vx.config.mjs'),
    `export default { tasks: { test: {
      exec: { command: 'mkdir -p reports && echo "1 failing" && echo boom > reports/junit.xml && exit 1' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['reports/**'] } },
    } } }`,
  )
  await Bun.write(path.join(root, 'lib/src/i.js'), 'x')
  await Bun.write(
    path.join(root, 'docs/vx.config.mjs'),
    `export default { tasks: { test: { exec: { command: 'echo links ok' } } } }`,
  )
  await Bun.write(
    path.join(root, 'gen/vx.config.mjs'),
    `export default { tasks: { build: {
      exec: { command: 'echo generated' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
    } } }`,
  )
  await Bun.write(path.join(root, 'gen/src/i.js'), 'x')
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([WIRE, RECORDER]))
  gitInitCommit(root)
  const box = globalThis as unknown as { __vxWire: Map<string, Uint8Array>; __vxShown?: unknown }
  box.__vxWire = new Map()
  const lines: string[] = []
  const quiet = {
    status: (l: string) => lines.push(l),
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
  }

  const CI_VARS = ['GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'CI']
  const saved = CI_VARS.map((k) => [k, process.env[k]] as const)
  const runAs = async (ci: boolean) => {
    for (const k of CI_VARS) delete process.env[k]
    if (ci) process.env['CI'] = '1'
    try {
      return await run({
        cwd: root,
        tasks: ci ? ['test', 'build'] : ['test'],
        handleSignals: false,
        log: quiet,
        ...(ci ? {} : { remoteReadOnlyByDefault: true }),
      })
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }
  expect((await runAs(false)).ok).toBe(false)
  expect(box.__vxWire.size).toBe(0)
  expect((await runAs(true)).ok).toBe(false)
  const runId = lines.map((l) => /^run (\S+)$/.exec(l)?.[1]).find(Boolean) ?? ''
  expect(runId).not.toBe('')

  rmSync(path.join(root, '.vx', 'cache'), { recursive: true, force: true })
  process.chdir(root)
  expect(await cli(['show-run', runId])).toBe(0)
  const shown = box.__vxShown as {
    runId: string
    ok: boolean
    ciRun: { ci: boolean }
    tasks: { id: string; status: string; key?: string; log?: string; outputs?: Uint8Array }[]
  }
  const task = (id: string) => shown.tasks.find((t) => t.id === id)
  expect([shown.runId, shown.ok, shown.ciRun.ci]).toEqual([runId, false, true])
  expect(task('docs#test')).toMatchObject({ status: 'success', log: 'links ok\n' })
  expect(task('lib#test')).toMatchObject({ status: 'failed', log: '1 failing\n' })
  // A task that saved an entry: its log is the entry's, core keeps no copy.
  expect(task('gen#build')).toMatchObject({ status: 'success', key: expect.any(String) })
  expect(task('gen#build')).not.toHaveProperty('log')
  const tar = path.join(root, 'out.tar')
  await Bun.write(tar, task('lib#test')!.outputs!)
  const file = Bun.spawnSync(['tar', '-xOf', tar, 'lib/reports/junit.xml'])
  expect(file.stdout.toString()).toBe('boom\n')
}, 30_000)
