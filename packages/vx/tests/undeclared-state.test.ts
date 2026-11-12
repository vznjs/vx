// An incremental tool keeps its state in a git-ignored file beside its
// sources (`tsc -b`'s `tsconfig.tsbuildinfo`). Declared neither input nor
// output, the file survived the clean before a miss: after one source
// changed, vx deleted `dist/`, the state still said the rest was built,
// the tool emitted only the changed file and exited 0, and the partial
// `dist/` was saved (tsref repro2, 2026-11-12). The tool here is a shell
// stand-in: it emits a source only when the state's record of it differs,
// and rewrites the state only when it emitted.

import { readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { silentLogger, TIMEOUT } from './helpers/orchestrator-fixture.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
})

const INCREMENTAL =
  'mkdir -p dist; e=0; for f in src/*.txt; do n=$(basename $f); h=$(cksum < $f); ' +
  'grep -qxF "$n $h" state 2>/dev/null || { cp $f dist/$n; e=1; }; done; ' +
  '[ $e = 0 ] || for f in src/*.txt; do echo "$(basename $f) $(cksum < $f)"; done > state'

async function workspace(outputs: string): Promise<{ root: string; app: string }> {
  const root = await makeWorkspace({ prefix: 'vx-undeclared-state-' })
  made.push(root)
  const app = await addProject(root, 'app', {
    files: { 'src/a.txt': 'a', 'src/b.txt': 'b', '.gitignore': 'dist/\nstate\n' },
    config: `export default { tasks: { build: {
      exec: { command: ${JSON.stringify(INCREMENTAL)} },
      inputs: { files: ['src/**'] }, outputs: { files: ${outputs} }, cache: true,
    } } }`,
  })
  return { root, app }
}

it(
  'a miss that rewrites an undeclared ignored file is not saved',
  async () => {
    const { root, app } = await workspace("['dist/**']")
    const fx = { root, log: [] as string[], err: [] as string[] }
    const opts = { cwd: root, tasks: ['build'], log: silentLogger(fx) }
    const first = await run(opts)
    expect(first.outcomes.map((o) => [o.status, o.saved])).toEqual([['success', true]])
    await writeFile(path.join(app, 'src/a.txt'), 'a2')
    const second = await run(opts)
    // The clean took b.txt and the state kept the tool from emitting it.
    expect(await readdir(path.join(app, 'dist'))).toEqual(['a.txt'])
    expect(second.outcomes.map((o) => [o.status, o.saved])).toEqual([['success', undefined]])
    expect(fx.log.join('\n')).toContain(
      "app#build: state changed while the task ran, but git ignores it and the task declares it neither input nor output — the result stands, but is not saved: a tool that reads such a file back (an incremental build's state) builds from it, not from the inputs; declare it in outputs.files ('state'), so a miss starts without it and a hit restores it",
    )
  },
  TIMEOUT,
)

// The state from a build outside vx (or one the rule above left unsaved)
// says everything is built: the tool writes nothing at all.
it(
  'a miss whose outputs come out empty beside an undeclared ignored file is not saved',
  async () => {
    const { root, app } = await workspace("['dist/**']")
    const built = Bun.spawnSync(['sh', '-c', INCREMENTAL], { cwd: app })
    expect(built.exitCode).toBe(0)
    const fx = { root, log: [] as string[], err: [] as string[] }
    const opts = { cwd: root, tasks: ['build'], log: silentLogger(fx) }
    const first = await run(opts)
    expect(await readdir(path.join(app, 'dist'))).toEqual([])
    expect(first.outcomes.map((o) => [o.status, o.saved])).toEqual([['success', undefined]])
    expect(fx.log.join('\n')).toContain(
      "app#build: outputs matched no files (dist/**) while state, which git ignores and the task declares neither input nor output, survived the clean — the result stands, but is not saved: a tool that reads such a file back (an incremental build's state) may take the cleaned outputs as built; declare it in outputs.files ('state'), so a miss starts without it and a hit restores it",
    )
  },
  TIMEOUT,
)

// The way out: declared, the state goes with the clean and comes back
// with a hit, so every miss builds everything.
it(
  'a declared state file is cleaned before a miss and the save holds every output',
  async () => {
    const { root, app } = await workspace("['dist/**', 'state']")
    const fx = { root, log: [] as string[], err: [] as string[] }
    const opts = { cwd: root, tasks: ['build'], log: silentLogger(fx) }
    expect((await run(opts)).outcomes.map((o) => [o.status, o.saved])).toEqual([['success', true]])
    await writeFile(path.join(app, 'src/a.txt'), 'a2')
    const second = await run(opts)
    expect(second.outcomes.map((o) => [o.status, o.saved])).toEqual([['success', true]])
    expect((await readdir(path.join(app, 'dist'))).sort()).toEqual(['a.txt', 'b.txt'])
    expect(fx.log.join('\n')).not.toContain('neither input nor output')
  },
  TIMEOUT,
)
