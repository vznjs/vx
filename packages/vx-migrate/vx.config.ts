import { defineProject } from '@vzn/vx'

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
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
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
      cache: {
        inputs: {
          files: ['src/**', 'tests/**', 'package.json', '.oxlintrc.json', 'tsconfig.json'],
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
        // `nx-exec-live.test.ts` runs the bin against REAL Nx when
        // VX_NX_MODULES names an install (CI puts one under `.nx-live/`,
        // inside this project, so the sandbox's read grant covers it) and
        // fails instead of skipping under VX_REQUIRE_NX. Both are key
        // inputs: a skip-mode hit must never answer for the live run.
        // VX_REQUIRE_REFTABLE: head-stamp-reftable.test.ts fails on a git
        // too old for reftable instead of skipping.
        env: { passThrough: ['VX_NX_MODULES', 'VX_REQUIRE_NX', 'VX_REQUIRE_REFTABLE'] },
        sandbox: {
          allow: {
            read: ['**/*'],
            systemInfo: ['vfs.disk-space', 'net.link.addr'],
            localBinding: true,
          },
          // remote-cache-degrade.test.ts dials a host that does not
          // resolve on purpose; the proxy refuses it, and that is the row.
          ignore: { network: ['no-such-host.invalid:80'] },
        },
      },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: ['src/**', 'tests/**', 'package.json'],
          env: ['VX_NX_MODULES', 'VX_REQUIRE_NX', 'VX_REQUIRE_REFTABLE'],
        },
        outputs: { files: [] },
      },
    },
  },
})
