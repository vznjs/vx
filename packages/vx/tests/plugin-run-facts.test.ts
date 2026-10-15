// What a finished run hands each plugin's teardown: the run id its history
// rows carry, the commit, the CI provider's facts and every task with its
// key. With no remote taking the run's writes core keeps no bytes, so no
// task names a log or outputs.

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

it('teardown gets the run report: its facts and every task', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'vx-run-facts-'))
  await Bun.write(
    path.join(root, 'app/vx.config.mjs'),
    `export default { tasks: {
      build: {
        exec: { command: 'exit 3' },
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
      pluginSource('org/facts', `{ teardown(run) { globalThis.__vxFacts.run = run } }`),
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
  const db = new Database(path.join(root, '.vx/cache/cache.db'), { readonly: true })
  const row = db.query('SELECT run_id FROM invocations').get() as { run_id: string }
  db.close()
  expect(box.__vxFacts['run']).toEqual({
    runId: row.run_id,
    commit: head,
    ciRun: expect.objectContaining({ ci: true, provider: 'github', job: 'test' }),
    ok: false,
    tasks: [
      {
        id: 'app#build',
        status: 'failed',
        durationMs: expect.any(Number),
        key: expect.any(String),
      },
    ],
  })
})
