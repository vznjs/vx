/**
 * The plugin packages compiled into the standalone binary, by specifier
 * (`core-alias.ts`'s `registerBakedPlugins`). Empty in source: core never
 * imports a sibling package; scripts/compile.ts replaces this module's
 * text with the table when it compiles.
 */
export const BAKED_PLUGINS: Readonly<Record<string, () => Promise<Record<string, unknown>>>> = {}
