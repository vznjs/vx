// Pure decision-table predicate for when the alt-screen TUI can
// run. Same shape as before — kept so the CLI doesn't have to
// branch on env conditions inline.

export interface TuiEnv {
  argv: {
    tui?: boolean
    noTui?: boolean
    dry?: boolean
    graph?: boolean
  }
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  noColor: boolean
  ci: boolean
  customLogger: boolean
  customObserver: boolean
  columns: number
  rows: number
}

export type TuiDecision = { use: true } | { use: false; reason: string }

export function shouldUseTui(env: TuiEnv): TuiDecision {
  if (env.argv.noTui) return { use: false, reason: '--no-tui' }
  if (env.argv.dry === true || env.argv.graph === true) {
    return { use: false, reason: 'planning mode' }
  }
  if (!env.stdoutIsTTY) return { use: false, reason: 'stdout is not a TTY' }
  if (!env.stdinIsTTY) return { use: false, reason: 'stdin is not a TTY' }
  if (env.noColor) return { use: false, reason: 'NO_COLOR set' }
  if (env.ci) return { use: false, reason: 'CI environment' }
  if (env.customLogger || env.customObserver) {
    return { use: false, reason: 'custom logger configured' }
  }
  if (env.columns < 80 || env.rows < 20) {
    return { use: false, reason: 'terminal smaller than 80x20' }
  }
  if (env.argv.tui === true) return { use: true }
  return { use: false, reason: 'opt-in' }
}
