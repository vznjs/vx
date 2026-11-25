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
      // `^build`: every dependency's build runs first, so lib/dist exists.
      // The bundler reaches lib by its package name, through node_modules.
      dependsOn: ['^build'],
      exec: { command: 'bun build src/main.js --outfile dist/app.js' },
      inputs: { files: ['src/**'] },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
    test: {
      dependsOn: ['build'],
      exec: { command: 'sh tests/main.sh' },
      inputs: { files: ['tests/**'] },
      outputs: { files: [] },
      cache: true,
    },
  },
})
