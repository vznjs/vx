// Turbo parity: what a Turborepo user relies on, run against vx's real CLI
// on the four-package fixture in helpers/parity.ts. Each case is named for
// the Turbo contract (turborepo.dev/docs, 2.10) it stands in for and asserts
// vx's documented equivalent; a deliberate divergence says so in the name.
// The deep pins for each behaviour live in the suites `docs/parity.md`
// maps; this file is the one place a Turbo reader can scan.

import { readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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

describe('Turbo parity — task graph (turbo.json `dependsOn`)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeParityWorkspace('vx-parity-turbo-graph-')
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    '`"dependsOn": ["^build"]` — a package builds after every workspace dependency builds',
    async () => {
      const tasks = await dry(root, ['build', '--filter', 'app'])
      const deps = new Map(tasks.map((t) => [t.id, [...t.deps].sort()]))
      expect(deps.get('app#build')).toEqual(['lib#build', 'ui#build'])
      expect(deps.get('ui#build')).toEqual(['lib#build'])
      expect(deps.get('lib#build')).toEqual([])
      // Pulling in `app` pulled in its transitive builds and nothing else.
      expect([...deps.keys()].sort()).toEqual(['app#build', 'lib#build', 'ui#build'])
    },
    TIMEOUT,
  )

  it(
    '`"dependsOn": ["build"]` — a bare name waits on the same package\'s task',
    async () => {
      const tasks = await dry(root, ['test', '--filter', 'lib'])
      expect(tasks.find((t) => t.id === 'lib#test')?.deps).toEqual(['lib#build'])
    },
    TIMEOUT,
  )

  it(
    '`"dependsOn": ["pkg#task"]` — an explicit edge to another package\'s task',
    async () => {
      const cfg = await readFile(path.join(root, 'packages', 'docs', 'vx.config.mjs'), 'utf8')
      await writeFile(
        path.join(root, 'packages', 'docs', 'vx.config.mjs'),
        cfg.replace(
          'lint: {',
          "publish: { exec: { command: 'echo publish' }, dependsOn: ['app#build'] },\n      lint: {",
        ),
      )
      const tasks = await dry(root, ['docs#publish'])
      expect(tasks.find((t) => t.id === 'docs#publish')?.deps).toEqual(['app#build'])
      expect(tasks.map((t) => t.id).sort()).toEqual([
        'app#build',
        'docs#publish',
        'lib#build',
        'ui#build',
      ])
    },
    TIMEOUT,
  )

  it(
    '`--only` — run the requested task without its `dependsOn` (vx: `--exclude-dependencies`)',
    async () => {
      expect(await planned(root, ['build', '--filter', 'app', '--exclude-dependencies'])).toEqual([
        'app#build',
      ])
    },
    TIMEOUT,
  )

  it(
    '`--dry=json` lists every task with its hash and predicted cache status, and executes nothing',
    async () => {
      const tasks = await dry(root, ['build', '--all'])
      for (const t of tasks) {
        expect(t.hash).toMatch(/^[0-9a-f]{16,}$/)
        expect(t.cacheStatus).toBe('miss')
        expect(t.description).toBe(`build ${t.project}`)
      }
      expect(existsSync(path.join(root, 'packages', 'lib', 'dist'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    '`--graph` emits Graphviz DOT with one edge per `dependsOn`',
    async () => {
      const r = await vx(root, ['run', 'build', '--filter', 'ui', '--graph'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('digraph')
      // Edges point the way work flows: dependency → dependent.
      expect(r.out).toMatch(/"lib#build"\s*->\s*"ui#build"/)
    },
    TIMEOUT,
  )
})

describe('Turbo parity — `--filter` (package selection)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeParityWorkspace('vx-parity-turbo-filter-')
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    '`--filter=app` selects by package name; `dependsOn` still pulls its builds in',
    async () => {
      expect(await planned(root, ['lint', '--filter', 'app'])).toEqual(['app#lint'])
      expect(await planned(root, ['build', '--filter', 'app'])).toEqual([
        'app#build',
        'lib#build',
        'ui#build',
      ])
    },
    TIMEOUT,
  )

  it(
    '`--filter=app...` selects a package and its dependencies',
    async () => {
      expect(await planned(root, ['lint', '--filter', 'app...'])).toEqual([
        'app#lint',
        'lib#lint',
        'ui#lint',
      ])
    },
    TIMEOUT,
  )

  it(
    '`--filter=...lib` selects a package and its dependents',
    async () => {
      expect(await planned(root, ['lint', '--filter', '...lib'])).toEqual([
        'app#lint',
        'lib#lint',
        'ui#lint',
      ])
      expect(await planned(root, ['lint', '--filter', '...ui'])).toEqual(['app#lint', 'ui#lint'])
    },
    TIMEOUT,
  )

  it(
    '`--filter=./packages/ui` selects by directory; `--filter=!docs` excludes',
    async () => {
      expect(await planned(root, ['lint', '--filter', './packages/ui'])).toEqual(['ui#lint'])
      expect(await planned(root, ['lint', '--all', '--filter', '!docs'])).toEqual([
        'app#lint',
        'lib#lint',
        'ui#lint',
      ])
    },
    TIMEOUT,
  )

  it(
    '`--filter=[HEAD~1]` selects the packages with changed files since a ref',
    async () => {
      await writeFile(path.join(root, 'packages', 'lib', 'src', 'in.txt'), 'lib-v2\n')
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'touch lib')
      expect(await planned(root, ['lint', '--filter', '[HEAD~1]'])).toEqual(['lib#lint'])
      // `--affected=<ref>` is the same selection spelled as a flag.
      expect(await planned(root, ['lint', '--affected=HEAD~1'])).toEqual(['lib#lint'])
      // `...[ref]` widens to dependents: "prove I broke nothing downstream".
      expect(await planned(root, ['lint', '--filter', '...[HEAD~1]'])).toEqual([
        'app#lint',
        'lib#lint',
        'ui#lint',
      ])
    },
    TIMEOUT,
  )

  it(
    'a `--filter` that matches no package refuses the run (Turbo: exits 1 too)',
    async () => {
      const r = await vx(root, ['run', 'lint', '--filter', 'nope'])
      expect(r.code).not.toBe(0)
      expect(r.err).toContain('nope')
    },
    TIMEOUT,
  )
})

describe('Turbo parity — caching (`inputs`, `outputs`, `env`, `cache: false`)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeParityWorkspace('vx-parity-turbo-cache-')
    const cfg = await readFile(path.join(root, 'packages', 'lib', 'vx.config.mjs'), 'utf8')
    await writeFile(
      path.join(root, 'packages', 'lib', 'vx.config.mjs'),
      cfg.replace(
        'lint: {',
        `env: {
        exec: { command: 'echo mode=$MODE token=$TOKEN', env: { passThrough: ['MODE', 'TOKEN'] } },
        cache: { inputs: { files: ['src/**'], env: ['MODE'] }, outputs: { files: [] } },
      },
      uncached: { exec: { command: 'echo uncached' } },
      args: {
        exec: { command: 'echo args' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
      },
      lint: {`,
      ),
    )
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'a second run is a cache hit; deleted `outputs` come back from the cache; logs replay',
    async () => {
      const first = await summarized(root, ['build', '--all'])
      expect(first.code).toBe(0)
      for (const t of first.tasks.values()) expect(t['status']).toBe('success')

      const dist = path.join(root, 'packages', 'app', 'dist', 'out.txt')
      expect(await readFile(dist, 'utf8')).toBe('built-app\n')
      await rm(path.join(root, 'packages', 'app', 'dist'), { recursive: true })

      const second = await summarized(root, ['build', '--all', '--output-logs', 'full'])
      expect(second.code).toBe(0)
      for (const t of second.tasks.values()) expect(t['status']).toBe('cache-hit')
      expect(await readFile(dist, 'utf8')).toBe('built-app\n')
      // Turbo replays the cached stdout on a hit; so does vx.
      expect(second.text).toContain('app-v1')
    },
    TIMEOUT,
  )

  it(
    'an `inputs` change misses — and cascades to dependents, which fold upstream inputs',
    async () => {
      const before = new Map((await dry(root, ['build', '--all'])).map((t) => [t.id, t.hash]))
      await writeFile(path.join(root, 'packages', 'lib', 'src', 'in.txt'), 'lib-v2\n')
      const after = new Map((await dry(root, ['build', '--all'])).map((t) => [t.id, t.hash]))
      for (const id of ['lib#build', 'ui#build', 'app#build']) {
        expect(after.get(id)).not.toBe(before.get(id))
      }
      expect(after.get('docs#build')).toBe(before.get('docs#build'))
    },
    TIMEOUT,
  )

  it(
    'a file outside `inputs` changes nothing (Turbo: `inputs` narrows the default)',
    async () => {
      const before = new Map((await dry(root, ['build', '--all'])).map((t) => [t.id, t.hash]))
      await writeFile(path.join(root, 'packages', 'lib', 'README.md'), '# lib\n')
      const after = new Map((await dry(root, ['build', '--all'])).map((t) => [t.id, t.hash]))
      expect(after).toEqual(before)
    },
    TIMEOUT,
  )

  it(
    '`"env": ["MODE"]` is in the hash; `passThroughEnv` (vx `env.passThrough`) is not',
    async () => {
      const hashOf = async (env: Record<string, string>) =>
        (await dry(root, ['lib#env'], env)).find((t) => t.id === 'lib#env')!.hash
      const a = await hashOf({ MODE: 'a', TOKEN: 't1' })
      expect(await hashOf({ MODE: 'b', TOKEN: 't1' })).not.toBe(a)
      expect(await hashOf({ MODE: 'a', TOKEN: 't2' })).toBe(a)
      // …and the passed-through value still reaches the command.
      const r = await vx(root, ['run', 'lib#env', '--output-logs', 'full'], {
        MODE: 'a',
        TOKEN: 't3',
      })
      expect(r.code).toBe(0)
      expect(r.out + r.err).toContain('mode=a token=t3')
    },
    TIMEOUT,
  )

  it(
    '`"cache": false` (vx: no `cache` block) executes on every run',
    async () => {
      for (let i = 0; i < 2; i++) {
        const r = await summarized(root, ['lib#uncached'])
        expect(r.code).toBe(0)
        expect(r.tasks.get('lib#uncached')?.['status']).toBe('success')
        expect(r.tasks.get('lib#uncached')?.['noCache']).toBe(true)
      }
    },
    TIMEOUT,
  )

  it(
    '`--force` re-executes past the cache and refreshes it; `--no-cache` neither reads nor writes',
    async () => {
      await vx(root, ['run', 'lib#lint'])
      const forced = await summarized(root, ['lib#lint', '--force'])
      expect(forced.tasks.get('lib#lint')?.['status']).toBe('success')
      const after = await summarized(root, ['lib#lint'])
      expect(after.tasks.get('lib#lint')?.['status']).toBe('cache-hit')
      const none = await summarized(root, ['lib#lint', '--no-cache'])
      expect(none.tasks.get('lib#lint')?.['status']).toBe('success')
    },
    TIMEOUT,
  )

  it(
    'arguments after `--` reach the command and are part of the hash',
    async () => {
      const plain = await summarized(root, ['lib#args', '--output-logs', 'full'])
      const flagged = await summarized(root, ['lib#args', '--output-logs', 'full', '--', '--flag'])
      expect(flagged.text).toContain('args --flag')
      expect(flagged.tasks.get('lib#args')?.['hash']).not.toBe(
        plain.tasks.get('lib#args')?.['hash'],
      )
      expect(flagged.tasks.get('lib#args')?.['status']).toBe('success')
    },
    TIMEOUT,
  )

  it(
    'the lockfile is in every hash (Turbo: the global hash); a package.json change re-keys its package',
    async () => {
      const before = new Map((await dry(root, ['lint', '--all'])).map((t) => [t.id, t.hash]))
      await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
      const locked = new Map((await dry(root, ['lint', '--all'])).map((t) => [t.id, t.hash]))
      for (const [id, hash] of before) expect(locked.get(id)).not.toBe(hash)

      const pkgPath = path.join(root, 'packages', 'docs', 'package.json')
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
      await writeFile(pkgPath, JSON.stringify({ ...pkg, version: '0.0.1' }))
      const bumped = new Map((await dry(root, ['lint', '--all'])).map((t) => [t.id, t.hash]))
      expect(bumped.get('docs#lint')).not.toBe(locked.get('docs#lint'))
      for (const id of ['app#lint', 'ui#lint', 'lib#lint']) {
        expect(bumped.get(id)).toBe(locked.get(id))
      }
    },
    TIMEOUT,
  )
})

