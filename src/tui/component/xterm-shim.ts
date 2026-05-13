// xterm-headless 5.x references browser `window` / `self` globals
// in its compiled bundle. They must be defined BEFORE the module is
// imported — ESM hoists `import` to the top of the file, so doing
// the shim in the same file as the import doesn't work. Importing
// this file as a side-effect first guarantees the order.

const g = globalThis as unknown as Record<string, unknown>
if (g.window === undefined) g.window = globalThis
if (g.self === undefined) g.self = globalThis
