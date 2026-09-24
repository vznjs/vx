// The watch loop's watched SET, end to end: a package that appears or
// leaves under a running watch, the root watcher's filter, and a
// `--filter` scope's upstream closure. Fixture and markers:
// `helpers/watch-loop.ts`; the edit-cycle claims are `watch-loop.test.ts`.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { addProject } from './helpers/workspace.js'
import {
  SETTLE_MS,
  executions,
  initialOnly,
  startWatch,
  until,
  useWatchFixture,
} from './helpers/watch-loop.js'

describe('vx watch loop (e2e): the watched set', () => {
  const f = useWatchFixture()

  it('a package added under a running watch is a cycle that runs it, and its edits are cycles from then on', async () => {
    // Its directory appears as one entry under `packages/` — the glob's
    // directory, watched non-recursively — and the cycle that follows
    // re-reads the workspace and arms the new dir. Before 2026-09-10 the
    // watched set was fixed when the loop armed: nothing ran until some
    // other edit, and every edit inside the new package was silence.
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await initialOnly(w, f.log)

    const bDir = await addProject(
      f.root,
      'b',
      `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${f.log}' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
            },
          },
        }
      `,
    )
    await mkdir(path.join(bDir, 'src'), { recursive: true })
    await writeFile(path.join(bDir, 'src', 'b.txt'), 'b1\n')
    await until(
      async () => (await executions(f.log)) === 2,
      'the cycle after the package was added',
    )
    await until(() => w.out().includes('vx watch: watching 2 project(s)'), 'the re-armed set')
    await Bun.sleep(SETTLE_MS)
    expect(await readFile(path.join(bDir, 'dist', 'out.txt'), 'utf8')).toBe('b1\n')

    await writeFile(path.join(bDir, 'src', 'b.txt'), 'b2\n')
    await until(
      async () => (await executions(f.log)) === 3,
      'the cycle after an edit in the new package',
    )
    await Bun.sleep(SETTLE_MS)
    expect(await readFile(path.join(bDir, 'dist', 'out.txt'), 'utf8')).toBe('b2\n')

    // Gone again: the member's departure is a cycle too, and its arm is dropped.
    await rm(bDir, { recursive: true, force: true })
    await until(() => w.out().includes('vx watch: watching 1 project(s)'), 'the set without b')
    await Bun.sleep(SETTLE_MS)
    expect(await executions(f.log)).toBe(3)
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
            cache: { inputs: { files: ['src/**'], workspaceFiles: ['tsconfig.base.json'] }, outputs: { files: ['dist/**'] } },
          },
        },
      }\n`,
    )
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(
      () => w.out().includes('vx watch: watching the workspace root'),
      'the root-watcher marker',
    )
    expect(await executions(f.log)).toBe(1)

    await writeFile(path.join(f.root, 'build.log'), 'vx watch: initial run...\n')
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
    // was never an event: the loop printed "watching 1 project(s)" and
    // sat there. Differential: with the closure removed, the wait below
    // times out.
    const lib = await addProject(f.root, 'lib', {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo lib >> ${f.log}' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
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
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
          },
        },
      }\n`,
    )
    const pkg = JSON.parse(await readFile(path.join(f.dir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >
    pkg['dependencies'] = { lib: '0.0.0' }
    await writeFile(path.join(f.dir, 'package.json'), JSON.stringify(pkg, null, 2))

    f.watch = startWatch(f.root, ['--filter', 'app'])
    const w = f.watch
    await until(() => w.out().includes('vx watch: watching 2 project(s)'), 'both projects watched')
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
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
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
    await until(() => w.out().includes('vx watch: watching 2 project(s)'), 'the two libs watched')
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
})
