import { defineProject } from '@vzn/vx'

// Bun's transpiler cache writes under HOME, outside the sandbox's grants.
const NO_TRANSPILER_CACHE = { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }

// What a conformance outcome depends on besides the tool under test.
const SUITE = ['src/**', 'cases/**', 'package.json']

export default defineProject({
  tasks: {
    install: {
      dependsOn: ['^build'],
    },

    ci: {
      dependsOn: ['lint', 'test', 'check.conformance'],
    },

    // vx's outcome on every case, against the committed report: a case vx
    // passed and now fails is a regression, a new pass is recorded with
    // `conformance`. The rivals' outcomes move only with their pins.
    // No sandbox: the harness runs each tool in a bubblewrap sandbox of its
    // own, which vx's sandbox cannot nest.
    'check.conformance': {
      description:
        'bun src/cli.ts --check vx: every case against vx, as report/results.json records',
      dependsOn: ['install'],
      exec: {
        command: 'bun src/cli.ts --check vx',
        timeout: '10m',
        env: { define: NO_TRANSPILER_CACHE },
      },
      inputs: { files: [...SUITE, 'report/results.json'] },
      cache: { outputs: { files: [] } },
    },

    // Every case against every tool: rewrites report/. Run it after a case
    // or a pin changes, and commit the report.
    conformance: {
      description: 'bun src/cli.ts: every case against vx, Turborepo, Nx and Vite Task → report/',
      dependsOn: ['install'],
      exec: {
        command: 'bun src/cli.ts',
        timeout: '30m',
        env: { define: NO_TRANSPILER_CACHE },
      },
      inputs: { files: SUITE },
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
      inputs: { files: [...SUITE, 'tests/**', '*.ts', '.oxlintrc.json', 'tsconfig.json'] },
      cache: { outputs: { files: [] } },
    },

    'lint.oxfmt': {
      description: 'oxfmt --check (no rewrite; CI-safe)',
      exec: {
        command: 'oxfmt --check .',
        sandbox: { allow: { read: ['**/*'], systemInfo: ['vfs.disk-space'] } },
      },
      dependsOn: ['install'],
      inputs: { files: ['**/*'] },
      cache: { outputs: { files: [] } },
    },

    // The harness's own tests: the sandbox holds, the checks judge right,
    // and every test file in the repo is in the inventory.
    test: {
      description: 'bun test',
      exec: {
        command: 'bun test --only-failures',
        env: { define: NO_TRANSPILER_CACHE, passThrough: ['VX_REQUIRE_SANDBOX'] },
      },
      dependsOn: ['install'],
      inputs: {
        files: [...SUITE, 'tests/**'],
        // The inventory test lists every package's test files.
        workspaceFiles: ['packages/*/tests/*.test.ts'],
      },
      cache: { outputs: { files: [] } },
    },
  },
})
