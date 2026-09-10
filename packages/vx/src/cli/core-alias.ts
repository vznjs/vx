/**
 * One core per process. A plugin package, a `vx.workspace.ts`, a
 * `vx.config.ts` all `import … from '@vzn/vx'`, and that specifier
 * resolves through node_modules — to a SECOND copy of core when the host
 * is the compiled binary (whose own copy lives under the bunfs root) or
 * an install with its own nested `@vzn/vx`. The second copy is core's
 * whole source transpiled again, per process: ~20 ms per plugin package
 * in the binary (measured 2026-09-10, `@vzn/vx-otel`: 20–25 ms → 2–3 ms),
 * and two module states — two `definePlugin` memos, two of everything
 * keyed by identity rather than by registry symbol.
 *
 * The alias is a Bun virtual module for the exact specifier `@vzn/vx`,
 * served from the host's own façade, loaded lazily on the first import
 * so a verb that never loads a plugin never loads the façade. The
 * source form (`bun src/bin.ts`) resolves the specifier to the same file
 * anyway; the alias makes that a guarantee rather than a layout fact.
 */
export function registerCoreAlias(load: () => Promise<Record<string, unknown>>): void {
  Bun.plugin({
    name: 'vx-core-alias',
    setup(build) {
      build.module('@vzn/vx', async () => ({ exports: await load(), loader: 'object' }))
    },
  })
}
