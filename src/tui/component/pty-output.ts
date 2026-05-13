// Per-task pseudo-terminal — same idea as Turbo's `term_output.rs`
// (which wraps `turborepo-vt100`). We feed stdout/stderr chunks to
// an `xterm-headless` Terminal, then read its screen buffer to
// render. The VT emulator handles `\r`, ANSI cursor moves, line
// clears, etc.

import './xterm-shim.ts'
import type { Terminal as XTerm } from 'xterm-headless'

// xterm-headless references browser `window`/`self` globals at
// module-load time. The shim above must run BEFORE we touch the
// xterm-headless module — under Bun's ESM, static imports from
// node_modules are evaluated before our same-file static imports,
// so we use `require()` (Bun maps it to its CJS shim) instead. By
// this point, the shim's side effects have run.
let TerminalCtor: typeof XTerm | null = null
function getTerminalCtor(): typeof XTerm {
  if (!TerminalCtor) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('xterm-headless') as { Terminal: typeof XTerm }
    TerminalCtor = mod.Terminal
  }
  return TerminalCtor
}

export interface PtyOutput {
  write(chunk: string): void
  resize(cols: number, rows: number): void
  readLines(): string[]
  /** Monotonic byte counter — bumps on every write. */
  readonly bytesWritten: number
  dispose(): void
}

export function createPtyOutput(initialCols = 200, initialRows = 1000): PtyOutput {
  const Terminal = getTerminalCtor()
  const term = new Terminal({
    cols: Math.max(1, initialCols),
    rows: Math.max(1, initialRows),
    scrollback: 5000,
    convertEol: true,
    allowProposedApi: true,
  })

  let bytesWritten = 0
  let lastReadAt = -1
  let cachedLines: string[] = []

  return {
    write(chunk: string) {
      term.write(chunk)
      bytesWritten += chunk.length
    },
    resize(cols: number, rows: number) {
      term.resize(Math.max(1, cols), Math.max(1, rows))
      lastReadAt = -1
    },
    readLines() {
      if (lastReadAt === bytesWritten) return cachedLines
      const out: string[] = []
      const total = term.buffer.active.length
      const viewportRows = term.rows
      const start = Math.max(0, total - viewportRows)
      for (let y = start; y < total; y++) {
        const line = term.buffer.active.getLine(y)
        out.push(line ? line.translateToString(true) : '')
      }
      cachedLines = out
      lastReadAt = bytesWritten
      return out
    },
    get bytesWritten() {
      return bytesWritten
    },
    dispose() {
      term.dispose()
    },
  }
}
