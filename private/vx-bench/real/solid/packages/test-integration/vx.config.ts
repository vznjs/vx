import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    test: {
      dependsOn: ['solid-js#build', 'solid-js#link'],
      exec: { command: 'node test-imports.mjs' },
      inputs: { files: ['**/*'] },
      outputs: { files: [] },
      cache: true,
    },
  },
})
