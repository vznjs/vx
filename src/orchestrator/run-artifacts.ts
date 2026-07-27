// Optional per-run output artifacts:
//
//   --summarize[=<path>] → JSON describing every task's outcome
//                          (id, status, exit code, durations, hash,
//                          cpu_ms, peak_rss_bytes, hrtime spans).
//                          Default path: <cacheDir>/runs/<run_id>.json.
//
//   --profile[=<path>]   → Chrome-trace JSON of the run. Each task is
//                          a single complete event (`ph: 'X'`) with
//                          ts / dur in microseconds derived from the
//                          hrtime spans the runner already captures.
//                          Default path: profile.json (cwd-relative).
//
// Both are no-ops if the corresponding RunOptions field is undefined.

import path from 'node:path'
import { isGroupTask, type TaskOutcome } from '../graph/index.js'
import { tallyOutcomes } from './tally.js'

export interface SummarizeArgs {
  /** Empty string → default path; otherwise the explicit file path. */
  target: string
  cacheDir: string
  cwd: string
  runId: string
  startedAtMs: number
  endedAtMs: number
  totalMs: number
  /** The run's verdict — the same value the CLI turns into the exit code. */
  ok: boolean
  outcomes: readonly TaskOutcome[]
}

/** One task's entry. Shared by `tasks` and `aborted` so they read alike. */
function taskEntry(o: TaskOutcome): Record<string, unknown> {
  return {
    id: o.node.id,
    project: o.node.projectName,
    task: o.node.taskName,
    status: o.status,
    exitCode: o.exitCode,
    durationMs: o.durationMs,
    hash: o.hash ?? null,
    ...(o.cpuMs !== undefined ? { cpuMs: o.cpuMs } : {}),
    ...(o.peakRssBytes !== undefined ? { peakRssBytes: o.peakRssBytes } : {}),
    // hrtime spans are bigints → emit as strings so JSON.parse on
    // the consumer side doesn't truncate the ns precision.
    ...(o.wallclockStartNs !== undefined ? { wallclockStartNs: String(o.wallclockStartNs) } : {}),
    ...(o.wallclockEndNs !== undefined ? { wallclockEndNs: String(o.wallclockEndNs) } : {}),
  }
}

export async function writeRunSummary(args: SummarizeArgs): Promise<string> {
  const outPath =
    args.target === ''
      ? path.join(args.cacheDir, 'runs', `${args.runId}.json`)
      : path.resolve(args.cwd, args.target)
  // `tasks` and `summary` must describe the same population, or one artifact
  // contradicts itself (a group task listed in `tasks` but absent from
  // `summary.total`). `tallyOutcomes` owns the rule; mirror its filter here.
  const counted = args.outcomes.filter((o) => !isGroupTask(o.node) && o.status !== 'aborted')
  // A task killed by a shutdown signal is in no bucket and no total, yet it
  // makes the run red. Listing it separately keeps `tasks.length ===
  // summary.total` while leaving the artifact able to explain a non-zero
  // exit — the terminal has said so in its Aborted section all along, and a
  // parser must not be told less than a human is.
  const aborted = args.outcomes.filter((o) => !isGroupTask(o.node) && o.status === 'aborted')
  const payload = {
    runId: args.runId,
    // The run-level verdict, first: a consumer gating on this artifact must
    // not have to re-derive it by re-implementing the bucket rules.
    ok: args.ok,
    exitCode: args.ok ? 0 : 1,
    startedAt: new Date(args.startedAtMs).toISOString(),
    endedAt: new Date(args.endedAtMs).toISOString(),
    totalMs: args.totalMs,
    tasks: counted.map(taskEntry),
    aborted: aborted.map(taskEntry),
    // The FULL list: `tallyOutcomes` applies the same group/aborted
    // exclusions internally, so every counted bucket is unchanged by passing
    // it — but `summary.aborted` is only non-zero if it sees them.
    summary: tallyOutcomes(args.outcomes),
  }
  await Bun.write(outPath, JSON.stringify(payload, null, 2))
  return outPath
}

export interface ProfileArgs {
  target: string
  cwd: string
  outcomes: readonly TaskOutcome[]
}

/**
 * Chrome trace JSON. Spec:
 *   https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU
 *
 * One complete event (`ph: 'X'`) per task with `ts` and `dur` in
 * microseconds (Chrome's unit; we have ns from hrtime, divide by 1000).
 * Each project gets its own `tid` so concurrent tasks render on
 * distinct rows in chrome://tracing or perfetto.
 */
export async function writeRunProfile(args: ProfileArgs): Promise<string> {
  const outPath = path.resolve(args.cwd, args.target)
  const tidByProject = new Map<string, number>()
  const traceEvents = args.outcomes
    .filter((o) => o.wallclockStartNs !== undefined && o.wallclockEndNs !== undefined)
    .map((o) => {
      let tid = tidByProject.get(o.node.projectName)
      if (tid === undefined) {
        tid = tidByProject.size + 1
        tidByProject.set(o.node.projectName, tid)
      }
      // ns → us; bigint arithmetic to avoid precision loss before
      // converting to a JSON-safe number.
      const startUs = Number((o.wallclockStartNs ?? 0n) / 1000n)
      const durUs = Number(((o.wallclockEndNs ?? 0n) - (o.wallclockStartNs ?? 0n)) / 1000n)
      return {
        name: o.node.id,
        cat: o.status,
        ph: 'X',
        ts: startUs,
        dur: durUs,
        pid: 1,
        tid,
        args: {
          exitCode: o.exitCode,
          hash: o.hash ?? null,
          ...(o.cpuMs !== undefined ? { cpuMs: o.cpuMs } : {}),
          ...(o.peakRssBytes !== undefined ? { peakRssBytes: o.peakRssBytes } : {}),
        },
      }
    })
  await Bun.write(outPath, JSON.stringify({ traceEvents }, null, 2))
  return outPath
}
