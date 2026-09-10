// Nx parity: what an Nx user relies on, run against vx's real CLI on the
// four-package fixture in helpers/parity.ts. Each case is named for the Nx
// contract (nx.dev, 23) it stands in for and asserts vx's documented
// equivalent; a deliberate divergence says so in the name. The deep pins
// live in the suites `docs/parity.md` maps.

import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { gitIn } from './helpers/workspace.js'
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
    '`nx affected -t lint` selects changed projects AND their dependents — vx spells that `--filter ...[ref]`; `--affected` alone is the changed set (divergence, documented)',
    async () => {
      await writeFile(path.join(root, 'packages', 'lib', 'src', 'in.txt'), 'lib-v2\n')
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'touch lib')
      expect(await planned(root, ['lint', '--filter', '...[HEAD~1]'])).toEqual([
        'app#lint',
        'lib#lint',
        'ui#lint',
      ])
      expect(await planned(root, ['lint', '--affected=HEAD~1'])).toEqual(['lib#lint'])
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
        cache: { inputs: { files: ['src/**'], runtime: ['cat ../../runtime.txt'] }, outputs: { files: [] } },
      },
      ts: {
        exec: { command: 'echo ts' },
        cache: { inputs: { files: ['src/**'], workspaceFiles: ['tsconfig.base.json'] }, outputs: { files: [] } },
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
    '`{ "runtime": "node -v" }` — a command\'s output is a hashed input (vx `cache.inputs.runtime`)',
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
    "`outputs` are restored on a cache hit, and the project's own manifest is an implicit input",
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
      const third = await summarized(root, ['ui#build'])
      expect(third.tasks.get('ui#build')?.['status']).toBe('success')
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
        `fail: { exec: { command: 'exit 2' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } },
      after: { exec: { command: 'echo after' }, dependsOn: ['fail'] },
      lint: {`,
      ),
    )
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    '`--skipNxCache` (vx: `--no-cache`) executes even when a hit exists',
    async () => {
      await vx(root, ['run', 'lib#lint'])
      const hit = await summarized(root, ['lib#lint'])
      expect(hit.tasks.get('lib#lint')?.['status']).toBe('cache-hit')
      const skipped = await summarized(root, ['lib#lint', '--no-cache'])
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
    "Nx Cloud's flaky-task flag has a local answer: the same hash failing then passing is named",
    async () => {
      // A key that failed (above) then passes on unchanged inputs is
      // flaky by both runners' definition; vx reads it from its own history.
      const cfgPath = path.join(root, 'packages', 'lib', 'vx.config.mjs')
      const cfg = await readFile(cfgPath, 'utf8')
      // The command is part of the key, so flip the outcome through a
      // file the inputs do not cover instead.
      await writeFile(cfgPath, cfg.replace("command: 'exit 2'", "command: 'test -f ../../green'"))
      const red = await summarized(root, ['lib#fail'])
      expect(red.tasks.get('lib#fail')?.['status']).toBe('failed')
      await writeFile(path.join(root, 'green'), '')
      const green = await summarized(root, ['lib#fail'])
      expect(green.code).toBe(0)
      expect(green.tasks.get('lib#fail')?.['flaky']).toEqual({
        passes: 1,
        failures: 1,
        attempts: 1,
      })
      expect(green.text).toContain('Flaky:')
    },
    TIMEOUT,
  )
})
