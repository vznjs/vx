import { defineProject } from './src/index.ts'

export default defineProject({
  tasks: {
    lint: {
      description: 'oxlint with tsgolint-backed type-aware checks',
      exec: { command: 'oxlint --type-aware --type-check' },
      cache: {
        inputs: { files: ['src/**', 'tests/**', '.oxlintrc.json', 'tsconfig.json'] },
        outputs: { files: [] },
      },
    },

    'format-check': {
      description: 'oxfmt --check (no rewrite; CI-safe)',
      exec: { command: 'oxfmt --check .' },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: [] },
      },
    },

    // Mutates files in place — no cache (cache hit would skip the rewrite).
    format: {
      description: 'oxfmt . — rewrite formatting in place',
      exec: { command: 'oxfmt .' },
    },

    test: {
      description: 'bun test against the tests/ tree',
      exec: { command: 'bun test' },
      cache: {
        inputs: { files: ['src/**', 'tests/**', 'package.json'] },
        outputs: { files: [] },
      },
    },

    // Umbrella task for CI. Group task: no exec, just chains deps.
    ci: {
      description: 'format-check + lint + test (CI gate)',
      dependsOn: ['format-check', 'lint', 'test'],
    },
  },
})