describe('Turbo parity — failures, output and reports', () => {
  let root: string
  beforeAll(async () => {
    root = await makeParityWorkspace('vx-parity-turbo-run-')
    const cfg = await readFile(path.join(root, 'packages', 'lib', 'vx.config.mjs'), 'utf8')
    await writeFile(
      path.join(root, 'packages', 'lib', 'vx.config.mjs'),
      cfg.replace(
        'lint: {',
        `fail: { exec: { command: 'echo boom >&2; exit 3' } },
      after: { exec: { command: 'echo after' }, dependsOn: ['fail'] },
      lint: {`,
      ),
    )
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'a failure skips its dependents and reds the run (Turbo `--continue=dependencies-successful`; vx default)',
    async () => {
      const r = await summarized(root, ['lib#after'])
      expect(r.code).toBe(1)
      expect(r.tasks.get('lib#fail')?.['status']).toBe('failed')
      expect(r.tasks.get('lib#fail')?.['exitCode']).toBe(3)
      expect(r.tasks.get('lib#after')?.['status']).toBe('skipped')
    },
    TIMEOUT,
  )

  it(
    '`--continue` runs dependents past a failure; the run is still red',
    async () => {
      const r = await summarized(root, ['lib#after', '--continue'])
      expect(r.code).toBe(1)
      expect(r.tasks.get('lib#fail')?.['status']).toBe('failed')
      expect(r.tasks.get('lib#after')?.['status']).toBe('success')
    },
    TIMEOUT,
  )

  it(
    'a failed task is never a cache hit next time (Turbo caches successes only)',
    async () => {
      await vx(root, ['run', 'lib#fail'])
      const again = await summarized(root, ['lib#fail'])
      expect(again.tasks.get('lib#fail')?.['status']).toBe('failed')
    },
    TIMEOUT,
  )

  it(
    "`--output-logs=errors-only` hides a passing task's output and shows a failing one's",
    async () => {
      const ok = await vx(root, ['run', 'lib#lint', '--force', '--output-logs', 'errors-only'])
      expect(ok.code).toBe(0)
      expect(ok.out + ok.err).not.toContain('lint-lib')
      const bad = await vx(root, ['run', 'lib#fail', '--output-logs', 'errors-only'])
      expect(bad.code).toBe(1)
      expect(bad.out + bad.err).toContain('boom')
    },
    TIMEOUT,
  )

  it(
    "`--summarize` writes a per-run JSON with every task's status, hash and timing",
    async () => {
      const r = await summarized(root, ['lint', '--all'])
      expect(r.code).toBe(0)
      expect([...r.tasks.keys()].sort()).toEqual(['app#lint', 'docs#lint', 'lib#lint', 'ui#lint'])
      for (const t of r.tasks.values()) {
        expect(typeof t['durationMs']).toBe('number')
        expect(typeof t['hash']).toBe('string')
      }
    },
    TIMEOUT,
  )

  it(
    '`--concurrency` caps parallel execution (Turbo `--concurrency`), `1` serializes',
    async () => {
      const r = await vx(root, ['run', 'lint', '--all', '--force', '--concurrency', '1'])
      expect(r.code).toBe(0)
      expect(r.out + r.err).toContain('1 worker')
    },
    TIMEOUT,
  )
})
