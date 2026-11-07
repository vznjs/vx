import { defineProject } from '@vzn/vx'

// The suite as one task took 78 s on a DTE worker, past every core shard,
// so it set the run's tail. Three tasks, the files dealt by measured weight
// (`bun test <file>` alone, 2026-11-07: 31 s in all; file-dir-dep 7.8 s,
// outside-dir-dep 4.0 s and pnpm 3.5 s the heaviest, mostly the vx CLI an
// `--affected` row spawns). A new file goes in the lightest shard;
// suite-coverage fails on a file no shard names.
const SHARDS: readonly (readonly string[])[] = [
  [
    'dependency-names',
    'extra-in-project',
    'file-dir-dep',
    'link-to-workspace',
    'lockfile-shapes',
    'npm',
    'pnpm-workspace-precise',
    'rehoist-identity',
    'yarn-package-settings',
  ],
  [
    'bun-patch-precise',
    'closure-per-project',
    'deleted-project',
    'lazy-load',
    'lockfile-choice',
    'outside-dir-dep',
    'overrides-precise',
    'pnpm-exclude-links',
    'pnpm-ignored-optional',
    'pnpm-injected-workspace',
    'refusal-message',
    'unknown-options',
    'yarn-classic-link-workspace',
    'yarn-package-extensions',
    'yarn-transparent-workspaces',
    'yarn',
  ],
  [
    'bun-catalog-precise',
    'bun',
    'discover-parity',
    'discover',
    'entry-shapes',
    'io-refusals',
    'link-outside-root',
    'memo-identity',
    'npm-nested-workspace',
    'pnpm-manifest-files',
    'pnpm',
    'root-workspace-dep',
    'settings',
    'yarn-bound-descriptor',
    'yarn-numeric-range',
  ],
]

const shard = (i: number, files: readonly string[]) => ({
  description: `bun test, shard ${i} of ${SHARDS.length}`,
  exec: {
    command: `bun test --only-failures --timeout=30000 ${files.map((f) => `tests/${f}.test.ts`).join(' ')}`,
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
        localBinding: true,
      },
    },
  },
  dependsOn: ['install'],
  inputs: { files: ['src/**', 'tests/**', 'package.json'] },
  outputs: { files: [] as string[] },
  cache: true,
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
      dependsOn: ['test.shard-*'],
    },

    ...Object.fromEntries(SHARDS.map((files, k) => [`test.shard-${k + 1}`, shard(k + 1, files)])),
  },
})
