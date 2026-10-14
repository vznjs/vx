// vx cleans a task's outputs before it runs, and Turbo does not. On vueuse,
// ten builds read `packages/metadata/index.json` (committed, the output of
// `metadata#update`) with no edge to it, so each vx cold run failed while
// `update` ran (N's dogfood; A-48 named the file). A committed file is no
// output now (owner, 2026-10-14: "never delete committed file"): the clean
// leaves it, and a reader with no edge reads the committed copy.
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import {
  addProject,
  type Fixture,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
} from './helpers/orchestrator-fixture.js'
import { gitIn } from './helpers/workspace.js'
import { run } from './helpers/orchestrator.js'

const METADATA = `export default { tasks: { build: {
  exec: { command: 'sleep 1 && echo v2 > index.json' },
  cache: { inputs: { files: ['src.txt'] }, outputs: { files: ['index.json'] } },
} } }`
const CORE = `export default { tasks: { build: {
  exec: { command: 'sleep 0.3 && cat ../metadata/index.json > out.txt' },
  cache: { inputs: { files: ['src.txt'] }, outputs: { files: ['out.txt'] } },
} } }`

let fx: Fixture
beforeEach(async () => {
  fx = await makeWorkspace('vx-clean-read-')
  await addProject(fx.root, 'metadata', {
    files: { 'src.txt': 's', 'index.json': 'v1\n' },
    config: METADATA,
  })
  await addProject(fx.root, 'core', { files: { 'src.txt': 's' }, config: CORE })
})
afterEach(async () => {
  await rm(fx.root, { recursive: true, force: true })
})

it(
  "a committed file under another task's output stays readable while that task runs",
  async () => {
    const git = gitIn(fx.root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const r = await run({ cwd: fx.root, tasks: ['build'], log: silentLogger(fx) })
    expect({
      core: r.outcomes.find((o) => o.node.id === 'core#build')!.status,
      read: await Bun.file(`${fx.root}/packages/core/out.txt`).text(),
      written: await Bun.file(`${fx.root}/packages/metadata/index.json`).text(),
    }).toEqual({ core: 'success', read: 'v1\n', written: 'v2\n' })
  },
  TIMEOUT,
)
