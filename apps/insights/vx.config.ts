import { defineProject } from '../../src/index.ts'

export default defineProject({
  tasks: {
    build: {
      description: 'vite build → dist/',
      exec: { command: 'vite build' },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: ['dist/**'] },
      },
    },

    dev: {
      description: 'vite dev server (persistent)',
      exec: {
        command: 'vite',
        persistent: { readyWhen: 'Local' },
        timeout: 120000,
      },
    },

    preview: {
      description: 'serve the built dist/ (persistent)',
      dependsOn: ['build'],
      exec: {
        command: 'vite preview',
        persistent: { readyWhen: 'Local' },
        timeout: 120000,
      },
    },
  },
})
