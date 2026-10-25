import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    install: {
      dependsOn: ['^build'],
    },

    ci: {
      dependsOn: ['lint.oxfmt', 'test.live'],
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

    // compose.yaml up, each server answering, a clean stop. No sandbox:
    // it reaches the Docker daemon.
    'test.live': {
      description: 'docker compose up, each server answering, then a clean stop',
      exec: { command: 'sh tests/smoke.sh' },
      dependsOn: ['install'],
      inputs: {
        files: ['compose.yaml', 'tests/**'],
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
