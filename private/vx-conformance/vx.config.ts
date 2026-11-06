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
      dependsOn: ['lint', 'test'],
    },

    // Every case against every tool: rewrites the site's conformance data.
    // On demand, not in `ci`: run it after a case or a pin changes, and
    // commit the data. No sandbox: the harness runs each tool in a
    // bubblewrap sandbox of its own, which vx's sandbox cannot nest.
    conformance: {
      description:
        'bun src/cli.ts: every case against vx, Turborepo, Nx, Vite Task, Nix and moon → vx-docs/src/data/conformance.json',
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
      inputs: { files: ['**/*'] },
      outputs: { files: [] },
      cache: true,
    },

    // The harness's own tests: the sandbox holds, the checks judge right,
    // and every test file in the repo is in the inventory.
    test: {
      description: 'bun test',
      exec: {
        command: 'bun test --only-failures --timeout=30000',
        env: { define: NO_TRANSPILER_CACHE, passThrough: ['VX_REQUIRE_SANDBOX'] },
      },
      dependsOn: ['install'],
      inputs: {
        files: [...SUITE, 'tests/**'],
        // The inventory test lists every package's test files.
        workspaceFiles: ['packages/*/tests/*.test.ts'],
      },
      outputs: { files: [] },
      cache: true,
    },
  },
})
