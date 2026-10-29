// Nx parity: what an Nx user relies on, run against vx's real CLI on the
// four-package fixture in helpers/parity.ts. Each case is named for the Nx
// contract (nx.dev, 23) it stands in for and asserts vx's documented
// equivalent; a deliberate divergence says so in the name. The deep pins
// live in the suites `docs/parity.md` maps.

import { readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import {
  dry,
  makeParityWorkspace,
  PARITY_TIMEOUT as TIMEOUT,
  planned,
  summarized,
  vx,
} from './helpers/parity.js'

describe('Nx parity — running targets (`nx run`, `nx run-many`, `nx affected`)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeParityWorkspace('vx-parity-nx-run-')
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    "`nx run app:build` — one project's target, with its `dependsOn` chain (vx: `app#build`)",
    async () => {
      expect(await planned(root, ['app#build'])).toEqual(['app#build', 'lib#build', 'ui#build'])
    },
    TIMEOUT,
  )

  it(
    '`nx run-many -t build test` — several targets across every project (vx: `--all`)',
    async () => {
      expect(await planned(root, ['build', 'test', '--all'])).toEqual([
        'app#build',
        'app#test',
        'docs#build',
        'docs#test',
        'lib#build',
        'lib#test',
        'ui#build',
        'ui#test',
      ])
    },
    TIMEOUT,
  )

  it(
    '`nx run-many -t lint -p app ui` — a project list (vx: repeated `--filter`)',
    async () => {
      expect(await planned(root, ['lint', '--filter', 'app', '--filter', 'ui'])).toEqual([
        'app#lint',
        'ui#lint',
      ])
    },
    TIMEOUT,
  )

  it(
    '`--exclude docs` (vx: `--filter !docs`)',
    async () => {
      expect(await planned(root, ['lint', '--all', '--filter', '!docs'])).toEqual([
        'app#lint',
        'lib#lint',
        'ui#lint',
      ])
    },
    TIMEOUT,
  )

  it(
    '`nx affected -t lint` selects changed projects AND their dependents; `--affected` follows task edges as Nx 23.3 task selection does, so a `lint` no task edge joins stays in lib (2026-10-04); `...[ref]` is the project walk',
    async () => {
      await writeFile(path.join(root, 'packages', 'lib', 'src', 'in.txt'), 'lib-v2\n')
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'touch lib')
      expect(await planned(root, ['lint', '--affected=HEAD~1'])).toEqual(['lib#lint'])
      expect(await planned(root, ['lint', '--filter', '...[HEAD~1]'])).toEqual([
        'app#lint',
        'lib#lint',
        'ui#lint',
      ])
      expect(await planned(root, ['lint', '--filter', '[HEAD~1]'])).toEqual(['lib#lint'])
    },
    TIMEOUT,
  )

  it(
    '`nx affected` with nothing changed runs nothing and exits 0',
    async () => {
      const r = await vx(root, ['run', 'lint', '--affected=HEAD'])
      expect(r.code).toBe(0)
      expect(r.out + r.err).toContain('nothing affected')
    },
    TIMEOUT,
  )

  it(
    '`--parallel=3` (vx: `--concurrency 3`)',
    async () => {
      const r = await vx(root, ['run', 'lint', '--all', '--concurrency', '3'])
      expect(r.code).toBe(0)
      expect(r.out + r.err).toContain('3 workers')
    },
    TIMEOUT,
  )

  it(
    '`nx show projects` / `nx show project app --json` (vx: `vx show`, `vx show app --format json`)',
    async () => {
      const list = await vx(root, ['show'])
      expect(list.code).toBe(0)
      for (const name of ['app', 'docs', 'lib', 'ui']) expect(list.out).toContain(name)
      const one = await vx(root, ['show', 'app', '--format', 'json'])
      expect(one.code).toBe(0)
      const json = JSON.parse(one.out) as {
        name: string
        config: { tasks: Record<string, unknown> }
      }
      expect(json.name).toBe('app')
      expect(Object.keys(json.config.tasks).sort()).toEqual(['build', 'lint', 'test'])
    },
    TIMEOUT,
  )
})

