// `@vzn/vx/oidc` for Bun's compiled binary, which ignores the exports map
// (see the root `index.ts`). It imports only jose, so a server on Workers
// bundles it without the rest of core.
export * from '../src/oidc/index.js'
