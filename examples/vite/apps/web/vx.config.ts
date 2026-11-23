import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    build: {
      // `^build`: ui's build runs first, so `import 'ui'` finds ui/dist.
      dependsOn: ['^build'],
      exec: { command: 'vite build' },
      inputs: { files: ['src/**', '!src/**/*.test.ts', 'index.html'] },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
    test: {
      dependsOn: ['^build'],
      exec: { command: 'vitest run' },
      inputs: { files: ['src/**'] },
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
