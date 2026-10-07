// Root entry shim: Bun 1.4.0's `--compile` binaries resolve an on-disk
// package by `<pkg>/index.ts` and ignore package.json `exports` / `main`
// (see packages/vx/index.ts). Same module as the exports map names.
export * from './src/index.js'
