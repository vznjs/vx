// A run explorer can be built on the plugin API alone (spec
// org/product/run-explorer-spec.md): a CI run that writes the remote keeps
// a failed task's log and outputs and an uncached task's log (core does,
// under run names), a plugin writes its own manifest from the report its
// teardown gets, and its verb reads all of it back from the remote on a
// machine with no local cache. Each task's bytes leave when it ends, and
// `cache.upload.failures` says which runs keep failures (2026-10-16).
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
      put: async (h, b) => { globalThis.__vxPuts?.push(Date.now()); globalThis.__vxWire.set(h, new Uint8Array(await b.arrayBuffer())) },
    }) }`,
)

const box = globalThis as unknown as {
  __vxWire: Map<string, Uint8Array>
  __vxPuts?: number[]
  __vxShown?: unknown
}

/** `lib#test` fails leaving a report, `docs#test` is uncached, `gen#build` saves an entry. */
async function fixture(cacheSettings = ''): Promise<void> {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'vx-run-record-')))
  await Bun.write(
    path.join(root, 'lib/vx.config.mjs'),
    `export default { tasks: { test: {
      exec: { command: 'mkdir -p reports && echo "1 failing" && echo boom > reports/junit.xml && exit 1' },
      inputs: { files: ['src/**'] }, cache: { outputs: { files: ['reports/**'] } },
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
      inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
    } } }`,
  )
  await Bun.write(path.join(root, 'gen/src/i.js'), 'x')
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([WIRE, RECORDER]).replace(
      'export default {',
      `export default { ${cacheSettings}`,
    ),
  )
  gitInitCommit(root)
  box.__vxWire = new Map()
}

const lines: string[] = []
const quiet = {
  status: (l: string) => lines.push(l),
  taskStart() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

const CI_VARS = ['GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'CI']
async function runAs(ci: boolean, tasks: string[], extra: object = {}) {
  const saved = CI_VARS.map((k) => [k, process.env[k]] as const)
  for (const k of CI_VARS) delete process.env[k]
  if (ci) process.env['CI'] = '1'
  try {
    return await run({
      cwd: root,
      tasks,
      handleSignals: false,
      log: quiet,
      ...(ci ? {} : { remoteReadOnlyByDefault: true }),
      ...extra,
    })
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

interface Shown {
  runId: string
  ok: boolean
  ciRun: { ci: boolean }
  tasks: { id: string; status: string; key?: string; log?: string; outputs?: Uint8Array }[]
}

/** The run the recorder kept, read back with no local cache. */
async function shown(): Promise<Shown> {
  const runId = lines.map((l) => /^run (\S+)$/.exec(l)?.[1]).findLast(Boolean) ?? ''
  expect(runId).not.toBe('')
  rmSync(path.join(root, '.vx', 'cache'), { recursive: true, force: true })
  process.chdir(root)
  expect(await cli(['show-run', runId])).toBe(0)
  return box.__vxShown as Shown
}

it("core keeps a CI run's logs and failed outputs, a plugin its manifest, and a verb reads both from the remote", async () => {
  await fixture()
  expect((await runAs(false, ['test'])).ok).toBe(false)
  expect(box.__vxWire.size).toBe(0)
  expect((await runAs(true, ['test', 'build'])).ok).toBe(false)
  const run = await shown()
  const task = (id: string) => run.tasks.find((t) => t.id === id)
  expect([run.ok, run.ciRun.ci]).toEqual([false, true])
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

it("`cache.upload.failures: 'local'` keeps no CI failure, and an uncached log still", async () => {
  await fixture("cache: { upload: { failures: 'local' } },")
  expect((await runAs(true, ['test'])).ok).toBe(false)
  const run = await shown()
  const task = (id: string) => run.tasks.find((t) => t.id === id)
  expect(task('docs#test')).toMatchObject({ status: 'success', log: 'links ok\n' })
  expect(task('lib#test')).toMatchObject({ status: 'failed' })
  expect(task('lib#test')).not.toHaveProperty('log')
  expect(task('lib#test')).not.toHaveProperty('outputs')
}, 30_000)

it("a local run that writes the remote keeps an uncached task's log, and no failure by default", async () => {
  // 2026-10-16: "Always keep". The uncached log goes up whenever the
  // remote takes the run's writes; `cache.upload.failures` gates failures only.
  await fixture()
  expect((await runAs(false, ['test'], { remoteReadOnlyByDefault: false })).ok).toBe(false)
  const run = await shown()
  const task = (id: string) => run.tasks.find((t) => t.id === id)
  expect(task('docs#test')).toMatchObject({ status: 'success', log: 'links ok\n' })
  expect(task('lib#test')).toMatchObject({ status: 'failed' })
  expect(task('lib#test')).not.toHaveProperty('log')
  expect(task('lib#test')).not.toHaveProperty('outputs')
}, 30_000)

it('the footer counts each task whose run bytes reached the remote', async () => {
  await fixture()
  lines.length = 0
  expect((await runAs(true, ['test', 'build'])).ok).toBe(false)
  const legend = lines[lines.findIndex((l) => l.startsWith('  cache')) + 1]?.trim()
  // gen#build's entry, docs#test's log, lib#test's log and outputs.
  expect(legend).toMatch(/remote 3\u2191 \d+ B$/)
}, 30_000)

it("a task's bytes leave when it ends, not when the run does", async () => {
  await fixture()
  await Bun.write(
    path.join(root, 'slow/vx.config.mjs'),
    `export default { tasks: { test: { exec: { command: 'sleep 1.5 && echo slow' } } } }`,
  )
  gitInitCommit(root, 'slow')
  box.__vxPuts = []
  try {
    const started = Date.now()
    expect((await runAs(true, ['lib#test', 'slow#test'], { continueMode: 'always' })).ok).toBe(
      false,
    )
    // lib#test's log and outputs went while slow#test still ran.
    expect(box.__vxPuts.length).toBeGreaterThan(0)
    expect(box.__vxPuts[0]! - started).toBeLessThan(1_200)
  } finally {
    delete box.__vxPuts
  }
}, 30_000)
