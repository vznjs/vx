import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    build: {
      // `^build`: format's default build, keyed on its files.
      dependsOn: ['^build'],
      exec: { command: 'next build', env: { define: { NEXT_TELEMETRY_DISABLED: '1' } } },
      inputs: { files: ['app/**', 'next.config.js'] },
      outputs: { files: ['.next/**', '!.next/cache/**'] },
      cache: true,
    },
    lint: {
      exec: { command: 'oxlint' },
      inputs: { files: ['app/**'] },
      outputs: { files: [] },
      cache: true,
    },
  },
})
