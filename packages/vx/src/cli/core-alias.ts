import path from 'node:path'

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

/** Where a baked plugin's transformed `import.meta` reads its origin (scripts/compile.ts). */
const BAKED_ORIGIN = Symbol.for('vx.baked-origin')

/**
 * Plugin packages compiled into the binary (`baked.ts`, filled by
 * scripts/compile.ts), served from the binary's own bytecode instead of
 * resolved, read and transpiled from `node_modules` per process: 5
 * packages, `vx show` 37 → 31 ms (2026-10-06).
 *
 * Only when the installed package is the one baked: resolved from the
 * working directory as an import would be, and its `version` equal to
 * this binary's (the plugins ship on vx's release train, so equal
 * versions are equal sources). Any other version loads from disk as
 * before, and a package that is not installed fails to resolve as
 * before. Like the core alias, a specifier is one module per process.
 *
 * A baked plugin's `definePlugin(import.meta, …)` is rewritten at compile
 * time to read its origin here: the installed package's directory, so its
 * name is read from the installed `package.json`, as it is from disk.
 */
export function registerBakedPlugins(
  baked: Readonly<Record<string, () => Promise<Record<string, unknown>>>>,
  version: string,
): void {
  const specifiers = Object.keys(baked)
  if (specifiers.length === 0) return
  const origins = new Map<string, { dir: string }>()
  ;(globalThis as Record<symbol, unknown>)[BAKED_ORIGIN] = origins
  Bun.plugin({
    name: 'vx-baked-plugins',
    setup(build) {
      for (const specifier of specifiers) {
        build.module(specifier, async () => {
          const entry = Bun.resolveSync(specifier, process.cwd())
          const dir = path.dirname(entry)
          const { pluginPackage } = await import('../orchestrator/index.js')
          if (pluginPackage(dir).version !== version) {
            return { exports: (await import(entry)) as Record<string, unknown>, loader: 'object' }
          }
          origins.set(specifier, { dir })
          return { exports: await baked[specifier]!(), loader: 'object' }
        })
      }
    },
  })
}
