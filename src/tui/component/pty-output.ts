// Per-task pseudo-terminal — same idea as Turbo's `term_output.rs`
// (which wraps `turborepo-vt100`). We feed stdout/stderr chunks
// to an `xterm-headless` Terminal, then read its screen buffer to
// render. This is what makes complex output (npm progress bars,
// esbuild spinners, `\r`-overwrites, ANSI cursor escapes) render
// correctly — we're not split-on-newline-ing strings any more;
// we're driving a real VT emulator.
//
// xterm-headless 5.x still references the browser `window` / `self`
// globals in its compiled bundle even though it's the "headless"
// build. Shim them to `globalThis` before loading.

import type { Terminal as XTermTerminal } from 'xterm-headless'

const g = globalThis as unknown as Record<string, unknown>
if (g.window === undefined) g.window = globalThis
if (g.self === undefined) g.self = globalThis

// Lazy require so the shim above is set before xterm-headless touches
// any module-level code.
let TerminalCtor: typeof XTermTerminal | null = null
async function getTerminalCtor(): Promise<typeof XTermTerminal> {
  if (!TerminalCtor) {
    const mod = await import('xterm-headless')
    TerminalCtor = mod.Terminal
  }
  return TerminalCtor
}

export interface PtyOutput {
  write(chunk: string): void
  resize(cols: number, rows: number): void
  readLines(): string[]
  dispose(): void
}

export async function createPtyOutput(initialCols = 200, initialRows = 1000): Promise<PtyOutput> {
  const Terminal = await getTerminalCtor()
  const term = new Terminal({
    cols: Math.max(1, initialCols),
    rows: Math.max(1, initialRows),
    scrollback: 5000,
    convertEol: true,
    allowProposedApi: true,
  })

  // xterm-headless's `write` is async (uses a parser pump). We don't
  // need to await each chunk — readLines reflects whatever's been
  // parsed so far — but flush callbacks fire when the parser drains.
  return {
    write(chunk: string) {
      term.write(chunk)
    },
    resize(cols: number, rows: number) {
      term.resize(Math.max(1, cols), Math.max(1, rows))
    },
    readLines() {
      const out: string[] = []
      const total = term.buffer.active.length
      const viewportRows = term.rows
      const start = Math.max(0, total - viewportRows)
      for (let y = start; y < total; y++) {
        const line = term.buffer.active.getLine(y)
        out.push(line ? line.translateToString(true) : '')
      }
      return out
    },
    dispose() {
      term.dispose()
    },
  }
}
