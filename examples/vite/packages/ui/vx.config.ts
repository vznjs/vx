import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    build: {
      exec: { command: 'vite build' },
      inputs: { files: ['src/**', '!src/**/*.test.ts', 'vite.config.ts'] },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
    test: {
      exec: { command: 'vitest run' },
      // vitest loads vite.config.ts: a `test` setting there changes the run.
      inputs: { files: ['src/**', 'vite.config.ts'] },
      outputs: { files: [] },
      cache: true,
    },
    lint: {
      exec: { command: 'oxlint' },
      inputs: { files: ['src/**'] },
      outputs: { files: [] },
      cache: true,
    },
  },
})
