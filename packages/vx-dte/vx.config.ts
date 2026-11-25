import { defineProject } from '@vzn/vx'

// The suite was one 100 s task, the whole critical path of a run that
// touched this package (PR #4314): each heavy file is a task of its own,
// the rest one more. The rest is every file but those, so a new one is
// never left out.
const HEAVY = [
  'wire',
  'wire-faults',
  'wire-dials',
  'local-e2e',
  'local-e2e-workers',
  'local-e2e-saves',
  'local-e2e-worktrees',
  'local-e2e-artifacts',
  'local-e2e-lifecycle',
  'units',
  'gitlab',
  'github',
]
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
        // As a laptop runs vx: on CI a spawned vx prints errors-only logs.
        CI: '',
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
  // init.test.ts holds the README to the code; the sim tests import scripts/.
  inputs: { files: ['src/**', 'tests/**', 'scripts/**', 'package.json', 'README.md'] },
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

    // What @vzn/vx-docs reads from this package through its node_modules
    // (the plugin pages): never run, its key reaches the site's tasks.
    site: {
      description: 'the files the site reads from this package',
      inputs: { files: ['README.md', 'package.json'] },
    },

    lint: {
      dependsOn: ['lint.*'],
    },

    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      exec: {
        command: 'oxlint --type-aware --type-check --ignore-pattern node_modules',
        sandbox: { allow: { read: ['**/*'], systemInfo: ['vfs.disk-space'] } },
      },
      dependsOn: ['install'],
      inputs: {
        files: [
          '*.ts',
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
      dependsOn: ['test.*'],
    },
    ...Object.fromEntries(HEAVY.map((f) => [`test.bun.${f}`, testTask(`./tests/${f}.test.ts`)])),
    'test.bun.rest': testTask(rest),
  },
})