describe('Nx parity — target defaults, `dependsOn` forms, inputs and outputs', () => {
  let root: string
  beforeAll(async () => {
    root = await makeParityWorkspace('vx-parity-nx-config-')
    const cfg = await readFile(path.join(root, 'packages', 'lib', 'vx.config.mjs'), 'utf8')
    await writeFile(
      path.join(root, 'packages', 'lib', 'vx.config.mjs'),
      cfg.replace(
        'lint: {',
        `'check.types': { exec: { command: 'echo types' } },
      'check.style': { exec: { command: 'echo style' } },
      check: { dependsOn: ['check.*'] },
      rt: {
        exec: { command: 'echo rt' },
        inputs: { files: ['src/**'], runtime: ['cat ../../runtime.txt'] }, cache: { outputs: { files: [] } },
      },
      ts: {
        exec: { command: 'echo ts' },
        inputs: { files: ['src/**'], workspaceFiles: ['tsconfig.base.json'] }, cache: { outputs: { files: [] } },
      },
      lint: {`,
      ),
    )
    const app = await readFile(path.join(root, 'packages', 'app', 'vx.config.mjs'), 'utf8')
    await writeFile(
      path.join(root, 'packages', 'app', 'vx.config.mjs'),
      app.replace(
        'lint: {',
        `e2e: { exec: { command: 'echo e2e' }, dependsOn: ['ui#build'] },
      lint: {`,
      ),
    )
    await writeFile(path.join(root, 'runtime.txt'), 'rt-1\n')
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    '`"dependsOn": ["^build"]` / `{ projects: "dependencies", target: "build" }` — build after dependencies build',
    async () => {
      const tasks = await dry(root, ['app#build'])
      expect(tasks.find((t) => t.id === 'app#build')?.deps.sort()).toEqual([
        'lib#build',
        'ui#build',
      ])
    },
    TIMEOUT,
  )

  it(
    '`{ projects: ["ui"], target: "build" }` — an edge to a named project\'s target (vx: `ui#build`)',
    async () => {
      const tasks = await dry(root, ['app#e2e'])
      expect(tasks.find((t) => t.id === 'app#e2e')?.deps).toEqual(['ui#build'])
    },
    TIMEOUT,
  )

  it(
    'wildcard `dependsOn` (Nx `build-*`; vx `check.*`) fans out to every matching task',
    async () => {
      const tasks = await dry(root, ['lib#check'])
      expect(tasks.find((t) => t.id === 'lib#check')?.deps.sort()).toEqual([
        'lib#check.style',
        'lib#check.types',
      ])
    },
    TIMEOUT,
  )

  it(
    'a target with no command is a group (Nx: a target that only aggregates) — it runs its members',
    async () => {
      const r = await summarized(root, ['lib#check'])
      expect(r.code).toBe(0)
      expect(r.tasks.get('lib#check.style')?.['status']).toBe('success')
      expect(r.tasks.get('lib#check.types')?.['status']).toBe('success')
      expect(r.tasks.has('lib#check')).toBe(false)
    },
    TIMEOUT,
  )

  it(
    '`{ "runtime": "node -v" }` — a command\'s output is a hashed input (vx `inputs.runtime`)',
    async () => {
      const a = (await dry(root, ['lib#rt'])).find((t) => t.id === 'lib#rt')!.hash
      await writeFile(path.join(root, 'runtime.txt'), 'rt-2\n')
      const b = (await dry(root, ['lib#rt'])).find((t) => t.id === 'lib#rt')!.hash
      expect(b).not.toBe(a)
    },
    TIMEOUT,
  )

  it(
    "`{workspaceRoot}/tsconfig.base.json` — a root file as one target's input (vx `workspaceFiles`), nobody else's",
    async () => {
      // An edit to the committed root file, not its creation (item 843).
      expect(await Bun.file(path.join(root, 'tsconfig.base.json')).text()).toBe(
        '{"compilerOptions":{}}\n',
      )
      const before = new Map((await dry(root, ['ts', 'lint', '--all'])).map((t) => [t.id, t.hash]))
      await writeFile(
        path.join(root, 'tsconfig.base.json'),
        '{"compilerOptions":{"strict":true}}\n',
      )
      const after = new Map((await dry(root, ['ts', 'lint', '--all'])).map((t) => [t.id, t.hash]))
      expect(after.get('lib#ts')).not.toBe(before.get('lib#ts'))
      for (const id of ['lib#lint', 'app#lint', 'ui#lint', 'docs#lint']) {
        expect(after.get(id)).toBe(before.get(id))
      }
    },
    TIMEOUT,
  )

  it(
    "`outputs` are restored on a cache hit; the project's manifest is no core input",
    async () => {
      const first = await summarized(root, ['ui#build'])
      expect(first.code).toBe(0)
      const out = path.join(root, 'packages', 'ui', 'dist', 'out.txt')
      await rm(path.join(root, 'packages', 'ui', 'dist'), { recursive: true })
      const second = await summarized(root, ['ui#build'])
      expect(second.tasks.get('ui#build')?.['status']).toBe('cache-hit')
      expect(await readFile(out, 'utf8')).toBe('built-ui\n')

      const pkgPath = path.join(root, 'packages', 'ui', 'package.json')
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
      await writeFile(pkgPath, JSON.stringify({ ...pkg, description: 'changed' }))
      // Nx keys the manifest; vx core keys no package file (2026-10-14), and
      // `@vzn/vx-lockfile` lists it as an input (its own suite pins that).
      const third = await summarized(root, ['ui#build'])
      expect(third.tasks.get('ui#build')?.['status']).toBe('cache-hit')
    },
    TIMEOUT,
  )
})

describe('Nx parity — cache control and failure handling', () => {
  let root: string
  beforeAll(async () => {
    root = await makeParityWorkspace('vx-parity-nx-cache-')
    const cfg = await readFile(path.join(root, 'packages', 'lib', 'vx.config.mjs'), 'utf8')
    await writeFile(
      path.join(root, 'packages', 'lib', 'vx.config.mjs'),
      cfg.replace(
        'lint: {',
        `fail: { exec: { command: 'exit 2' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } },
      after: { exec: { command: 'echo after' }, dependsOn: ['fail'] },
      lint: {`,
      ),
    )
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    '`--skipNxCache` (vx: `--force`) executes even when a hit exists',
    async () => {
      await vx(root, ['run', 'lib#lint'])
      const hit = await summarized(root, ['lib#lint'])
      expect(hit.tasks.get('lib#lint')?.['status']).toBe('cache-hit')
      const skipped = await summarized(root, ['lib#lint', '--force'])
      expect(skipped.tasks.get('lib#lint')?.['status']).toBe('success')
    },
    TIMEOUT,
  )

  it(
    'a failed target is not cached — it runs again next time, and its dependents are skipped',
    async () => {
      const first = await summarized(root, ['lib#after'])
      expect(first.code).toBe(1)
      expect(first.tasks.get('lib#fail')?.['status']).toBe('failed')
      expect(first.tasks.get('lib#after')?.['status']).toBe('skipped')
      const second = await summarized(root, ['lib#after'])
      expect(second.tasks.get('lib#fail')?.['status']).toBe('failed')
    },
    TIMEOUT,
  )

  it(
    '`--nxBail` (vx: `--continue=never`) still reds the run and skips what the failure blocks',
    async () => {
      const r = await summarized(root, ['lib#after', '--continue=never'])
      expect(r.code).toBe(1)
      expect(r.tasks.get('lib#after')?.['status']).toBe('skipped')
    },
    TIMEOUT,
  )

  it(
    "Nx Cloud's flaky-task flag has a local answer: the same hash failing after it passed is named",
    async () => {
      const cfgPath = path.join(root, 'packages', 'lib', 'vx.config.mjs')
      const cfg = await readFile(cfgPath, 'utf8')
      // The command is part of the key, so flip the outcome through a
      // file the inputs do not cover instead.
      await writeFile(cfgPath, cfg.replace("command: 'exit 2'", "command: 'test -f ../../green'"))
      const red = await summarized(root, ['lib#fail'])
      expect(red.tasks.get('lib#fail')?.['status']).toBe('failed')
      // A first pass after only failures is a recovery, not a flake.
      await writeFile(path.join(root, 'green'), '')
      const green = await summarized(root, ['lib#fail'])
      expect(green.code).toBe(0)
      expect(green.text).not.toContain('flaky -')
      // `--force`: the pass was cached, and a hit executes nothing.
      await unlink(path.join(root, 'green'))
      const relapse = await summarized(root, ['lib#fail', '--force'])
      expect(relapse.tasks.get('lib#fail')?.['status']).toBe('failed')
      expect(relapse.text).toContain('flaky - passed 1× before')
    },
    TIMEOUT,
  )
})

describe('Nx parity — path shapes, shared configs and outcomes Nx fixed', () => {
  const made: string[] = []
  afterAll(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true })
  })
  const workspace = async (prefix: string, projects: Record<string, ProjectFiles>) => {
    const root = await makeWorkspace({ prefix })
    made.push(root)
    for (const [name, spec] of Object.entries(projects)) await addProject(root, name, spec)
    return root
  }
  type ProjectFiles = { config: string; files?: Record<string, string> }

  it(
    'a workspace, a project, an input and an output whose paths hold spaces: saved, restored from the subdir, missed on an edit',
    async () => {
      const root = await workspace('vx parity w s-', {
        'a b': {
          config: `export default { tasks: { build: {
            exec: { command: 'mkdir -p "out dir" && cat "src/my file.txt" > "out dir/r e.txt"' },
            inputs: { files: ['src/my file.txt'] }, cache: { outputs: { files: ['out dir/**'] } },
          } } }\n`,
          files: { 'src/my file.txt': 'v1' },
        },
      })
      const dir = path.join(root, 'packages', 'a b')
      expect((await summarized(root, ['build', '--all'])).code).toBe(0)
      await rm(path.join(dir, 'out dir'), { recursive: true })
      expect((await vx(dir, ['run', 'build'])).code).toBe(0)
      expect(await readFile(path.join(dir, 'out dir', 'r e.txt'), 'utf8')).toBe('v1')
      expect((await summarized(root, ['build', '--all'])).tasks.get('a b#build')?.['status']).toBe(
        'cache-hit',
      )
      await writeFile(path.join(dir, 'src', 'my file.txt'), 'v2')
      expect((await summarized(root, ['build', '--all'])).tasks.get('a b#build')?.['status']).toBe(
        'success',
      )
    },
    TIMEOUT,
  )

  it(
    'one task object two projects import runs in each project as its own, keyed apart',
    async () => {
      const shared = `export { default } from '../../shared.mjs'\n`
      const root = await workspace('vx-parity-nx-shared-', {
        a: { config: shared, files: { 'src/x.txt': 'a' } },
        b: { config: shared, files: { 'src/x.txt': 'b' } },
      })
      await writeFile(
        path.join(root, 'shared.mjs'),
        `export default { tasks: { build: {
          exec: { command: 'basename "$PWD" > who.txt' },
          inputs: { files: ['src/**'] }, cache: { outputs: { files: ['who.txt'] } },
        } } }\n`,
      )
      expect((await summarized(root, ['build', '--all'])).code).toBe(0)
      const who = (p: string) => readFile(path.join(root, 'packages', p, 'who.txt'), 'utf8')
      expect([await who('a'), await who('b')]).toEqual(['a\n', 'b\n'])
      await writeFile(path.join(root, 'packages', 'b', 'src', 'x.txt'), 'b2')
      const r = await summarized(root, ['build', '--all'])
      expect([r.tasks.get('a#build')?.['status'], r.tasks.get('b#build')?.['status']]).toEqual([
        'cache-hit',
        'success',
      ])
    },
    TIMEOUT,
  )

  it(
    'a task named with a colon is its own task: run alone by name, keyed and recorded apart',
    async () => {
      const task = (word: string) =>
        `{ exec: { command: 'echo ${word}' }, inputs: { files: [] }, cache: { outputs: { files: [] } } }`
      const root = await workspace('vx-parity-nx-colon-', {
        a: {
          config: `export default { tasks: { build: ${task('dev')}, 'build:prod': ${task('prod')} } }\n`,
        },
      })
      const alone = await summarized(root, ['a#build:prod'])
      expect([alone.code, [...alone.tasks.keys()]]).toEqual([0, ['a#build:prod']])
      const both = await summarized(root, ['a#build', 'a#build:prod'])
      expect([
        both.tasks.get('a#build')?.['status'],
        both.tasks.get('a#build:prod')?.['status'],
      ]).toEqual(['success', 'cache-hit'])
    },
    TIMEOUT,
  )

  it(
    "a failed run under --no-cache leaves the cached success's output, and a task that prints nothing hits",
    async () => {
      const root = await workspace('vx-parity-nx-keep-log-', {
        a: {
          config: `export default { tasks: {
            t: {
              exec: { command: 'v=GOOD; c=0; if [ -f ../../red ]; then v=FAILED; c=1; fi; echo "$v-LOG"; exit $c' },
              inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
            },
            quiet: { exec: { command: 'true' }, inputs: { files: [] }, cache: { outputs: { files: [] } } },
          } }\n`,
          files: { 'src/x.txt': 'x' },
        },
      })
      expect((await summarized(root, ['a#t', 'a#quiet'])).code).toBe(0)
      await writeFile(path.join(root, 'red'), '')
      expect((await summarized(root, ['a#t', '--no-cache'])).code).toBe(1)
      await unlink(path.join(root, 'red'))
      const r = await summarized(root, ['a#t', 'a#quiet'])
      expect([r.code, r.tasks.get('a#t')?.['status'], r.tasks.get('a#quiet')?.['status']]).toEqual([
        0,
        'cache-hit',
        'cache-hit',
      ])
      expect([r.text.includes('GOOD-LOG'), r.text.includes('FAILED-LOG')]).toEqual([true, false])
    },
    TIMEOUT,
  )
})
