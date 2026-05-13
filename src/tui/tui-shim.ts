// Single import site for OpenTUI. The rest of the TUI imports from
// this shim so the underlying renderer is swappable (Ink-backed
// fallback, hand-roll, test stub) without touching components.
//
// Compile-gate caveat: `@opentui/core` ships a native lib loaded via
// `bun:ffi`. The shim leaves that to OpenTUI's own loader; the
// `bun build --compile` story is documented in docs/design/tui-design.md §2.

export { createCliRenderer, type CliRenderer } from '@opentui/core'
export type { KeyEvent } from '@opentui/core'
export { createRoot, type Root, useKeyboard, useTerminalDimensions } from '@opentui/react'
