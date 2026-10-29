import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    install: {
      dependsOn: ['^build'],
    },

    ci: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt', 'test', 'test.live'],
    },

    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      exec: {
        command: 'oxlint --type-aware --type-check',
        sandbox: { allow: { read: ['**/*'], systemInfo: ['vfs.disk-space'] } },
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

    // worker-url.ts: which relay and cache server a CI run uses; what
    // compose.yaml hands each server.
    test: {
      description: 'bun test',
      exec: {
        command: 'bun test --only-failures',
        // Bun's transpiler cache writes under HOME, outside the sandbox's grants.
        env: { define: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } },
        sandbox: { allow: { read: ['**/*'] } },
      },
      dependsOn: ['install'],
      inputs: { files: ['*.ts', 'tests/**', 'compose.yaml', 'package.json'] },
      cache: {
        outputs: { files: [] },
      },
    },

    // compose.yaml up, each server answering, a clean stop. No sandbox:
    // it reaches the Docker daemon.
    'test.live': {
      description: 'docker compose up, each server answering, then a clean stop',
      exec: { command: 'sh tests/smoke.sh' },
      dependsOn: ['install'],
      inputs: {
        files: ['compose.yaml', 'tests/smoke.sh'],
        workspaceFiles: [
          'packages/vx-dte-server/Dockerfile',
          'packages/vx-dte-server/package.json',
          'packages/vx-dte-server/index.ts',
          'packages/vx-dte-server/PROTOCOL.md',
          'packages/vx-dte-server/src/**',
          'packages/vx-cache-server/Dockerfile',
          'packages/vx-cache-server/src/**',
          'packages/vx-history-server/Dockerfile',
          'packages/vx-history-server/src/**',
          'packages/vx-devtools/package.json',
          'packages/vx-devtools/src/**',
        ],
      },
      cache: {
        outputs: { files: [] },
      },
    },
  },
})
