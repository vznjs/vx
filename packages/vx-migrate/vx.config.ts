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

export default defineProject({
  tasks: {
    install: {
      dependsOn: ['^build'],
    },

    // Consumed as source by the packages that depend on this one, so
    // `build` carries the source's key and their `install` (which folds
    // `^build`) re-keys on an edit here (item 687).
    build: {
      description: 'nothing to build — consumed as source',
      dependsOn: ['^build', 'source'],
    },

    source: {
      description: 'the source dependants import: a key, not a build',
      exec: { command: 'true', sandbox: { allow: { read: [] } } },
      inputs: { files: ['src/**'] },
      cache: { outputs: { files: [] } },
    },

    ci: {
      dependsOn: ['lint', 'test'],
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

    test: {
      description: 'bun test',
      exec: {
        command: 'bun test --only-failures',
        // `nx-exec-live.test.ts` runs the bin against REAL Nx when
        // VX_NX_MODULES names an install (CI puts one under `.nx-live/`,
        // inside this project, so the sandbox's read grant covers it) and
        // fails instead of skipping under VX_REQUIRE_NX. Both are key
        // inputs: a skip-mode hit must never answer for the live run.
        // VX_REQUIRE_REFTABLE: head-stamp-reftable.test.ts fails on a git
        // too old for reftable instead of skipping; VX_REQUIRE_NONROOT:
        // packages-foreign-owner.test.ts fails as root instead of skipping.
        env: {
          passThrough: [
            'VX_NX_MODULES',
            'VX_REQUIRE_NX',
            'VX_REQUIRE_REFTABLE',
            'VX_REQUIRE_NONROOT',
          ],
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
    },

    // Only the `*-live.test.ts` files, for CI's job that installs real Nx;
    // `test` runs every file, these in skip mode. No cache: the install is
    // an unpinned `nx@22` the key cannot see.
    'test.live': {
      description: 'bun test, the live Nx files (VX_NX_MODULES names an install)',
      exec: {
        command: 'bun test --only-failures ./tests/*-live.test.ts',
        env: { passThrough: ['VX_NX_MODULES', 'VX_REQUIRE_NX'], define: SUITE_ENV },
        sandbox: SUITE_SANDBOX,
      },
      dependsOn: ['install'],
    },
  },
})
