// What a plugin learns about its run in `setup`: the run id its history rows
// carry, the commit, the CI provider's facts, and the files a task's declared
// outputs match on disk, a failed task's included (core saves none of those).

import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { gitInitCommit } from './helpers/workspace.js'
import { run } from './helpers/orchestrator.js'
import { pluginSource } from './helpers/plugin.js'

let root = ''
afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

it('setup carries the run id, commit, CI facts and a task outputs reader', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'vx-run-facts-'))
  await Bun.write(
    path.join(root, 'app/vx.config.mjs'),
    `export default { tasks: {
      build: {
        exec: { command: 'mkdir -p dist && echo partial > dist/a.js && echo half > dist/b.js && exit 3' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
      },
    } }`,
  )
  await Bun.write(path.join(root, 'app/src/i.ts'), 'x')
  const box = globalThis as unknown as { __vxFacts: Record<string, unknown> }
  box.__vxFacts = {}
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([
      pluginSource(
        'org/facts',
        `{ setup(ctx) {
             const f = globalThis.__vxFacts
             f.runId = ctx.runId
             f.commit = ctx.commit
             f.provider = ctx.ciRun.provider
             f.job = ctx.ciRun.job
             ctx.on('onTaskComplete', (node, outcome) => {
               f.done = ctx.outputsOf(node).then((files) => { f.outputs = [outcome.status, files] })
             })
           } }`,
      ),
    ]),
  )
  gitInitCommit(root)
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim()
  const env = {
    GITHUB_ACTIONS: process.env['GITHUB_ACTIONS'],
    GITHUB_JOB: process.env['GITHUB_JOB'],
  }
  process.env['GITHUB_ACTIONS'] = 'true'
  process.env['GITHUB_JOB'] = 'test'
  let summary
  try {
    summary = await run({ cwd: root, tasks: ['build'], handleSignals: false })
  } finally {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  expect(summary.ok).toBe(false)
  await box.__vxFacts['done']
  const db = new Database(path.join(root, '.vx/cache/cache.db'), { readonly: true })
  const row = db.query('SELECT run_id FROM invocations').get() as { run_id: string }
  db.close()
  expect(box.__vxFacts).toMatchObject({
    runId: row.run_id,
    commit: head,
    provider: 'github',
    job: 'test',
    outputs: ['failed', ['app/dist/a.js', 'app/dist/b.js']],
  })
})
