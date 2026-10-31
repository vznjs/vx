import { defineProject } from '@vzn/vx'

// Fixture repos assume git's defaults; a global config may sign commits.
// FORCE_COLOR=0: the suite reads vx's and its tasks' output as text.
// Bun's transpiler cache writes under HOME, outside the sandbox's grants.
const SUITE_ENV = {
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  FORCE_COLOR: '0',
  VX_CACHE_DIR: '.vx/cache',
}

const SUITE_SANDBOX = {
  allow: {
    read: ['**/*'],
    systemInfo: ['vfs.disk-space', 'net.link.addr'],
    localBinding: true,
  },
  // remote-cache-degrade.test.ts dials a host that does not
  // resolve on purpose; the proxy refuses it, and that is the row.
  ignore: { network: ['no-such-host.invalid:80'] },
}

const TEST_SHARDS = 4

const testShard = (i: number) => ({
  description: `bun test, shard ${i} of ${TEST_SHARDS}`,
  exec: {
    command: `bun test --only-failures --shard=${i}/${TEST_SHARDS} --timings=tests/timings.json`,
    // `nx-exec-live.test.ts` runs the bin against REAL Nx when
    // VX_NX_MODULES names an install (CI puts one under `.nx-live/`,
    // inside this project, so the sandbox's read grant covers it) and
    // fails instead of skipping under VX_REQUIRE_NX. Both are key
    // inputs: a skip-mode hit must never answer for the live run.
    // VX_REQUIRE_REFTABLE: head-stamp-reftable.test.ts fails on a git
    // too old for reftable instead of skipping; VX_REQUIRE_NONROOT:
    // packages-foreign-owner.test.ts fails as root instead of skipping.
    env: {
      passThrough: ['VX_NX_MODULES', 'VX_REQUIRE_NX', 'VX_REQUIRE_REFTABLE', 'VX_REQUIRE_NONROOT'],
      define: SUITE_ENV,
    },
    sandbox: SUITE_SANDBOX,
  },
  dependsOn: ['install'],
  inputs: {
    files: ['src/**', 'tests/**', 'package.json'],
    env: ['VX_NX_MODULES', 'VX_REQUIRE_NX', 'VX_REQUIRE_REFTABLE', 'VX_REQUIRE_NONROOT'],
  },
  cache: {
    outputs: { files: [] },
  },
})

export default defineProject({
  tasks: {
    install: {
      dependsOn: ['^build'],
    },

    // Consumed as source by the packages that depend on this one: `build`
    // keys that source and runs nothing, so their `install` (which folds
    // `^build`) re-keys on an edit here (item 687).
    build: {
      description: 'nothing to build — consumed as source',
      dependsOn: ['^build'],
      inputs: { files: ['src/**'] },
    },

    ci: {
      dependsOn: ['lint', 'test', 'test.live'],
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      exec: {
        command: 'oxlint --type-aware --type-check',
        sandbox: { allow: { read: ['**/*'], systemInfo: ['vfs.disk-space'] } },
      },
      dependsOn: ['install'],
      inputs: {
        files: ['src/**', 'tests/**', 'package.json', '.oxlintrc.json', 'tsconfig.json'],
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

    // One process was a distributed run's critical path (188 s of 206 s,
    // main 2026-10-23): Bun deals the files by tests/timings.json, which
    // `bun test --timings=tests/timings.json --update-timings` refreshes.
    test: {
      dependsOn: ['test.shard-*'],
    },

    ...Object.fromEntries(
      Array.from({ length: TEST_SHARDS }, (_, i) => [`test.shard-${i + 1}`, testShard(i + 1)]),
    ),

    // Only the `*-live.test.ts` files, against the Nx `nx.install` puts in
    // `.nx-live`; `test` runs every file, these in skip mode. No cache: the
    // install is an unpinned `nx@22` the key cannot see.
    'test.live': {
      description: 'bun test, the live Nx files, against the install in .nx-live',
      exec: {
        command: 'bun test --only-failures ./tests/*-live.test.ts',
        env: {
          define: {
            ...SUITE_ENV,
            VX_NX_MODULES: '.nx-live',
            VX_REQUIRE_NX: '1',
          },
        },
        sandbox: SUITE_SANDBOX,
      },
      dependsOn: ['install', 'nx.install'],
    },

    // Real Nx inside the package (gitignored), where test.live's read grant
    // covers it. Persistent, so a distributed run installs it on the agent
    // that runs test.live; it is ready when it exits. No sandbox: it
    // downloads from the npm registry. Bun's install, not npm's: 21 s
    // against 4 s, on the critical path of every main run (2026-10-24),
    // the live files passing on both.
    'nx.install': {
      description: 'bun add nx@22 into .nx-live',
      exec: {
        command:
          'mkdir -p .nx-live && cd .nx-live && { [ -f package.json ] || echo \'{"private":true}\' > package.json; } && bun add nx@22 @nx/js@22 typescript@5 && echo installed',
        persistent: { readyWhen: '^installed$' },
        timeout: '5m',
      },
    },
  },
})
