import { defineProject } from './src/index.ts'

export default defineProject({
  tasks: {
    lint: {
      exec: { command: 'oxlint --type-aware --type-check' },
      cache: {
        inputs: { files: ['src/**', 'tests/**', '.oxlintrc.json', 'tsconfig.json'] },
        outputs: { files: [] },
      },
    },

    'format-check': {
      exec: { command: 'oxfmt --check .' },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: [] },
      },
    },

    // Mutates files in place — no cache (cache hit would skip the rewrite).
    format: {
      exec: { command: 'oxfmt .' },
    },

    test: {
      exec: { command: 'bun test' },
      cache: {
        inputs: { files: ['src/**', 'tests/**', 'package.json'] },
        outputs: { files: [] },
      },
    },

    // Umbrella task for CI. Group task: no exec, just chains deps.
    ci: {
      dependsOn: { self: ['format-check', 'lint', 'test'] },
    },
  },
})
