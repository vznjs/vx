# Workstream Q — cold CPU below Vite Task (2026-10-04)

The owner's ask: "Make VX cpu burn lower than Vite Task". The 1,090-package
bench read 17.27 s of cold CPU for vx against 12.46 s for Vite Task
(`vp run`, vite-plus 1.0.0). Measured on the bench's own workspace shape,
compiled binary, `run build test --all --concurrency 10 --frozen`; vx's
own CPU (user + system of the vx process, its children excluded) read
from a `--preload` that prints `process.resourceUsage()` at exit, and per
thread from `/proc/self/task/*/stat`. Five interleaved rounds per arm.

Where it went, 1,090 packages, `BUILD_SLEEP=0` (2,180 commands): vx's own
6.85 s (median) of 13 s; the tasks' shells the rest. Of vx's own: the
main thread 3.1 s, the thread pool 1.9 s (nearly all system time: a
futex wake, an eventfd write and an epoll turn per call), the JIT 0.75 s.

- **Q-1.** Four costs every miss paid. `DeferredOutputs.materializeFor`
  walked the task's whole dependency closure even with nothing deferred
  (`--download=none` is the only way to defer): O(graph) a task, 1.4 s of
  the main thread at 1,090 packages, and the reason vx's CPU grew faster
  than the graph. It returns before the walk now. A one-file artifact's
  zstd call, output stats and output reads ran as thread-pool round trips
  that cost more than the work (a 3 KB compress: 66 µs async, 16 on the
  thread); at or below 256 KiB (`ON_THREAD_MAX`) they run on the calling
  thread, and a few outputs (≤ 32) are stat'ed there. The temp write stays
  on the pool: on the thread it cost more CPU and wall. A save scanned its
  artifact by decoding the bytes it had just encoded; it scans the tar it
  packed. And `TaskInputs.upstream` queried the index for every
  dependency's outputs on every miss; only an input-shipping executor
  reads it, so the local floor never reads it (a plugin executor gets it read up front). vx's own CPU 6.85 → 5.7 s
  (median of five), wall 5.55 → 4.94 s. Rows: `download-policy.test.ts`
  (nothing deferred walks nothing), `zstd-frames.test.ts` (a small frame
  decodes on the thread, a large one off it), `execute-task.test.ts` (the
  upstream outputs are read only when an executor reads them); each red
  without its change.

- **Q-2.** macOS ran every task through `/bin/sh`, a stub that execs
  bash: two images a task, and bash where Linux CI runs dash. vx runs
  dash there when its PATH has it (`taskShell()`), and a sandboxed macOS
  task asks the sandbox runtime for it too, which ran bash. On Linux dash
  costs about 1 ms of CPU a task against bash's 1.7 (1,000 `true`s:
  2.32 s vs 2.95 s). Rows: `util-which.test.ts` (dash on macOS, no
  bash there); `sandbox-runtime.unsafe.test.ts`'s same-shell row holds
  the sandboxed side on the macOS job.
