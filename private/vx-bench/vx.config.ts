import { defineProject } from '@vzn/vx'

// Bun's transpiler cache writes under HOME, outside the sandbox's grants.
const NO_TRANSPILER_CACHE = { define: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } }

export default defineProject({
  tasks: {
    install: {
      dependsOn: ['^build'],
    },

    ci: {
      dependsOn: ['lint', 'test', 'check.site'],
    },

    // The per-PR benchmarks, one task so they never share a machine with
    // each other: on #4323's CI the two ran side by side beside two test
    // shards and the Turbo ratio failed a commit its rerun passed. Not in
    // `ci`: CI runs it in a job of its own, off the DTE run (ci.yml `perf`).
    // perf-guard.ts: exact work counts and box-normalized times of core's
    // hot paths against perf-baseline.json. pr-bench.ts: vx / turbo time
    // ratios on one small workspace, held to pr-bench-baseline.json, from
    // the pairs no other process disturbed (quiet.ts). Core's source
    // reaches the key through install's ^build.
    'check.perf': {
      description:
        'perf-guard.ts then pr-bench.ts: hot-path counts and vx vs Turborepo ratios against their baselines',
      dependsOn: ['install'],
      exec: {
        command: 'bun perf-guard.ts && bun pr-bench.ts',
        env: NO_TRANSPILER_CACHE,
        sandbox: { allow: { read: ['**/*'], systemInfo: ['vfs.disk-space'] } },
      },
      inputs: {
        files: [
          'perf-guard.ts',
          'perf-baseline.json',
          'pr-bench.ts',
          'pr-bench-baseline.json',
          'quiet.ts',
          'bench-env.ts',
          'edges.ts',
          'workspace-copy.ts',
          'package.json',
        ],
      },
      cache: {
        outputs: { files: [] },
      },
    },

    'vs-turbo.update': {
      description: 'pr-bench.ts --update: record this platform in pr-bench-baseline.json',
      dependsOn: ['install'],
      exec: {
        command: 'bun pr-bench.ts --update',
        env: NO_TRANSPILER_CACHE,
        sandbox: { allow: { read: ['**/*'], write: ['pr-bench-baseline.json'] } },
      },
    },

    // Records this platform's numbers after a change meant to move them.
    'perf.update': {
      description: 'perf-guard.ts --update: rewrite perf-baseline.json for this platform',
      dependsOn: ['install'],
      exec: {
        command: 'bun perf-guard.ts --update',
        env: NO_TRANSPILER_CACHE,
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
        env: NO_TRANSPILER_CACHE,
        sandbox: {
          allow: {
            read: [
              '**/*',
              '../vx-docs/src/pages/index.astro',
              '../../packages/vx/docs/benchmarks.md',
              '../../README.md',
              '../vx-docs/src/content/docs/compare/turborepo.md',
              '../vx-docs/src/content/docs/compare/nx.md',
            ],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      inputs: {
        files: ['update-site.ts', 'results.json'],
        workspaceFiles: [
          'private/vx-docs/src/pages/index.astro',
          'packages/vx/docs/benchmarks.md',
          'README.md',
          'private/vx-docs/src/content/docs/compare/turborepo.md',
          'private/vx-docs/src/content/docs/compare/nx.md',
        ],
      },
      cache: {
        outputs: { files: [] },
      },
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      exec: {
        command: 'oxlint --type-aware --type-check',
        sandbox: {
          allow: {
            read: ['**/*'],
            systemInfo: ['vfs.disk-space'],
          },
        },
      },
      dependsOn: ['install'],
      inputs: {
        files: ['*.ts', 'tests/**', 'package.json', '.oxlintrc.json', 'tsconfig.json'],
      },
      cache: {
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
      inputs: {
        files: ['**/*'],
      },
      cache: {
        outputs: { files: [] },
      },
    },

    test: {
      description: 'bun test',
      exec: {
        command: 'bun test --only-failures',
        env: { define: { ...NO_TRANSPILER_CACHE.define, VX_CACHE_DIR: '.vx/cache' } },
        sandbox: {
          allow: {
            read: ['**/*'],
            systemInfo: ['vfs.disk-space', 'net.link.addr'],
          },
        },
      },
      dependsOn: ['install'],
      inputs: { files: ['*.ts', 'tests/**', 'package.json'] },
      cache: {
        outputs: { files: [] },
      },
    },
  },
})
