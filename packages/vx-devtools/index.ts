// Root entry shim: Bun's `--compile` binaries resolve an on-disk package
// by `<pkg>/index.ts` and ignore package.json `exports` / `main` (see
// packages/vx/index.ts). Same module as the exports map names.
export * from './src/index.js'
