// A migrated Nx executor target is the plain command its executor runs,
// not an `nx-exec` line that needs Nx installed (P2-1). Each row is the
// line read from the executor's own source in Nx 23.2; an executor with no
// translator is a failing placeholder and one TODO per executor.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { migrateNx } from '../src/migrate-nx.js'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'
import { nativeExecutorCommand } from '../src/nx/nx-native.js'

const lib = { projectRel: 'libs/a', projectName: 'a' }

describe('nativeExecutorCommand', () => {
  const rows: Array<[string, string, Record<string, unknown>, string, string[]]> = [
    [
      'jest runs from the workspace root with its paths as written',
      '@nx/jest:jest',
      {
        jestConfig: 'libs/a/jest.config.ts',
        passWithNoTests: true,
        codeCoverage: true,
        coverageDirectory: '{workspaceRoot}/coverage/libs/a',
        tsConfig: 'libs/a/tsconfig.spec.json',
        ci: false,
        testFile: 'a.spec.ts',
      },
      'cd ../.. && jest --config=libs/a/jest.config.ts --coverage --passWithNoTests --coverageDirectory=coverage/libs/a a.spec.ts',
      [],
    ],
    [
      'the @nrwl scope is the @nx executor',
      '@nrwl/jest:jest',
      { jestConfig: 'libs/a/jest.config.ts', reporters: ['default', 'jest-junit'] },
      'cd ../.. && jest --config=libs/a/jest.config.ts --reporters=default --reporters=jest-junit',
      [],
    ],
    [
      'an option with no flag spelling is named, not dropped',
      '@nx/jest:jest',
      { jestConfig: 'jest.config.ts', globals: { a: 1 } },
      'cd ../.. && jest --config=jest.config.ts',
      ['@nx/jest:jest option "globals" is not a flag value — not carried'],
    ],
    [
      'vitest runs once from the project dir, its paths project-relative',
      '@nx/vitest:test',
      {
        configFile: 'libs/a/vite.config.ts',
        reportsDirectory: '{workspaceRoot}/coverage/libs/a',
        testFiles: ['a.spec.ts'],
        passWithNoTests: true,
      },
      'vitest run --config=vite.config.ts --coverage.reportsDirectory=../../coverage/libs/a --passWithNoTests a.spec.ts',
      [],
    ],
    ['@nx/vite:test in watch mode', '@nx/vite:test', { watch: true }, 'vitest watch', []],
    ['vitest benchmarks', '@nx/vitest:test', { runMode: 'benchmark' }, 'vitest bench', []],
    [
      'vite build: outputPath is --outDir, and what Nx did besides is a TODO',
      '@nx/vite:build',
      { outputPath: 'dist/libs/a', configFile: '{projectRoot}/vite.config.ts', mode: 'production' },
      'vite build --config=vite.config.ts --outDir=../../dist/libs/a --emptyOutDir --mode=production',
      [
        '@nx/vite:build type-checked the project before building (unless the workspace uses TS project references) — add a typecheck task to dependsOn, or drop this line',
        "@nx/vite:build copied the project's package.json (if any) into the output dir — vite does not",
      ],
    ],
    [
      'vite build with neither extra step',
      '@nx/vite:build',
      { skipTypeCheck: true, generatePackageJson: false },
      'vite build',
      [],
    ],
    [
      'eslint defaults to the project dir',
      '@nx/eslint:lint',
      { format: 'stylish', maxWarnings: -1, hasTypeAwareRules: true },
      'eslint .',
      [],
    ],
    [
      'eslint patterns and flags',
      '@nx/eslint:lint',
      {
        lintFilePatterns: ['libs/a/**/*.ts', '{projectRoot}/package.json'],
        maxWarnings: 0,
        fix: true,
        format: 'json',
        outputFile: 'reports/lint.json',
        errorOnUnmatchedPattern: false,
      },
      "eslint --max-warnings=0 --fix --format=json --output-file=../../reports/lint.json --no-error-on-unmatched-pattern '**/*.ts' package.json",
      [],
    ],
    [
      '`force` passes the task on lint errors, as Nx did',
      '@nx/linter:eslint',
      { force: true, bogus: 1 },
      'eslint . || true',
      ['@nx/eslint:lint option "bogus" has no eslint flag — not carried'],
    ],
    [
      'tsc empties the output dir and roots at the project',
      '@nx/js:tsc',
      {
        outputPath: 'dist/libs/a',
        tsConfig: 'libs/a/tsconfig.lib.json',
        main: 'libs/a/src/index.ts',
        assets: ['libs/a/*.md'],
      },
      'rm -rf ../../dist/libs/a && tsc -p tsconfig.lib.json --outDir ../../dist/libs/a --rootDir .',
      [
        '@nx/js:tsc copied `assets` into the output dir — tsc does not; add a copy step',
        '@nx/js:tsc wrote a package.json (main, types, exports) into the output dir — tsc does not',
      ],
    ],
    [
      'tsc with clean off and no package.json',
      '@nx/js:tsc',
      {
        outputPath: 'dist/libs/a',
        tsConfig: 'libs/a/tsconfig.lib.json',
        clean: false,
        generatePackageJson: false,
      },
      'tsc -p tsconfig.lib.json --outDir ../../dist/libs/a --rootDir .',
      [],
    ],
    [
      'playwright installs first and passes with no tests, Nx’s defaults',
      '@nx/playwright:playwright',
      { config: 'libs/a/playwright.config.ts' },
      'cd ../.. && playwright install && playwright test --pass-with-no-tests --config=libs/a/playwright.config.ts',
      [],
    ],
    [
      'playwright with the defaults turned off',
      '@nx/playwright:playwright',
      {
        skipInstall: true,
        passWithNoTests: false,
        project: ['chromium'],
        testFiles: ['a.spec.ts'],
        maxFailures: 2,
      },
      'cd ../.. && playwright test a.spec.ts --project=chromium --max-failures=2',
      [],
    ],
  ]
  for (const [title, executor, options, command, todos] of rows) {
    it(title, () => {
      expect(nativeExecutorCommand(executor, options, lib)).toEqual({ command, env: {}, todos })
    })
  }

  it('a root project needs no cd', () => {
    expect(
      nativeExecutorCommand(
        '@nx/jest:jest',
        { jestConfig: 'jest.config.ts' },
        { projectRel: '.', projectName: 'r' },
      )?.command,
    ).toBe('jest --config=jest.config.ts')
  })

  it('playwright’s cacheDir is its env var', () => {
    expect(
      nativeExecutorCommand(
        '@nx/playwright:playwright',
        { skipInstall: true, cacheDir: '.pw' },
        lib,
      )?.env,
    ).toEqual({ PWTEST_CACHE_DIR: '.pw' })
  })

  it('an executor with no translator has no line', () => {
    expect(nativeExecutorCommand('@nx/angular:application', {}, lib)).toBeNull()
    expect(nativeExecutorCommand('@nx/webpack:webpack', {}, lib)).toBeNull()
  })
})

