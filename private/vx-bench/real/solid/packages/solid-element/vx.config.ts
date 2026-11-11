import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    // turbo.json's `solid-element#build`: tsc against solid-js's types,
    // reached through the link. Turbo declares no outputs and caches the
    // log only, so a restore leaves `dist` missing; vx declares none
    // either, so both tools restore the same files. Its script's
    // `pnpm run clean` goes: tsc overwrites `dist`.
    build: {
      dependsOn: ['solid-js#types', 'solid-js#link'],
      exec: { command: 'tsc' },
      inputs: { files: ['**/*'], workspaceFiles: ['tsconfig.json'] },
      outputs: { files: [] },
      cache: true,
    },
  },
})
