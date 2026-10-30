import { defineProject } from '@vzn/vx'

// Bun's transpiler cache writes under HOME, outside the sandbox's grants.
const NO_TRANSPILER_CACHE = { define: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } }

// What the head-to-head's numbers depend on besides the tool measured.
const HARNESS = [
  'compare.ts',
  'shape.ts',
  'prng.ts',
  'ideal.ts',
  'ab.ts',
  'outputs.ts',
  'bench-env.ts',
  'package.json',
]

export default defineProject({
  tasks: {
    install: {
      dependsOn: ['^build'],
    },

    ci: {
      dependsOn: ['lint', 'test'],
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
        // The commit pr-bench.ts times this checkout against (ci.yml sets it).
        env: { ...NO_TRANSPILER_CACHE, passThrough: ['VX_BENCH_BASE'] },
        // The base's source comes out of git's objects (pr-bench-base.ts).
        sandbox: { allow: { read: ['**/*', '../../.git'], systemInfo: ['vfs.disk-space'] } },
      },
      inputs: {
        files: [
          'perf-guard.ts',
          'perf-baseline.json',
          'pr-bench.ts',
          'pr-bench-base.ts',
          'pr-bench-baseline.json',
          'quiet.ts',
          'bench-env.ts',
          'edges.ts',
          'workspace-copy.ts',
          'package.json',
        ],
        // A new base is a new yardstick: the bench runs again against it.
        env: ['VX_BENCH_BASE'],
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

    // The site's head-to-head (2026-10-29: no figure on the site is typed by
    // hand). One task per runner, each writing its rows to site/<runner>.json,
    // which @vzn/vx-docs#bench.data gathers into the site's bench.json. vx's is
    // keyed on its source through install's ^build, a rival's on the
    // harness and the pins in package.json. One runner at a time on a
    // machine of its own: only CI's Bench job (ci.yml) runs them, with
    // `--concurrency 1 --force`, so all four time the same CPU, and no build
    // depends on them, so a DTE worker, packed beside other tasks, never does.
    ...Object.fromEntries(
      (['vx', 'turbo', 'nx', 'vite-task'] as const).map((runner) => [
        `bench.${runner}`,
        {
          description: `compare.ts: ${runner} on the 9,603-task head-to-head → site/${runner}.json`,
          ...(runner === 'vx' ? { dependsOn: ['install'] } : {}),
          exec: {
            command: 'bun compare.ts 3',
            timeout: '30m',
            env: {
              define: {
                ...NO_TRANSPILER_CACHE.define,
                RUNNERS: runner,
                OUT: `site/${runner}.json`,
              },
              // The commit the page names; cache-invariant, as the source is the key.
              passThrough: ['GITHUB_SHA'],
            },
            // No sandbox: on Linux it traces every process the task starts,
            // and the bench starts tens of thousands. Under it vx's cold
            // overhead read 55.61 s against 7.01 s, nothing changed 2.12 s
            // against 0.60 s (2026-10-29), so the page would time the tracer.
          },
          inputs: {
            files: [...HARNESS, ...(runner === 'vx' ? ['edges.ts'] : [])],
          },
          cache: {
            outputs: { files: [`site/${runner}.json`] },
          },
        },
      ]),
    ),

    'site.numbers': {
      description: 'every runner of the head-to-head, the rows the site reads',
      dependsOn: ['bench.*'],
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
