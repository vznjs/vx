import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    build: {
      // `^build`: every dependency's build runs first, so lib/dist exists.
      dependsOn: ['^build'],
      exec: { command: 'mkdir -p dist && cat ../lib/dist/*.js src/main.js > dist/app.js' },
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
    // A task with no command is a group: `vx run ci` runs what it depends on.
    ci: { dependsOn: ['build', 'test'] },
  },
})
