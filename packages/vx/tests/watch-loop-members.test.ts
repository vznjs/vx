// The watch loop's watched SET, end to end: a project the lock gains or
// loses under a running watch, the root watcher's filter, and a
// `--filter` scope's upstream closure. Fixture and markers:
// `helpers/watch-loop.ts`; the edit-cycle claims are `watch-loop.test.ts`.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { PLUGIN_IMPORT, packagesSource, pluginSource, writeEdges } from './helpers/plugin.js'
import { addProject } from './helpers/workspace.js'
import {
  BIN,
  SETTLE_MS,
  executions,
  initialOnly,
  ARMS,
  arms,
  startWatch,
  until,
  useWatchFixture,
} from './helpers/watch-loop.js'

/**
 * Edges from a root `edges.json` (`{ "<dir>": ["<dep dir>"] }`) the plugin
 * claims, as a lockfile plugin reads what the manager installed.
 */
const FILE_EDGES = pluginSource(
  'vx-test-file-edges',
  `{
  fingerprint: { files: ['edges.json'], affected: () => undefined },
  async discover(ctx) {
    const file = Bun.file(ctx.workspaceRoot + '/edges.json')
    const edges = (await file.exists()) ? await file.json() : {}
    return Object.entries(edges).map(([dir, deps]) => ({ dir, deps }))
  },
  async key(task, ctx) {
    const file = Bun.file(ctx.workspaceRoot + '/edges.json')
    return { edges: (await file.exists()) ? await file.text() : '' }
  },
}`,
)

