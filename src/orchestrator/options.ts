// Run option/summary types live in a leaf file (not the module entry)
// so internals like prepare.ts can import them without an upward
// import of index.ts — the module entry must stay cycle-free.

import type { TaskOutcome } from '../graph/index.js'
import type { Logger } from './logger.js'

export interface RunOptions {
  cwd: string
  /**
   * Task specs to run. Each may be a bare task name (`'build'`) —
   * applied across `projects` to every project that declares it —
   * or an anchored `'pkg#task'` — added directly to the requested
   * set regardless of `projects`.
   */
  tasks: readonly string[]
  projects?: string[]
  concurrency?: number
  /** Skip cache reads AND writes. Every task runs and nothing is persisted. */
  noCache?: boolean
  /**
   * CI mode: load configs FROM the committed vx-lock.json instead of
   * evaluating them (frozen-env reproducibility). Requires the lock
   * to exist and pass its content-hash tripwire. Local runs default
   * to live evaluation — byte hashes can't see a config's import
   * closure, so a strict local mode would give false confidence.
   * Pair with `vx lock --check` in CI for the full evaluation audit.
   */
  frozen?: boolean
  /**
   * Filter `dependsOn` expansion. `'all'` drops every edge (just the
   * requested task runs). A string array drops only those task names
   * from both `self` and `dependencies` buckets.
   */
  excludeDependencies?: 'all' | readonly string[]
  /** Forwarded to the last step of each task's exec array (shell-quoted). */
  forwardArgs?: readonly string[]
  /**
   * If set, write a per-run JSON summary at end of run. Empty string
   * picks the default path `<cacheDir>/runs/<run_id>.json`; anything
   * else is treated as the literal file path (cwd-relative).
   */
  summarize?: string
  /**
   * If set, write a Chrome-trace JSON profile of the run's wallclock
   * spans. Path is cwd-relative. Default `profile.json` is selected
   * by the CLI parser, not here.
   */
  profile?: string
  /**
   * Install SIGINT/SIGTERM handlers for the run's duration: forward
   * SIGTERM to every live child, close the cache, exit 128+signo
   * (130/143). Default true. The watch loop disables this — it owns
   * signal disposition for its whole lifetime and a cycle must never
   * exit the process out from under it.
   */
  handleSignals?: boolean
  log?: Logger
}

export interface RunSummary {
  ok: boolean
  outcomes: TaskOutcome[]
}
