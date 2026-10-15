// A run explorer can be built on the plugin API alone (spec
// org/product/run-explorer-spec.md): on CI a plugin keeps each task's log
// and what a failed task left, under its own cache entries, with a manifest
// named by the run id; its verb reads them back from the remote on a
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
    let finish
    const enc = (s) => new TextEncoder().encode(s)
    return {
      setup(ctx) {
        finish = undefined
        if (!ctx.ci) return
        const logs = new Map()
        const done = []
        const append = (node, chunk) => logs.set(node.id, (logs.get(node.id) ?? '') + chunk)
        ctx.on('onTaskStdout', append)
        ctx.on('onTaskStderr', append)
        ctx.on('onTaskComplete', (node, outcome) => {
          done.push({ node, outcome, outputs: outcome.status === 'failed' ? ctx.outputsOf(node) : undefined })
        })
        finish = async () => {
          const tasks = []
          for (const { node, outcome, outputs } of done) {
            const task = { id: node.id, status: outcome.status, log: 'log/' + ctx.runId + '/' + node.id }
            await ctx.cache.put(task.log, enc(logs.get(node.id) ?? ''))
            if (outputs) {
              task.outputs = []
              for (const rel of await outputs) {
                const name = 'out/' + ctx.runId + '/' + rel
                await ctx.cache.put(name, await Bun.file(ctx.workspaceRoot + '/' + rel).bytes())
                task.outputs.push({ path: rel, name })
              }
            }
            tasks.push(task)
          }
          const manifest = { runId: ctx.runId, commit: ctx.commit, ci: ctx.ciRun, tasks }
          await ctx.cache.put('run/' + ctx.runId, enc(JSON.stringify(manifest)))
          ctx.warn('run ' + ctx.runId)
        }
      },
      async teardown() { await finish?.() },
      commands: { 'show-run': { description: 'print a run', async run([id], ctx) {
        const dec = (b) => b && new TextDecoder().decode(b)
        const manifest = JSON.parse(dec(await ctx.cache.get('run/' + id)))
        for (const t of manifest.tasks) {
          t.log = dec(await ctx.cache.get(t.log))
          for (const o of t.outputs ?? []) o.bytes = dec(await ctx.cache.get(o.name))
        }
        globalThis.__vxShown = manifest
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

it("a plugin records a CI run's logs and failed outputs, and its verb reads them from the remote", async () => {
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
      return await run({ cwd: root, tasks: ['test'], handleSignals: false, log: quiet })
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
  expect(box.__vxShown).toMatchObject({
    runId,
    ci: { ci: true },
    tasks: expect.arrayContaining([
      { id: 'docs#test', status: 'success', log: 'links ok\n' },
      {
        id: 'lib#test',
        status: 'failed',
        log: '1 failing\n',
        outputs: [
          {
            path: 'lib/reports/junit.xml',
            name: `out/${runId}/lib/reports/junit.xml`,
            bytes: 'boom\n',
          },
        ],
      },
    ]),
  })
}, 30_000)
