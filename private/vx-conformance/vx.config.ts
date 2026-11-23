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

    conformance: {
      dependsOn: ['conformance.cases'],
    },

    // Every case against every tool: rewrites the site's conformance data.
    // In no pipeline: weekly on its own runner (conformance.yml), and after a
    // case changes. The rivals install at npm's latest inside the run
    // (src/tools.ts), which no key sees. No sandbox: the harness runs each
    // tool in a bubblewrap sandbox of its own, which vx's sandbox cannot
    // nest, and the install needs the registry.
    'conformance.cases': {
      description:
        'bun src/cli.ts: every case against vx, Turborepo, Nx, Vite Task, Nix and moon → vx-docs/src/data/conformance.json',
      dependsOn: ['install'],
      exec: {
        command: 'bun src/cli.ts',
        // One CI shard (conformance.yml) takes about 90 s. The whole suite
        // in one run takes ~2 h of CPU: run it sharded, or `bun src/cli.ts`.
        timeout: '5m',
        env: { define: NO_TRANSPILER_CACHE },
      },
      inputs: { files: SUITE },
    },

    // A sharded run's results (conformance.yml: one job per tool and share
    // of the cases, each `conformance.cases -- --tool <t> --shard <i>/<n>`), joined.
    'conformance.cases.merge': {
      description: 'bun src/merge.ts: the shards in shards/ → conformance.json',
      dependsOn: ['install'],
      exec: {
        command: 'bun src/merge.ts conformance.json shards/*/shard.json',
        env: { define: NO_TRANSPILER_CACHE },
        sandbox: { allow: { read: ['**/*'], write: ['conformance.json'] } },
      },
      inputs: { files: [...SUITE, 'shards/**'] },
      outputs: { files: ['conformance.json'] },
    },

    lint: {
      dependsOn: ['lint.*'],
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
      dependsOn: ['test.*'],
    },

    'test.bun': {
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
