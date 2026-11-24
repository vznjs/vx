// A task with no `inputs` has a key of this run alone, so nothing that
// folds it is saved: no later run derives that key. The mark travelled on
// a task's outcome but not on a server's, so with a server that declares
// inputs between the two (db, no inputs -> api -> e2e) every run saved
// e2e under a key no run reads again: one dead entry a run.

import { rm } from 'node:fs/promises'
import { afterEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { type Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'

let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

it('a task behind a keyed server that folds a keyless one is not saved, and is told why', async () => {
  root = await makeWorkspace({ prefix: 'vx-keyless-server-' })
  await addProject(
    root,
    'app',
    `export default { tasks: {
      db: { exec: { command: 'echo ready; exec sleep 30', persistent: { readyWhen: 'ready' } } },
      api: { dependsOn: ['db'], inputs: { files: ['vx.config.mjs'] },
        exec: { command: 'echo up; exec sleep 30', persistent: { readyWhen: 'up' } } },
      e2e: { dependsOn: ['api'], exec: { command: 'echo pass > e2e.out' },
        inputs: { files: ['vx.config.mjs'] }, outputs: { files: ['e2e.out'] }, cache: true },
    } }`,
  )
  const warnings: string[] = []
  const log: Logger = {
    status(line) {
      warnings.push(line)
    },
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
  }
  const once = async () => {
    const r = await run({ cwd: root!, tasks: ['app#e2e'], log, handleSignals: false })
    const e2e = r.outcomes.find((o) => o.node.id === 'app#e2e')!
    return [e2e.status, e2e.cache?.saved ?? false, e2e.cache?.keylessBy]
  }
  expect(await once()).toEqual(['success', false, 'app#db'])
  expect(await once()).toEqual(['success', false, 'app#db'])
  expect(warnings.filter((w) => w.includes('not saved —')).at(-1)).toBe(
    '[vx] app#e2e: not saved — its key folds app#db, which declares no `inputs`, ' +
      "so no later run derives it, nor any other task's that folds it; declare inputs on app#db",
  )
}, 30_000)

// A run-level fact: gen#build declares no inputs, and each of its four
// dependants said so, four lines for one fix.
it('a keyless upstream is named once a run, however many dependants it leaves unsaved', async () => {
  root = await makeWorkspace({ prefix: 'vx-keyless-once-' })
  await addProject(
    root,
    'gen',
    `export default { tasks: { build: { exec: { command: 'true' } } } }`,
  )
  for (const p of ['a', 'b', 'c'])
    await addProject(
      root,
      p,
      `export default { tasks: { build: { dependsOn: ['gen#build'], exec: { command: 'true' },
        inputs: { files: ['vx.config.mjs'] }, outputs: { files: [] }, cache: true } } }`,
    )
  const warnings: string[] = []
  const log: Logger = {
    status: (line) => void warnings.push(line),
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
  }
  const r = await run({
    cwd: root,
    tasks: ['build'],
    all: true,
    log,
    handleSignals: false,
  } as never)
  expect(
    r.outcomes.filter((o) => o.node.id !== 'gen#build' && o.cache?.keylessBy === 'gen#build')
      .length,
  ).toBe(3)
  const said = warnings.filter((w) => w.includes('declares no `inputs`'))
  expect(said.length).toBe(1)
  expect(said[0]).toMatch(
    /^\[vx\] [abc]#build: not saved — its key folds gen#build, which declares no `inputs`, so no later run derives it, nor any other task's that folds it; declare inputs on gen#build$/,
  )
}, 30_000)
