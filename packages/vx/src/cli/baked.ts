/**
 * The first-party plugins the compiled binary carries, by the specifier a
 * workspace imports them from (`core-alias.ts`'s `registerBakedPlugins`).
 * `bun build --compile` bundles what this file reaches, so they are in the
 * binary; `plugins/index.ts` re-exports them.
 *
 * `require`, not `import()`: the bundler follows both, the type checker
 * only the import, and a plugin package's type-aware lint then met core's
 * sources twice through its `node_modules/@vzn/vx` link and panicked.
 */
export const BAKED_PLUGINS: Readonly<Record<string, () => Promise<Record<string, unknown>>>> = {
  '@vzn/vx/plugins': async () => require('../../plugins/index.ts') as Record<string, unknown>,
}
