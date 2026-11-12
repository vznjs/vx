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
import { addProject, gitInitCommit, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
})

const INCREMENTAL =
  'mkdir -p dist; e=0; for f in src/*.txt; do n=$(basename $f); h=$(cksum < $f); ' +
  'grep -qxF "$n $h" state 2>/dev/null || { cp $f dist/$n; e=1; }; done; ' +
  '[ $e = 0 ] || for f in src/*.txt; do echo "$(basename $f) $(cksum < $f)"; done > state'

async function workspace(
  outputs: string,
  gitignore = 'dist/\nstate\n',
  state = 'state',
): Promise<{ root: string; app: string }> {
  const root = await makeWorkspace({ prefix: 'vx-undeclared-state-' })
  made.push(root)
  const app = await addProject(root, 'app', {
    files: { 'src/a.txt': 'a', 'src/b.txt': 'b', '.gitignore': gitignore },
    config: `export default { tasks: { build: {
      exec: { command: ${JSON.stringify(INCREMENTAL.replaceAll('state', state))} },
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
    expect(first.outcomes.map((o) => [o.status, o.cache?.saved])).toEqual([['success', true]])
    await writeFile(path.join(app, 'src/a.txt'), 'a2')
    const second = await run(opts)
    // The clean took b.txt and the state kept the tool from emitting it.
    expect(await readdir(path.join(app, 'dist'))).toEqual(['a.txt'])
    expect(second.outcomes.map((o) => [o.status, o.cache?.saved])).toEqual([['success', undefined]])
    expect(fx.log.join('\n')).toContain(
      "app#build: state changed while the task ran, but the task declares it neither input nor output — the result stands, but is not saved: a tool that reads such a file back (an incremental build's state) builds from it, not from the inputs; declare it in outputs.files ('state'), so a miss starts without it and a hit restores it",
    )
  },
  TIMEOUT,
)

// A `.gitignore` naming `dist` and not `*.tsbuildinfo` (ev3, 2026-11-12):
// the state is untracked, not ignored, and the partial `dist/` was saved.
it(
  'a miss that rewrites an undeclared untracked file is not saved',
  async () => {
    const { root, app } = await workspace("['dist/**']", 'dist/\n')
    const fx = { root, log: [] as string[], err: [] as string[] }
    const opts = { cwd: root, tasks: ['build'], log: silentLogger(fx) }
    expect((await run(opts)).outcomes.map((o) => [o.status, o.cache?.saved])).toEqual([
      ['success', true],
    ])
    await writeFile(path.join(app, 'src/a.txt'), 'a2')
    const second = await run(opts)
    expect(await readdir(path.join(app, 'dist'))).toEqual(['a.txt'])
    expect(second.outcomes.map((o) => [o.status, o.cache?.saved])).toEqual([['success', undefined]])
    expect(fx.log.join('\n')).toContain(
      'app#build: state changed while the task ran, but the task declares it neither input nor output',
    )
  },
  TIMEOUT,
)

// Unignored, `git add -A` commits the state: tracked, and stamped as long
// as it is a `.tsbuildinfo`.
it(
  'a miss that rewrites a committed .tsbuildinfo is not saved',
  async () => {
    const { root, app } = await workspace("['dist/**']", 'dist/\n', 'x.tsbuildinfo')
    const fx = { root, log: [] as string[], err: [] as string[] }
    const opts = { cwd: root, tasks: ['build'], log: silentLogger(fx) }
    expect((await run(opts)).outcomes.map((o) => [o.status, o.cache?.saved])).toEqual([
      ['success', true],
    ])
    gitInitCommit(root)
    await writeFile(path.join(app, 'src/a.txt'), 'a2')
    const second = await run(opts)
    expect(await readdir(path.join(app, 'dist'))).toEqual(['a.txt'])
    expect(second.outcomes.map((o) => [o.status, o.cache?.saved])).toEqual([['success', undefined]])
    expect(fx.log.join('\n')).toContain(
      'app#build: x.tsbuildinfo changed while the task ran, but the task declares it neither input nor output',
    )
  },
  TIMEOUT,
)

// Next's type check keeps `.next/cache/.tsbuildinfo`, and the outputs
// Turbo's docs teach take the cache back (ev5, 2026-11-12): the state is
// declared kept, and every save after the first was withheld.
it(
  'state an output glob takes back with `!` does not withhold the save',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-undeclared-state-' })
    made.push(root)
    const app = await addProject(root, 'app', {
      files: { 'src/a.txt': 'a', '.gitignore': '.next/\n' },
      config: `export default { tasks: { build: {
        exec: { command: 'mkdir -p .next/cache && cp src/a.txt .next/a.txt && date +%s%N > .next/cache/.tsbuildinfo' },
        inputs: { files: ['src/**'] }, outputs: { files: ['.next/**', '!.next/cache/**'] }, cache: true,
      } } }`,
    })
    const fx = { root, log: [] as string[], err: [] as string[] }
    const opts = { cwd: root, tasks: ['build'], log: silentLogger(fx) }
    expect((await run(opts)).outcomes.map((o) => [o.status, o.saved])).toEqual([['success', true]])
    await writeFile(path.join(app, 'src/a.txt'), 'a2')
    expect((await run(opts)).outcomes.map((o) => [o.status, o.saved])).toEqual([['success', true]])
    expect(fx.log.join('\n')).not.toContain('neither input nor output')
  },
  TIMEOUT,
)

// Vite's template runs `tsc -b` with `noEmit`, its buildinfo in
// `node_modules/.tmp` (ev1, 2026-11-12). Not incremental, tsc writes only
// its roots and version there and builds the whole project: no state.
// An incremental one whose build emits nothing (create-vue's `vue-tsc
// --build`, composite with noEmit) keeps every root pending emit.
it.each([
  ['non-incremental', '"root":["../../src/a.txt"]'],
  [
    'noEmit composite',
    '"fileNames":["../../src/a.txt"],"root":[1],"affectedFilesPendingEmit":[[1,17]]',
  ],
])(
  'a %s tsbuildinfo rewritten each build does not withhold the save',
  async (_kind: string, fields: string) => {
    const root = await makeWorkspace({ prefix: 'vx-undeclared-state-' })
    made.push(root)
    const info = `{${fields},"version":"5.9.3","at":"'$(date +%s%N)'"}`
    const app = await addProject(root, 'app', {
      files: { 'src/a.txt': 'a', '.gitignore': 'dist/\nnode_modules/\n' },
      config: `export default { tasks: { build: {
        exec: { command: ${JSON.stringify(`mkdir -p node_modules/.tmp dist && echo '${info}' > node_modules/.tmp/tsconfig.app.tsbuildinfo && cp src/a.txt dist/`)} },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      } } }`,
    })
    const fx = { root, log: [] as string[], err: [] as string[] }
    const opts = { cwd: root, tasks: ['build'], log: silentLogger(fx) }
    expect((await run(opts)).outcomes.map((o) => [o.status, o.saved])).toEqual([['success', true]])
    await writeFile(path.join(app, 'src/a.txt'), 'a2')
    expect((await run(opts)).outcomes.map((o) => [o.status, o.saved])).toEqual([['success', true]])
    expect(fx.log.join('\n')).not.toContain('neither input nor output')
  },
  TIMEOUT,
)

// The same shape emitting: a root not pending emit is one it claims built.
it(
  'an incremental tsbuildinfo that records an emit still withholds the save',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-undeclared-state-' })
    made.push(root)
    const info = `{"fileNames":["../../src/a.txt"],"root":[1],"version":"5.9.3","at":"'$(date +%s%N)'"}`
    const app = await addProject(root, 'app', {
      files: { 'src/a.txt': 'a', '.gitignore': 'dist/\nnode_modules/\n' },
      config: `export default { tasks: { build: {
        exec: { command: ${JSON.stringify(`mkdir -p node_modules/.tmp dist && echo '${info}' > node_modules/.tmp/tsconfig.app.tsbuildinfo && cp src/a.txt dist/`)} },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      } } }`,
    })
    const fx = { root, log: [] as string[], err: [] as string[] }
    const opts = { cwd: root, tasks: ['build'], log: silentLogger(fx) }
    expect((await run(opts)).outcomes.map((o) => [o.status, o.saved])).toEqual([['success', true]])
    await writeFile(path.join(app, 'src/a.txt'), 'a2')
    expect((await run(opts)).outcomes.map((o) => [o.status, o.saved])).toEqual([
      ['success', undefined],
    ])
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
    expect(first.outcomes.map((o) => [o.status, o.cache?.saved])).toEqual([['success', undefined]])
    expect(fx.log.join('\n')).toContain(
      "app#build: outputs matched no files (dist/**) while state, which the task declares neither input nor output, survived the clean — the result stands, but is not saved: a tool that reads such a file back (an incremental build's state) may take the cleaned outputs as built; declare it in outputs.files ('state'), so a miss starts without it and a hit restores it",
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
    expect((await run(opts)).outcomes.map((o) => [o.status, o.cache?.saved])).toEqual([
      ['success', true],
    ])
    await writeFile(path.join(app, 'src/a.txt'), 'a2')
    const second = await run(opts)
    expect(second.outcomes.map((o) => [o.status, o.cache?.saved])).toEqual([['success', true]])
    expect((await readdir(path.join(app, 'dist'))).sort()).toEqual(['a.txt', 'b.txt'])
    expect(fx.log.join('\n')).not.toContain('neither input nor output')
  },
  TIMEOUT,
)

// The rule guards a partial OUTPUT: a task that declares none saves none,
// so its tool's own state is no reason to withhold its entry
// (`eslint --cache` rewrites `.eslintcache` on every run; `tsc --noEmit
// --incremental` rewrites its `.tsbuildinfo` on every edit).
async function stateOnly(command: string): Promise<{ root: string; app: string }> {
  const root = await makeWorkspace({ prefix: 'vx-undeclared-state-' })
  made.push(root)
  const app = await addProject(root, 'app', {
    files: { 'src/a.txt': 'a', '.gitignore': '.eslintcache\n' },
    config: `export default { tasks: { lint: {
      exec: { command: ${JSON.stringify(command)} },
      inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true,
    } } }`,
  })
  return { root, app }
}

it(
  'a task that declares no outputs saves although it rewrites an undeclared ignored file',
  async () => {
    const { root, app } = await stateOnly('date +%s%N > .eslintcache')
    const fx = { root, log: [] as string[], err: [] as string[] }
    const opts = { cwd: root, tasks: ['lint'], log: silentLogger(fx) }
    expect((await run(opts)).outcomes.map((o) => [o.status, o.cache?.saved])).toEqual([
      ['success', true],
    ])
    await writeFile(path.join(app, 'src/a.txt'), 'a2')
    expect((await run(opts)).outcomes.map((o) => [o.status, o.cache?.saved])).toEqual([
      ['success', true],
    ])
    expect((await run(opts)).outcomes.map((o) => o.status)).toEqual(['cache-hit'])
    expect(fx.log.join('\n')).not.toContain('neither input nor output')
  },
  TIMEOUT,
)

// Two tasks of one project run side by side, lint's write landing inside
// build's command: the file the other declares as its output is that
// task's, whenever it is written.
async function siblings(lintOutputs: string): Promise<{ root: string; app: string }> {
  const root = await makeWorkspace({ prefix: 'vx-undeclared-state-' })
  made.push(root)
  const app = await addProject(root, 'app', {
    files: { 'src/a.txt': 'a', '.gitignore': 'dist/\n.eslintcache\n' },
    config: `export default { tasks: {
      build: {
        exec: { command: 'sleep 1.5; mkdir -p dist; cp src/a.txt dist/' },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      },
      lint: {
        exec: { command: 'sleep 0.3; date +%s%N > .eslintcache' },
        inputs: { files: ['src/**'] }, outputs: { files: ${lintOutputs} }, cache: true,
      },
    } }`,
  })
  return { root, app }
}

it(
  "a sibling's write of its declared output does not withhold the task's save",
  async () => {
    const { root, app } = await siblings("['.eslintcache']")
    const fx = { root, log: [] as string[], err: [] as string[] }
    const opts = { cwd: root, tasks: ['build', 'lint'], concurrency: 2, log: silentLogger(fx) }
    await run(opts)
    await writeFile(path.join(app, 'src/a.txt'), 'a2')
    const second = await run(opts)
    expect(
      Object.fromEntries(second.outcomes.map((o) => [o.node.id, [o.status, o.cache?.saved]])),
    ).toEqual({
      'app#build': ['success', true],
      'app#lint': ['success', true],
    })
    expect(fx.log.join('\n')).not.toContain('neither input nor output')
  },
  TIMEOUT,
)

// Unsandboxed, a sibling's undeclared write cannot be told from the
// task's own: the save is withheld, and the warning names the sibling.
it(
  "a sibling's undeclared write withholds the save and the warning names the sibling",
  async () => {
    const { root, app } = await siblings('[]')
    const fx = { root, log: [] as string[], err: [] as string[] }
    const opts = { cwd: root, tasks: ['build', 'lint'], concurrency: 2, log: silentLogger(fx) }
    await run(opts)
    await writeFile(path.join(app, 'src/a.txt'), 'a2')
    const second = await run(opts)
    expect(
      Object.fromEntries(second.outcomes.map((o) => [o.node.id, [o.status, o.cache?.saved]])),
    ).toEqual({
      'app#build': ['success', undefined],
      'app#lint': ['success', true],
    })
    expect(fx.log.join('\n')).toContain(
      "app#build: .eslintcache changed while the task ran, but the task declares it neither input nor output — the result stands, but is not saved: a tool that reads such a file back (an incremental build's state) builds from it, not from the inputs; app#lint ran alongside and may have written it; declare it in outputs.files ('.eslintcache') of the task that writes it, so a miss starts without it and a hit restores it",
    )
  },
  TIMEOUT,
)

// `git status` names a directory it ignores whole, never its files: the
// state inside (`tsBuildInfoFile: 'node_modules/.tmp/…'`, a `.cache/`)
// went unseen and the partial `dist/` was saved (regr1112 repro2). Only
// `.tsbuildinfo` files are looked for there: a bundler's cache dir
// (`.next/cache`, `node_modules/.cache/webpack`) is rewritten on every
// build without cutting its outputs short.
it.each([
  ['.cache/tsconfig.tsbuildinfo', '.cache/'],
  ['node_modules/.tmp/tsconfig.tsbuildinfo', 'node_modules/'],
])(
  'state %s inside a directory git ignores whole withholds the save',
  async (state, ignore) => {
    const root = await makeWorkspace({ prefix: 'vx-undeclared-state-' })
    made.push(root)
    const command =
      `mkdir -p ${path.posix.dirname(state)}; ` + INCREMENTAL.replaceAll(' state', ` ${state}`)
    const app = await addProject(root, 'app', {
      files: { 'src/a.txt': 'a', 'src/b.txt': 'b', '.gitignore': `dist/\n${ignore}\n` },
      config: `export default { tasks: { build: {
        exec: { command: ${JSON.stringify(command)} },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      } } }`,
    })
    const fx = { root, log: [] as string[], err: [] as string[] }
    const opts = { cwd: root, tasks: ['build'], log: silentLogger(fx) }
    expect((await run(opts)).outcomes.map((o) => [o.status, o.cache?.saved])).toEqual([
      ['success', true],
    ])
    await writeFile(path.join(app, 'src/a.txt'), 'a2')
    const second = await run(opts)
    expect(await readdir(path.join(app, 'dist'))).toEqual(['a.txt'])
    expect(second.outcomes.map((o) => [o.status, o.cache?.saved])).toEqual([['success', undefined]])
    expect(fx.log.join('\n')).toContain(`app#build: ${state} changed while the task ran`)
  },
  TIMEOUT,
)
