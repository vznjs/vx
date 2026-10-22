// The sandbox runtime as an entry of its own in the compiled binary
// (`build.bun.*` compiles it beside src/bin.ts): bundled into the main
// entry, its ~600 KB of bytecode, zod and node-forge with it, loaded on
// every boot whether a task ran sandboxed or not (~2.6 ms of a warm no-op,
// 2026-10-22).
export * from '@anthropic-ai/sandbox-runtime'
