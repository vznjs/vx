import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    lint: {
      exec: { command: 'grep -q . src/*.js' },
      inputs: { files: ['src/**'] },
      outputs: { files: [] },
      cache: true,
    },
    build: {
      exec: { command: 'mkdir -p dist && cp src/*.js dist/' },
      inputs: { files: ['src/**'] },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
  },
})
