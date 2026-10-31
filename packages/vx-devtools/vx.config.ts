import { defineProject } from '@vzn/vx'

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
        files: ['src/**', 'tests/**', 'package.json', '.oxlintrc.json', 'tsconfig.json'],
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

    test: {
      description: 'bun test',
      exec: {
        command: 'bun test --only-failures',
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
      cache: {
        outputs: { files: [] },
      },
    },
  },
})
