import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    install: {
      dependsOn: ['^build'],
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
        files: ['plugins/**', 'package.json', '.oxlintrc.json', 'tsconfig.json'],
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
      description: 'bun test',
      exec: {
        command: 'bun test --only-failures --timeout=30000',
        // Bun's transpiler cache writes under HOME, outside the sandbox's grants.
        env: { define: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', VX_CACHE_DIR: '.vx/cache' } },
        sandbox: {
          allow: {
            read: ['**/*'],
            systemInfo: ['vfs.disk-space', 'net.link.addr'],
            localBinding: true,
          },
        },
      },
      dependsOn: ['install'],
      inputs: { files: ['plugins/**', 'package.json'] },
      outputs: { files: [] },
      cache: true,
    },
  },
})
