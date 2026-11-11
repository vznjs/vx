import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    test: {
      exec: { command: 'node test.js' },
      inputs: { files: ['**/*'] },
      outputs: { files: [] },
      cache: true,
    },
  },
})
