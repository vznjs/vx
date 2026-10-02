import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cp src/*.js dist/' },
      cache: {
        inputs: { files: ['src/**'] },
        outputs: { files: ['dist/**'] },
      },
    },
  },
})
