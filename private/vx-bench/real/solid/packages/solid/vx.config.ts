import { defineProject } from '@vzn/vx/config'

// turbo.json's solid-js tasks. Turbo declares `dist/**` and `types/**`
// (and `**/` of each); each is written under the eight entry points, so
// each is named. `types` also copies two ignored `jsx.d.ts` into sources;
// turbo.json declares neither, so neither tool restores them.
const ENTRIES = [
  '',
  'store/',
  'web/',
  'web/storage/',
  'h/',
  'h/jsx-runtime/',
  'html/',
  'universal/',
]

// Git leaves out what the tasks write (all of it is ignored); the package
// tsconfigs extend the root's.
const SOURCES = { files: ['**/*'], workspaceFiles: ['tsconfig.json'] }

const DOM = '../../node_modules/dom-expressions'
// The `types:*` scripts `npm-run-all -nl types:*` runs, in order, as one
// command. Run by vx, npm-run-all finds no `npm_execpath` and starts each
// step through npm: `types` took 40.6 s that way, 31.0 s as one command
// (2026-11-10). The `rimraf` steps go: vx clears a task's declared
// outputs before it runs.
const TYPES = [
  `ncp ${DOM}/src/jsx.d.ts ./src/jsx.d.ts`,
  `ncp ${DOM}/src/jsx-h.d.ts ./h/jsx-runtime/src/jsx.d.ts`,
  'tsc --project ./tsconfig.build.json',
  `ncp ${DOM}/src/jsx.d.ts ./types/jsx.d.ts`,
  'tsc --project ./web/tsconfig.build.json',
  'tsc --project ./web/storage/tsconfig.build.json',
  `ncp ${DOM}/src/client.d.ts ./web/types/client.d.ts`,
  `ncp ${DOM}/src/server.d.ts ./web/types/server.d.ts`,
  'tsc --project ./store/tsconfig.build.json',
  'tsc --project ./html/tsconfig.json',
  'ncp ../../node_modules/lit-dom-expressions/types/index.d.ts ./html/types/lit.d.ts',
  'tsc --project ./h/tsconfig.json',
  'ncp ../../node_modules/hyper-dom-expressions/types/index.d.ts ./h/types/hyperscript.d.ts',
  'tsc --project ./h/jsx-runtime/tsconfig.json',
  `ncp ${DOM}/src/jsx-h.d.ts ./h/jsx-runtime/types/jsx.d.ts`,
  'tsc --project ./universal/tsconfig.json',
  `ncp ${DOM}/src/universal.d.ts ./universal/types/universal.d.ts`,
]

export default defineProject({
  tasks: {
    // `build:clean && build:js`; vx clears the outputs itself.
    build: {
      exec: { command: 'rollup -c' },
      inputs: SOURCES,
      outputs: { files: ENTRIES.map((e) => `${e}dist/**`) },
      cache: true,
    },
    types: {
      exec: { command: TYPES.join(' && ') },
      inputs: SOURCES,
      outputs: { files: ENTRIES.map((e) => `${e}types/**`) },
      cache: true,
    },
    // `node_modules/solid-js` → the package itself, for the packages that
    // import it by name. Cached with no outputs, as turbo.json has it: the
    // link lives in node_modules, which no arm wipes. An uncached task
    // would re-key every dependant on every run.
    link: {
      exec: { command: 'symlink-dir . node_modules/solid-js' },
      inputs: { files: ['package.json'] },
      outputs: { files: [] },
      cache: true,
    },
    test: {
      exec: { command: 'vitest run && vitest run --config vitest.server.config.mjs' },
      inputs: SOURCES,
      outputs: { files: [] },
      cache: true,
    },
    'test-types': {
      dependsOn: ['types'],
      exec: { command: 'tsc --project tsconfig.test.json' },
      inputs: SOURCES,
      outputs: { files: [] },
      cache: true,
    },
    coverage: {
      exec: { command: 'vitest run --coverage' },
      inputs: SOURCES,
      outputs: { files: ['coverage/**'] },
      cache: true,
    },
  },
})
