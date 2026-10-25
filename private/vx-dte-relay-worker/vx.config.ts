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
        files: ['*.ts', 'src/**', 'tests/**', 'package.json', '.oxlintrc.json', 'tsconfig.json'],
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

    // preview.ts: which relay a PR's DTE run uses.
    test: {
      description: 'bun test',
      exec: {
        command: 'bun test --only-failures',
        // Bun's transpiler cache writes under HOME, outside the sandbox's grants.
        env: { define: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } },
        sandbox: { allow: { read: ['**/*'] } },
      },
      dependsOn: ['install'],
      inputs: { files: ['*.ts', 'tests/**', 'README.md', 'wrangler.jsonc', 'package.json'] },
      cache: {
        outputs: { files: [] },
      },
    },
  },
})
