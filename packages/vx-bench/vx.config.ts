import { defineProject } from '@vzn/vx'

// The site's playground files the research tools in playground-spike/
// import (item 695), granted by name and keyed as inputs.
const PLAYGROUND = [
  'packages/vx-docs/scripts/build-playground.ts',
  'packages/vx-docs/src/playground/**',
  'packages/vx-docs/tests/glob-fuzz.ts',
  'packages/vx-docs/tests/helpers/rng.ts',
]

export default defineProject({
  tasks: {
    install: {
      dependsOn: ['^build'],
    },

    ci: {
      dependsOn: ['lint', 'test', 'check.site', 'check.perf'],
    },

    // The per-PR performance guard (perf-guard.ts): exact work counts and
    // box-normalized times of core's hot paths against perf-baseline.json.
    // Core's source reaches the key through install's ^build.
    'check.perf': {
      description: 'perf-guard.ts: hot-path counts and times against perf-baseline.json',
      dependsOn: ['install'],
      exec: {
        command: 'bun perf-guard.ts',
        sandbox: { allow: { read: ['**/*'], systemInfo: ['vfs.disk-space'] } },
      },
      cache: {
        inputs: { files: ['perf-guard.ts', 'perf-baseline.json', 'package.json'] },
        outputs: { files: [] },
      },
    },

    // Records this platform's numbers after a change meant to move them.
    'perf.update': {
      description: 'perf-guard.ts --update: rewrite perf-baseline.json for this platform',
      dependsOn: ['install'],
      exec: {
        command: 'bun perf-guard.ts --update',
        sandbox: {
          allow: { read: ['**/*'], write: ['perf-baseline.json'], systemInfo: ['vfs.disk-space'] },
        },
      },
    },

    // The landing page's benchmark rows, the benchmarks doc's stress
    // section, the README's benchmark table and the vx-vs-Turborepo and
    // vx-vs-Nx pages' tables are generated from
    // results.json by update-site.ts; `--check` fails when any
    // drifted. All live outside this project, so the task declares the
    // reads and folds the files as inputs.
    'check.site': {
      description: 'update-site.ts --check: the site matches results.json',
      dependsOn: ['install'],
      exec: {
        command: 'bun update-site.ts --check',
        sandbox: {
          allow: {
            read: [
              '**/*',
              '../vx-docs/src/pages/index.astro',
              '../vx/docs/benchmarks.md',
              '../../README.md',
              '../vx-docs/src/content/docs/compare/turborepo.md',
              '../vx-docs/src/content/docs/compare/nx.md',
            ],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      cache: {
        inputs: {
          files: ['update-site.ts', 'results.json'],
          workspaceFiles: [
            'packages/vx-docs/src/pages/index.astro',
            'packages/vx/docs/benchmarks.md',
            'README.md',
            'packages/vx-docs/src/content/docs/compare/turborepo.md',
            'packages/vx-docs/src/content/docs/compare/nx.md',
          ],
        },
        outputs: { files: [] },
      },
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

    // The type-check follows playground-spike/'s imports into the site's
    // playground, so it declares that read and keys on those files.
    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      exec: {
        command: 'oxlint --type-aware --type-check',
        sandbox: {
          allow: {
            read: ['**/*', ...PLAYGROUND.map((p) => p.replace('packages/', '../'))],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: [
            '*.ts',
            'tests/**',
            'playground-spike/**/*.ts',
            'package.json',
            '.oxlintrc.json',
            'tsconfig.json',
          ],
          workspaceFiles: PLAYGROUND,
        },
        outputs: { files: [] },
      },
    },

    'lint.oxfmt': {
      description: 'oxfmt --check (no rewrite; CI-safe)',
      exec: {
        command: 'oxfmt --check .',
        sandbox: { allow: { read: ['**/*'], systemInfo: ['vfs.disk-space'] } },
      },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: ['**/*'],
        },
        outputs: { files: [] },
      },
    },

    test: {
      description: 'bun test',
      exec: {
        command: 'bun test --only-failures',
        env: { define: { VX_CACHE_DIR: '.vx/cache' } },
        sandbox: {
          allow: {
            read: ['**/*'],
            systemInfo: ['vfs.disk-space', 'net.link.addr'],
          },
        },
      },
      dependsOn: ['install'],
      cache: {
        inputs: { files: ['*.ts', 'tests/**', 'package.json'] },
        outputs: { files: [] },
      },
    },
  },
})
