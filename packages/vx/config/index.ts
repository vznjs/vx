// `@vzn/vx/config` for Bun's compiled binary, which ignores the exports
// map (see the root `index.ts`). The schema alone: a `vx.config.ts` type
// import of it never pulls core's Bun-only sources into a user's `tsc`.
export * from '../src/config.js'
