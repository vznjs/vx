// Root entry shim. Bun 1.4.0's `--compile` binaries resolve an on-disk
// package by directory convention (`<pkg>/index.ts`, `<pkg>/<subpath>/index.ts`)
// and ignore package.json `exports` / `main` (measured 2026-09-03: an
// entry of `./src/index.ts` resolved to the root `index.ts` regardless of the
// manifest, and a package with no root file was "not found"). Without this
// file every `import … from '@vzn/vx'` in a workspace config fails under the
// standalone binary. The exports map still wins everywhere else and points
// at the same module, so this is one extra hop for the binary and nothing
// for anyone else.
export * from './src/index.js'
