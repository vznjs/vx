// vx cleans a task's outputs before it runs, and Turbo does not. On vueuse,
// ten builds read `packages/metadata/index.json` (committed, the output of
// `metadata#update`) with no edge to it, so each vx cold run failed while
// `update` ran, naming only the missing file (N's dogfood). The failure now
// names the task whose clean removed the tracked file (A-48).
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  addProject,
  type Fixture,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
} from './helpers/orchestrator-fixture.js'
import { gitIn } from './helpers/workspace.js'
import { run } from '../src/orchestrator/index.js'

const METADATA = `export default { tasks: { build: {
  exec: { command: 'sleep 1 && echo v2 > index.json' },
  cache: { inputs: { files: ['src.txt'] }, outputs: { files: ['index.json'] } },
} } }`
const CORE = `export default { tasks: { build: {
  exec: { command: 'sleep 0.3 && cat ../metadata/index.json > out.txt' },
  cache: { inputs: { files: ['src.txt'] }, outputs: { files: ['out.txt'] } },
} } }`
const LINE =
  '[vx] packages/metadata/index.json is tracked by git, and metadata#build removed it as an output before its run; it is still missing. A task that reads it needs dependsOn on metadata#build.'

let fx: Fixture
beforeEach(async () => {
  fx = await makeWorkspace('vx-clean-read-')
  await addProject(fx.root, 'metadata', {
    files: { 'src.txt': 's', 'index.json': 'v1' },
    config: METADATA,
  })
  await addProject(fx.root, 'core', { files: { 'src.txt': 's' }, config: CORE })
})
afterEach(async () => {
  await rm(fx.root, { recursive: true, force: true })
})

const failure = async () => {
  const r = await run({ cwd: fx.root, tasks: ['build'], log: silentLogger(fx) })
  const core = r.outcomes.find((o) => o.node.id === 'core#build')!
  return {
    status: core.status,
    named: fx.err.filter((l) => l.includes('[vx] packages/metadata')).map((l) => l.trim()),
  }
}

describe('a task that fails while another task has cleaned a committed file it reads', () => {
  it(
    'names the file and the task whose clean removed it',
    async () => {
      const git = gitIn(fx.root)
      git('add', '-A')
      git('commit', '-q', '-m', 'init')
      expect(await failure()).toEqual({ status: 'failed', named: [LINE] })
    },
    TIMEOUT,
  )

  // Each guard alone: a task's own clean, a file that came back, a success.
  it.each([
    ["the failing task's own clean", 'exit 1', 'true'],
    ['a file its producer has written back', 'echo v2 > index.json', 'sleep 1.5 && exit 1'],
    ['a task that succeeds while the file is gone', 'sleep 1 && echo v2 > index.json', 'true'],
  ])(
    'says nothing of %s',
    async (_label, metadataCmd, coreCmd) => {
      const cfg = (cmd: string, out: string) => `export default { tasks: { build: {
        exec: { command: '${cmd}' },
        cache: { inputs: { files: ['src.txt'] }, outputs: { files: ['${out}'] } },
      } } }`
      await Bun.write(`${fx.root}/packages/metadata/vx.config.mjs`, cfg(metadataCmd, 'index.json'))
      await Bun.write(`${fx.root}/packages/core/vx.config.mjs`, cfg(coreCmd, 'out.txt'))
      const git = gitIn(fx.root)
      git('add', '-A')
      git('commit', '-q', '-m', 'init')
      await run({ cwd: fx.root, tasks: ['build'], log: silentLogger(fx) })
      expect(fx.err.filter((l) => l.includes('is tracked by git'))).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'says nothing of a file git does not track',
    async () => {
      expect(await failure()).toEqual({ status: 'failed', named: [] })
    },
    TIMEOUT,
  )
})
