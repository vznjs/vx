// Module contract. Cross-module imports must come through here; see
// docs/design/module-isolation-2026-06.md and tests/module-boundaries.test.ts.

export { UserError } from './errors.js'
export { xxh3, xxh3hex } from './hash.js'
export { mark, printTimings, span } from './timing.js'
export { clampInt, MAX_TIMEOUT_MS, parseDecimalInt } from './num.js'
export { relPosix, staticPrefix } from './paths.js'
export { settleWithin, teardownTimeoutMs } from './settle.js'
export { parseSize } from './size.js'
export {
  appendTail,
  createTail,
  PERSISTENT_TAIL_CHARS,
  resetTail,
  tailText,
  type Tail,
} from './tail.js'
export { ulid } from './ulid.js'
