// Publishes the shim as the bundle's `Bun`, `process` and `Buffer` (platform.ts). Its
// own module, not platform.ts's top level: a test that imports the shim's
// source would otherwise repoint the globals a loaded bundle reads through,
// and the bundle's planner then read the source shim's VFS (macOS test
// order: playground-bundle, playground-shim, playground-page).
import { buffer, bun, proc } from './platform.js'

;(globalThis as Record<string, unknown>).__vxBun = bun
;(globalThis as Record<string, unknown>).__vxProcess = proc
;(globalThis as Record<string, unknown>).__vxBuffer = buffer