describe('the migrator writes no nx-exec line', () => {
  const graph = {
    nodes: {
      a: {
        name: 'a',
        data: {
          root: 'libs/a',
          targets: {
            test: { executor: '@nx/jest:jest', options: { jestConfig: 'libs/a/jest.config.ts' } },
            pack: {
              executor: '@nx/angular:application',
              options: { project: 'libs/a/ng-package.json' },
            },
          },
        },
      },
      b: {
        name: 'b',
        data: {
          root: 'libs/b',
          targets: { pack: { executor: '@nx/angular:application', options: {} } },
        },
      },
    },
    dependencies: {},
  }

  async function fixture(): Promise<{ root: string; metas: ProjectMeta[] }> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-native-'))
    await writeFile(path.join(root, 'package.json'), '{"name":"root","private":true}')
    const metas = ['a', 'b'].map((n) => ({
      name: n,
      dir: path.join(root, 'libs', n),
      packageJson: { name: n },
      configPath: null,
    }))
    await writeFile(path.join(root, 'graph.json'), JSON.stringify(graph))
    return { root, metas }
  }

  it('a known executor is its command; an unknown one fails naming it, one TODO per executor', async () => {
    const { root, metas } = await fixture()
    try {
      const plan = await migrateNx(root, metas, 'ts', path.join(root, 'graph.json'))
      const tasks = Object.fromEntries(
        plan.projects.flatMap((p) => p.tasks.map((t) => [`${p.name}#${t.name}`, t])),
      )
      expect(Object.keys(tasks).sort()).toEqual(['a#pack', 'a#test', 'b#pack'])
      const command = (id: string) => (tasks[id]!.task!['exec'] as { command: string }).command
      expect(command('a#test')).toBe('cd ../.. && jest --config=libs/a/jest.config.ts')
      expect(tasks['a#test']!.todos).toEqual([])
      expect(command('a#pack')).toBe(
        `echo 'TODO(vx-migrate): the command @nx/angular:application ran with {"project":"libs/a/ng-package.json"}' >&2 && exit 1`,
      )
      expect(command('b#pack')).toBe(
        "echo 'TODO(vx-migrate): the command @nx/angular:application ran' >&2 && exit 1",
      )
      // The same reason on both: the report prints it once, under both tasks.
      const reason =
        'executor "@nx/angular:application" has no plain command here — replace the placeholder with the line it runs'
      expect(tasks['a#pack']!.todos).toEqual([reason])
      expect(tasks['b#pack']!.todos).toEqual([reason])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // Control: the `nx()` plugin runs the repo unchanged, executors through nx-exec.
  it('the plugin’s mapping keeps nx-exec', async () => {
    const { root, metas } = await fixture()
    try {
      const mapped = await mapNxWorkspace(root, metas, parseNxGraph(JSON.stringify(graph), 'g'), {
        persistentTodo: 'p',
        cacheable: new Set(),
      })
      const test = mapped.projects[0]!.tasks.find((t) => t.name === 'test')!
      expect((test.task!['exec'] as { command: string }).command).toBe(
        `nx-exec @nx/jest:jest --project a --target test --options '{"jestConfig":"libs/a/jest.config.ts"}'`,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
