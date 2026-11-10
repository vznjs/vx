import { defineProject } from '@vzn/vx'

// The suite was one 100 s task, the whole critical path of a run that
// touched this package (PR #4314): each heavy file is a task of its own,
// the rest one more. The rest is every file but those, so a new one is
// never left out.
const HEAVY = ['wire', 'wire-faults', 'wire-dials', 'local-e2e', 'local-e2e-saves', 'units', 'gitlab']
const rest = `$(ls tests/*.test.ts | grep -v ${HEAVY.map((f) => `-e /${f}.test.ts`).join(' ')})`

/** `bun test` over `files`, a shard of the suite. */
const testTask = (files: string) => ({
  description: `bun test ${files === rest ? 'the files no other shard runs' : files}`,
  exec: {
    // Bun's transpiler cache in the task's own TMPDIR: each vx it spawns compiled src again.
    command: `BUN_RUNTIME_TRANSPILER_CACHE_PATH="\${TMPDIR:-/tmp}/bun-transpiler" bun test --only-failures --timeout=30000 ${files}`,
    // Fixture repos assume git's defaults; a global config may sign commits.
    // Bun's transpiler cache writes under HOME, outside the sandbox's grants.
    env: {
      define: {
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        VX_CACHE_DIR: '.vx/cache',
      },
    },
    sandbox: {
      allow: {
        read: ['**/*'],
        systemInfo: ['vfs.disk-space', 'net.link.addr'],
        // `pgrep`, which the worker tests list processes with, asks it (macOS).
        machLookup: ['com.apple.sysmond'],
        localBinding: true,
      },
    },
  },
  dependsOn: ['install'] as const,
  inputs: { files: ['src/**', 'tests/**', 'package.json'] },
  outputs: { files: [] as string[] },
  cache: true,
})

export default defineProject({
  tasks: {
    install: {
      dependsOn: ['^build'],
    },

    build: {
      description: 'nothing to build — consumed as source',
      dependsOn: ['^build'],
      inputs: { files: ['src/**'] },
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
        files: [
          'src/**',
          'tests/**',
          'scripts/**',
          'package.json',
          '.oxlintrc.json',
          'tsconfig.json',
        ],
      },
      outputs: { files: [] },
      cache: true,
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
      outputs: { files: [] },
      cache: true,
    },

    test: {
      dependsOn: [
        'test.wire',
        'test.wire-faults',
        'test.wire-dials',
        'test.local-e2e',
        'test.local-e2e-saves',
        'test.units',
        'test.gitlab',
        'test.rest',
      ],
    },
    'test.wire': testTask('./tests/wire.test.ts'),
    'test.wire-faults': testTask('./tests/wire-faults.test.ts'),
    'test.wire-dials': testTask('./tests/wire-dials.test.ts'),
    'test.local-e2e': testTask('./tests/local-e2e.test.ts'),
    'test.local-e2e-saves': testTask('./tests/local-e2e-saves.test.ts'),
    'test.units': testTask('./tests/units.test.ts'),
    'test.gitlab': testTask('./tests/gitlab.test.ts'),
    'test.rest': testTask(rest),
  },
})
