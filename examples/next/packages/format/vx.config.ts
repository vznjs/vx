import { defineProject } from '@vzn/vx/config'

// No build: Next compiles this package from source. vx gives it a
// default `build` keyed on all its files, so site's `^build` still sees
// an edit here.
export default defineProject({
  tasks: {
    test: {
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
