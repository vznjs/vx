# `src/exec/proc-sample.ts` — what a running task's processes use now

`resourceUsage()` answers only once a task exits. A telemetry sink that
wants a task's CPU and memory over its run (`task.sample`, telemetry.md)
needs a look while it runs: `sampleTrees(roots)` gives each live root pid
the summed CPU time (ms) and resident memory (bytes) of the root and every
descendant. `watchTree(pid)` is the sandbox's: one 250 ms timer looks at
every watched tree, and `stop()` answers the most CPU and the peak memory
any look saw, or nothing when no look landed.

```ts
export interface TreeUsage {
  cpuMs: number
  rssBytes: number
}
export function sampleTrees(
  roots: readonly number[],
  skip?: ReadonlySet<string>, // members not counted (their children are): the tracer
): Promise<Map<number, TreeUsage>>
export function watchTree(pid: number): { stop(): TreeUsage | undefined }
export function psTimeMs(s: string): number | undefined // ps's `time` column, in ms
```

## Invariants

- A tree by parent pid, not a process group: a sandboxed task runs under
  bwrap in a session of its own, so its group is another, but each
  process still has its parent.
- Linux reads `/proc`: every `stat` for the parent map and the CPU
  (USER_HZ ticks, 100 by ABI; a process's own and its reaped children's,
  `cutime` + `cstime`, so a short-lived member's CPU stays counted), and `status` `VmRSS` (its unit written,
  kB) for the tree's members alone. Another namespace's `/proc`
  (`procfsIsOwn()` false) answers nothing rather than strangers.
- Elsewhere one `ps -A -o pid=,ppid=,rss=,time=` per look.
- A root that is gone has no entry; on macOS a descendant that exited
  leaves the CPU sum, and a process re-parented to init leaves the tree.
- Proven by `tests/proc-sample.unsafe.test.ts`: a burning grandchild's
  CPU reads within a bounded factor of the wall it burned (pins the
  tick and the tree walk), and memory within a bounded range;
  `tests/sandbox-usage.unsafe.test.ts`: a Linux sandboxed spin reports
  its CPU and peak.