describe('vx watch loop (e2e): the watched set', () => {
  const f = useWatchFixture()
  // A cycle's configs are the lock's: a config a running watch should see
  // takes a re-lock, which is itself a cycle.
  const relock = (): void => {
    const r = Bun.spawnSync([process.execPath, BIN, 'lock'], {
      cwd: f.root,
      stderr: 'pipe',
      env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
    })
    if (r.exitCode !== 0) throw new Error(`vx lock: ${r.stderr.toString()}`)
  }

  it('a package added under a running watch is a cycle that runs it, and its edits are cycles from then on', async () => {
    // The lock that records it is the event: the cycle that follows re-reads
    // the workspace and arms the new dir. Before 2026-09-10 the watched set
    // was fixed when the loop armed: nothing ran until some other edit, and
    // every edit inside the new project was silence.
    f.watch = startWatch(f.root, ['--all'], ARMS)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)

    const bDir = await addProject(
      f.root,
      'b',
      `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${f.log}' },
              inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
            },
          },
        }
      `,
    )
    await mkdir(path.join(bDir, 'src'), { recursive: true })
    await writeFile(path.join(bDir, 'src', 'b.txt'), 'b1\n')
    relock()
    await until(
      async () => (await executions(f.log)) === 2,
      'the cycle after the package was added',
    )
    await until(() => arms(w, 2) === 1, 'the re-armed set')
    await Bun.sleep(SETTLE_MS)
    expect(await readFile(path.join(bDir, 'dist', 'out.txt'), 'utf8')).toBe('b1\n')

    await writeFile(path.join(bDir, 'src', 'b.txt'), 'b2\n')
    await until(
      async () => (await executions(f.log)) === 3,
      'the cycle after an edit in the new package',
    )
    await Bun.sleep(SETTLE_MS)
    expect(await readFile(path.join(bDir, 'dist', 'out.txt'), 'utf8')).toBe('b2\n')

    // Gone again and re-locked: the lock's departure re-reads the set, and its arm is dropped.
    await rm(bDir, { recursive: true, force: true })
    relock()
    await until(
      () => w.err().split('armed 2 projects').at(-1)!.includes('armed 1 project\n'),
      'the set without b',
    )
    await Bun.sleep(SETTLE_MS)
    expect(await executions(f.log)).toBe(3)
    // The set changed twice; stdout says "watching" once, before any cycle.
    // A re-arm repeated it between task rows.
    const out = w.out()
    expect(out.match(/^watching /gm)).toHaveLength(1)
    expect(out.indexOf('watching ')).toBeLessThan(out.indexOf('\nchanged '))
  }, 40_000)

  it('under the root watcher, a root file no key can see is not a cycle; a declared one is', async () => {
    // A `workspaceFiles` input puts the loop on ONE recursive root watcher.
    // Before the filter, that watcher triggered on every write in the tree:
    // `vx watch … > build.log` inside the repo never settled (each cycle
    // grew the log, the log was an event, the event was a cycle), and a
    // coverage run at the root cost a cycle per file. Differential: with the
    // filter removed from the arm, the `build.log` write below is a cycle.
    await writeFile(path.join(f.root, 'tsconfig.base.json'), '{"a":1}\n')
    await writeFile(
      path.join(f.dir, 'vx.config.mjs'),
      `export default {
        tasks: {
          build: {
            exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${f.log}' },
            inputs: { files: ['src/**'], workspaceFiles: ['tsconfig.base.json'] }, cache: { outputs: { files: ['dist/**'] } },
          },
        },
      }\n`,
    )
    f.watch = startWatch(f.root, ['--all'], ARMS)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the root-watcher marker')
    expect(await executions(f.log)).toBe(1)

    await writeFile(path.join(f.root, 'build.log'), 'watching 1 project\n')
    await mkdir(path.join(f.root, 'coverage'), { recursive: true })
    await writeFile(path.join(f.root, 'coverage', 'lcov.info'), 'TN:\n')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(0)
    expect(await executions(f.log)).toBe(1)

    // The control: the declared root file is an edit, and the watcher was alive all along.
    await writeFile(path.join(f.root, 'tsconfig.base.json'), '{"a":2}\n')
    await until(
      async () => (await executions(f.log)) === 2,
      'the re-run after the declared root file changed',
    )
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
  }, 40_000)

  it('a --filter scope watches its upstream dependencies too: a lib edit is one cycle that rebuilds both', async () => {
    // A cycle runs what `vx run` runs — the scope plus its dependencies —
    // so the watched dirs must be the same set. Before `watchedProjects`
    // the per-project arm watched the filter's answer only, and this edit
    // was never an event: the loop printed "watching 1 project " and
    // sat there. Differential: with the closure removed, the wait below
    // times out.
    await writeFile(path.join(f.root, 'edges.json'), JSON.stringify({ 'packages/app': [] }))
    const lib = await addProject(f.root, 'lib', {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo lib >> ${f.log}' },
              inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
            },
          },
        }
      `,
      files: { 'src/l.txt': 'l1\n' },
    })
    await writeFile(
      path.join(f.dir, 'vx.config.mjs'),
      `export default {
        tasks: {
          build: {
            dependsOn: ['^build'],
            exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${f.log}' },
            inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
          },
        },
      }\n`,
    )
    await writeEdges(f.root, { app: ['lib'] })

    f.watch = startWatch(f.root, ['--filter', 'app'])
    const w = f.watch
    await until(() => w.out().includes('watching 2 projects'), 'both projects watched')
    const lines = async () => (await readFile(f.log, 'utf8')).split('\n').filter((l) => l !== '')
    expect(await lines()).toEqual(['lib', 'run'])

    await writeFile(path.join(lib, 'src', 'l.txt'), 'l2\n')
    await until(async () => (await lines()).length === 4, 'the cycle after the upstream edit')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    expect(await lines()).toEqual(['lib', 'run', 'lib', 'run'])
  }, 40_000)

  // nx#36446: `nx watch --projects='lib-*'` watched nothing a glob named.
  it('a --filter glob runs and watches exactly the projects it names', async () => {
    const lib = (name: string) =>
      addProject(f.root, name, {
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo ${name} >> ${f.log}' },
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
        files: { 'src/x.txt': `${name}1\n` },
      })
    const libA = await lib('lib-a')
    await lib('lib-b')
    f.watch = startWatch(f.root, ['--filter', 'lib-*'])
    const w = f.watch
    await until(() => w.out().includes('watching 2 projects'), 'the two libs watched')
    const lines = async () =>
      (await readFile(f.log, 'utf8'))
        .split('\n')
        .filter((l) => l !== '')
        .sort()
    expect(await lines()).toEqual(['lib-a', 'lib-b'])

    // `app` is outside the glob: its edit is no cycle.
    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a2\n')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(0)

    await writeFile(path.join(libA, 'src', 'x.txt'), 'lib-a2\n')
    await until(async () => (await lines()).length === 3, 'the cycle after a lib edit')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
    expect(await lines()).toEqual(['lib-a', 'lib-a', 'lib-b'])
  }, 40_000)

  // Item 891: the watched set was re-read only when a member directory came
  // or went, so every event below that changes it waited for a restart.
  const buildLogging = (tag: string, extra = ''): string => `
    export default {
      tasks: {
        build: {
          ${extra}
          exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo ${tag} >> ${f.log}' },
          inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
        },
      },
    }
  `

  it('a dependency added under --filter joins the watched closure', async () => {
    // The closure was computed at start: `app` alone. An edit to the file
    // the edge plugin claims that makes `lib` its dependency runs `lib` in
    // the cycle it triggers, and the re-read arms it. Differential: without
    // the re-read on a claimed file's edit, the `lib` edit below is silence.
    await Bun.write(
      path.join(f.root, '.vx/workspace.mjs'),
      `${PLUGIN_IMPORT}export default { plugins: [${packagesSource()}, ${FILE_EDGES}] }\n`,
    )
    await writeFile(path.join(f.root, 'edges.json'), JSON.stringify({ 'packages/app': [] }))
    const lib = await addProject(f.root, 'lib', {
      config: buildLogging('lib'),
      files: { 'src/l.txt': 'l1\n' },
    })
    await writeFile(
      path.join(f.dir, 'vx.config.mjs'),
      buildLogging('run', "dependsOn: ['^build'],"),
    )
    f.watch = startWatch(f.root, ['--filter', 'app'], ARMS)
    const w = f.watch
    await until(() => w.out().includes('watching 1 project '), 'app alone watched')
    const lines = async () => (await readFile(f.log, 'utf8')).split('\n').filter((l) => l !== '')
    expect(await lines()).toEqual(['run'])

    await writeFile(
      path.join(f.root, 'edges.json'),
      JSON.stringify({ 'packages/app': ['packages/lib'] }),
    )
    await until(() => arms(w, 2) === 1, 'lib joins the set')
    await Bun.sleep(SETTLE_MS)
    const afterDep = await lines()

    await writeFile(path.join(lib, 'src', 'l.txt'), 'l2\n')
    await until(
      async () => (await lines()).length === afterDep.length + 2,
      'the cycle after the upstream edit',
    )
    expect((await lines()).slice(afterDep.length)).toEqual(['lib', 'run'])
  }, 40_000)

  it('a config that starts declaring workspaceFiles swaps to the root watcher', async () => {
    // The watcher's shape was fixed at start: per project, with the root's
    // own fingerprint files only. Differential: without the swap, the
    // declared root file's edit is silence.
    await writeFile(path.join(f.root, 'tsconfig.base.json'), '{"a":1}\n')
    f.watch = startWatch(f.root, ['--all'], ARMS)
    const w = f.watch
    await until(() => w.out().includes('watching 1 project '), 'the per-project arm')
    await initialOnly(w, f.log)

    await writeFile(
      path.join(f.dir, 'vx.config.mjs'),
      `export default {
        tasks: {
          build: {
            exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${f.log}' },
            inputs: { files: ['src/**'], workspaceFiles: ['tsconfig.base.json'] }, cache: { outputs: { files: ['dist/**'] } },
          },
        },
      }\n`,
    )
    relock()
    await until(() => arms(w) >= 2, 'the swap to the root watcher')
    // The swap can land before the config edit's own cycle on a slow box.
    await until(async () => (await executions(f.log)) >= 2, "the config edit's cycle")
    await Bun.sleep(SETTLE_MS)
    expect(await executions(f.log)).toBe(2)

    await writeFile(path.join(f.root, 'tsconfig.base.json'), '{"a":2}\n')
    await until(async () => (await executions(f.log)) === 3, 'the cycle after the root file edit')
  }, 40_000)

  it('a module the config imports from inside its project reshapes the set like the config', async () => {
    // Only an import from outside every project re-read the set: the same
    // workspaceFiles line added in `./inputs.mjs` ran one cycle, and the
    // root file it named was silence until a restart.
    await writeFile(path.join(f.root, 'tsconfig.base.json'), '{"a":1}\n')
    const inputs = (extra: string): string =>
      `export const inputs = { files: ['src/**']${extra} }\n`
    await writeFile(path.join(f.dir, 'inputs.mjs'), inputs(''))
    await writeFile(
      path.join(f.dir, 'vx.config.mjs'),
      `import { inputs } from './inputs.mjs'
      export default {
        tasks: {
          build: {
            exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${f.log}' },
            inputs,
            cache: { outputs: { files: ['dist/**'] } },
          },
        },
      }\n`,
    )
    f.watch = startWatch(f.root, ['--all'], ARMS)
    const w = f.watch
    await until(() => w.out().includes('watching 1 project '), 'the per-project arm')
    await initialOnly(w, f.log)

    await writeFile(
      path.join(f.dir, 'inputs.mjs'),
      inputs(", workspaceFiles: ['tsconfig.base.json']"),
    )
    relock()
    await until(() => arms(w) >= 2, 'the swap to the root watcher')
    await until(async () => (await executions(f.log)) >= 2, "the config edit's cycle")
    await Bun.sleep(SETTLE_MS)
    expect(await executions(f.log)).toBe(2)

    await writeFile(path.join(f.root, 'tsconfig.base.json'), '{"a":2}\n')
    await until(async () => (await executions(f.log)) === 3, 'the cycle after the root file edit')
  }, 40_000)

  it('a project added with a broken config waits for a lock: once fixed and locked its edits are cycles', async () => {
    // A config the lock does not hold is no project yet; `vx lock` refuses
    // it and leaves the lock as it was. The lock the fix lets it write is
    // the cycle that arms the project.
    f.watch = startWatch(f.root, ['--all'], ARMS)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)

    const bDir = await addProject(f.root, 'b', 'export default {\n')
    expect(() => relock()).toThrow('vx lock: ')

    await mkdir(path.join(bDir, 'src'), { recursive: true })
    await writeFile(path.join(bDir, 'src', 'b.txt'), 'b1\n')
    await writeFile(
      path.join(bDir, 'vx.config.mjs'),
      `export default {
        tasks: {
          build: {
            exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${f.log}' },
            inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
          },
        },
      }\n`,
    )
    relock()
    await until(async () => (await executions(f.log)) === 2, 'the cycle after the fix')
    await until(() => arms(w, 2) === 1, 'b joins the set')
    await Bun.sleep(SETTLE_MS)
    expect(await readFile(path.join(bDir, 'dist', 'out.txt'), 'utf8')).toBe('b1\n')

    await writeFile(path.join(bDir, 'src', 'b.txt'), 'b2\n')
    await until(async () => (await executions(f.log)) === 3, 'the cycle after an edit in b')
    await Bun.sleep(SETTLE_MS)
    expect(await readFile(path.join(bDir, 'dist', 'out.txt'), 'utf8')).toBe('b2\n')
  }, 40_000)
})
