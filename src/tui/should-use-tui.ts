// Decide whether the alt-screen TUI can run in this environment.
// Pure function over a fully-explicit env so the decision is easy to
// reproduce in tests, error reports, and the CLI's "TUI unavailable
// (<reason>)" diagnostic. See docs/design/tui-design.md §5.

export interface TuiEnv {
  argv: {
    tui?: boolean
    noTui?: boolean
    dry?: boolean
    graph?: boolean
  }
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  /** True when `NO_COLOR` or equivalent is set (no ANSI). */
  noColor: boolean
  /** True when the env looks like CI (no interactivity). */
  ci: boolean
  /** True when the embedder supplied a custom Logger. */
  customLogger: boolean
  /** True when the embedder supplied a custom Observer. */
  customObserver: boolean
  columns: number
  rows: number
}

export type TuiDecision = { use: true } | { use: false; reason: string }

/**
 * Order matters. First match wins. The explicit `--no-tui` flag is
 * checked before everything else so a user can always force the
 * framed-block path. Disqualifiers are ordered from "least surprising
 * to mention in a diagnostic" outward.
 *
 * When `--tui` is set but a disqualifier fires, we still return the
 * disqualifier reason — the CLI prints "vx: TUI unavailable
 * (<reason>)". When `--tui` is unset (auto-detect failed), we return
 * the opt-in fall-through reason silently; the CLI doesn't print.
 */
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
  // Phase 1 / 2 default: opt-in only. Phase 3 may flip to use:true.
  return { use: false, reason: 'opt-in' }
}
