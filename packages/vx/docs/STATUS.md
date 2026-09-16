# STATUS — the living handoff

**Read this first.** It is the one file a fresh session needs to pick the
project up: the direction, what shipped, what is in flight, what is next.
Update it in the SAME commit as the work it describes. Newest state wins;
delete stale lines rather than appending corrections.

## Direction (owner, 2026-09-02)

> "VX should be the Vite of task orchestration. Perf first, then
> modularity. Slim core; add features with plugins or replace
> functionality. Remove DTE / VX Cloud / agents — vx ships none of it, but
> gives people a way to implement it on top. Consider everything before
> this date legacy."

Concretely:

1. **Performance is the first decision driver.** Every change to the run
   path is measured (`packages/vx-bench/`), and a slower core is a regression even if
   it is prettier. Targets: the fastest warm no-op run and the lowest
   scheduler/hash overhead of any JS-monorepo task runner.
2. **Core is a pipeline with seams, not a product.** Core owns:
   discovery, config evaluation, the task graph, cache keys, scheduling,
   and the seams. Plugins own: WHERE a task runs (`executor`), WHERE
   artifacts live (`cache`), WHO observes (`telemetry`/reporters), and —
   as the seams widen — how the graph is shaped and prioritised and which
   CLI verbs exist.
3. **No distribution in the repo.** No agents, synchronizers, controllers,
   cloud, dashboards. The executor seam is the extension point for all of
   it; `@vzn/vx-reapi` (Bazel Remote Execution API) stays as the proof
   that the seam is wide enough.
4. **Native first.** Bun APIs over dependencies. A dependency needs a
   reason written down next to it.
5. **Adoption ready.** Docs, site, and design describe the product that
   exists — verified against the code, not remembered.

Process: push directly to `main`, no PRs. Gate before every push:
`bun packages/vx/src/bin.ts run ci --all`. Small, focused commits.

## Shipped — the record

The review arc (2026-09-02 → 09-09) and improvement-loop items 1–64,
with the bench numbers behind them, moved whole to
`docs/history/2026-09-review-arc.md` on 2026-09-10, items 65–104 to
`docs/history/2026-09-improvement-loop-65-104.md` on 2026-09-11, and
items 105–144 to `docs/history/2026-09-improvement-loop-105-144.md` on
2026-09-16 (with the Next list's record to
`docs/history/2026-09-status-next-log.md` the same night), and items
145–202 to `docs/history/2026-09-improvement-loop-145-202.md` later
that day (the 2026-09-10 measurement paragraphs to the 65–104 file, and
handoffs 14g–14i to the next-log file), and items 203–242 to
`docs/history/2026-09-improvement-loop-203-242.md` that night (handoffs
14j–14p to the next-log file), so this file stays the handoff
and not the log; numbering continues from there. Keep
it that way: when the loop below passes forty items, move the oldest
batch there in one commit, and move a Next entry's record the same way
once it is closed.

## Improvement loop (2026-09-09, after the review pass merged)

Open-ended, owner-delegated: find flaws, widen seams, sharpen DX,
refactor toward cleaner layers. One coherent commit per step, gated,
recorded here as it lands. Layer map measured first (imports between
`src/<module>` directories): util ← workspace ← cache, exec ← graph ←
orchestrator ← cli, `config.ts` a leaf, no back edges — the boundaries
test is telling the truth.

243.  DONE (2026-09-16, the minimal-image persona, a step further): a
      temp directory that is missing, a file, or not writable. The run
      lock degraded as designed (one line, an unlocked run) and a plain
      task ran; a sandboxed task failed with "sandbox not available:
      EACCES … mkdtemp '/tmp/probe-ro/srt-obs-…'" — the runtime's own
      temp files live under `os.tmpdir()` — a path and no knob, in both
      lines. Util's `isTmpdirRefusal` (ENOENT, ENOTDIR or a permission
      code on a path under the temp directory; for a site whose path IS
      the temp directory by construction) and `TMPDIR_HINT`; the
      sandbox verdict for a runtime throw goes through `thrownReason`
      and says "the sandbox runtime needs a writable temp directory and
      <tmpdir> is not one (…) — point TMPDIR at a writable directory";
      the run-lock line adds the hint. Pinned in `tmpdir-refusal.test.ts`
      (a missing TMPDIR: exit 0, the lock line with the hint; the control
      has the lock and no line) and in the unsafe sandbox suite (the
      verdict, under a real sandbox as `probe`). Both fail without the
      fix; a sandboxed probe passing for the wrong reason was ruled out
      by running it on the old source as `probe`. The darwin job then
      taught the second shape: the runtime's first temp use on macOS is
      its unix socket, and a TMPDIR under the workspace put the socket
      path past `sun_path` (104 bytes on macOS, 108 on Linux) —
      ENAMETOOLONG there, "Failed to create bridge sockets after 5
      attempts" on Linux (the runtime's retry loop swallows the code),
      neither naming the directory. `socketPathRefusal` checks the
      length up front in the probe and says the path, its length, the
      limit and "point TMPDIR at a shorter path"; pinned in the unsafe
      suite with an existing directory just past the limit (fails
      without it as the bridge-sockets line), and the missing-TMPDIR pin
      uses a short path directly under the temp directory.

244.  DONE (2026-09-16, the class of 242 grepped): the one other
      `sh -c` in core, the `cache.inputs.runtime` probe, said "failed
      to spawn: <command>" on a box without sh — the command blamed for
      the shell's absence. An ENOENT there names the shell and the
      install, with the command and cwd after it. Pinned beside 242's
      cases in `no-shell-on-path.test.ts`; fails without the fix.

245.  DONE (2026-09-16, Next 6 — the day's diff on the warm path): after
      #407 and #408 (241–244: git and sh refusals, the TMPDIR lines, the
      spawn-failure text), 1,000 projects measured 248 ms warm / 754
      restore / 2,738 cold (medians of 5) against the morning's 231 /
      718 / 2,436. The interleaved A/B on one 1,000-project workspace,
      the pre-241 commit (#406) in an immutable worktree against main,
      9 reps each: min 250 vs 250, median 258 vs 262 — a tie. The gap to
      the morning is the box (both arms sit 20 ms above it), not the
      diff: every site the day touched is a catch path or a refusal
      that a green run never enters.

246.  DONE (2026-09-16, the minimal-image persona at the sandbox): a
      host with bubblewrap and socat — the two the docs named — failed
      every sandboxed task with "sandbox not available: ripgrep (rg) not
      found", the runtime's own words and nothing else. The runtime
      needs ripgrep on Linux to expand its mandatory deny globs into
      paths for bwrap (macOS takes patterns), and CI has installed it
      since the runner action existed; the schema reference, the
      sandboxing guide and the site's known limits said two of three.
      `dependencyReason` names the set and the install around the
      runtime's line; the four docs name ripgrep. Pinned in the unsafe
      suite: a PATH with everything but rg, the verdict with the install
      (fails without the fix as the bare runtime line).

247.  DONE (2026-09-16, the minimal-image persona at `vx upgrade`): with
      no route out — a network namespace, or a proxy that is down — the
      compiled binary printed Bun's own TypeError ("Unable to connect.
      Is the computer able to access the url?"; DNS: "Was there a typo
      in the url or port?") with a stack, as an internal error. Both
      fetches (the release document, the asset) go through one wrapper
      that says "vx upgrade: could not reach <host> to <what> (<reason>)
      — check the network or the proxy and re-run". Pinned through the
      stubbed fetch in `upgrade.test.ts` (a rejecting fetch is a
      `UserError` with the line, and the binary is untouched); fails
      without the fix as the bare TypeError. Also read on the way: a
      dead HTTPS_PROXY does not stand in for no network here — Bun's
      fetch reached the release regardless — so the probe used
      `unshare -n` and `bwrap --unshare-net`; and an unknown tag was
      already one line ("download failed (404)").

248.  DONE (2026-09-16, the minimal-image persona at `vx init`): a root
      `package.json` with no `workspaces` field beside a `packages/app`
      full of scripts is single-project mode by design (the root is the
      one project), so `vx init` said "no package.json scripts to turn
      into tasks" and wrote an example config, and `vx run` said "run
      vx init" — the scripts existed, the globs did not, and the
      count-0 hint of 238 never fires because the root counts as one.
      `unreachedPackages` (single-project mode only, on the failure path
      only: one shallow scan two levels down, `node_modules` and dot
      directories skipped) and `unreachedHint` give both verbs one
      line: the cause, the packages, the `workspaces` entry to add.
      Pinned in `init.test.ts` with a control (the same tree with the
      globs declared is a workspace); both fail without the fix.
      Measured on the way: Bun.Glob does not expand a brace whose
      alternatives hold a slash (`{*,*/*}/package.json` matches
      nothing) — two scans.

249.  DONE (2026-09-16, the CI-container persona): every verb (`run` on a
      miss, a hit and a failure, `info`, `show`, `why`, `last`, a dry
      `init`, `--summarize`) piped with `CI=1`, and piped with neither
      CI nor a TTY, and under `TERM=dumb`: no escape sequence, no
      carriage return, in any output. Clean, and pinned end to end in
      `ci-output.test.ts` (the status line and the colour decision had
      unit pins; this is the whole output as a log file receives it),
      with a `FORCE_COLOR` control that paints the same piped run.

250.  DONE (2026-09-16, the dependency sweep, five days after 92): what
      `bun outdated -r` listed — `oxfmt` 0.67.0 → 0.68.0 and `oxlint`
      1.82.0 → 1.83.0 (the repo's lint task green on both, no reflow
      this time), `@anthropic-ai/sandbox-runtime` ^0.0.75 → ^0.0.76
      (its bwrap gains `--cap-drop ALL` and an address module; the
      unsafe sandbox suite as `probe` is 57 pass, 1 skip — a first run
      of it showed two port-bridge failures that were my `su probe`
      without the probe user's bun on PATH, not the runtime: the gate's
      PATH passes). Left alone, as majors for the REAPI plugin whose
      live suite this box cannot run: `protobufjs` 7.6.5 → 8.8.0 and
      `@grpc/proto-loader` 0.7.15 → 0.8.1. `oxlint-tsgolint` 7.0.2001
      is current. Bun 1.4.2 is still the newest tag.

251.  DONE (2026-09-16, the plugin-author lens at the executor seam): a
      plugin executor whose `execute` resolved `{}` met `res.violations`
      in core and became "internal error in <task>: TypeError …" — vx's
      crash for the plugin's bug, where the factory's output had been
      checked since item 15 (`resolveExecutors`: missing execute(), no
      name). `assertExecuteResult` checks the resolved result at the
      seam (exitCode and durationMs numbers, stdout and stderr strings,
      violations an array, outputs disk or deferred with a
      materialize) and refuses as a `UserError` naming the executor and
      the field, written into the task's frame like a throw. Pinned in
      `execute-task.test.ts` with a control (a well-formed result from
      a plugin executor is the outcome); fails without the fix as the
      TypeError. Read on the way: the other seams already validate at
      the boundary (project stage, key parts, commands, the workspace
      file's definePlugin stamp), and Next 8(d)'s "last large files" was
      stale — corrected in place.

252.  DONE (2026-09-16, the plugin-author lens at the cache seam, after
      251's executor): a remote layer's `get` that resolved
      `{ body: 'abc' }` (or `{}`, or a string) was reported as "corrupt
      artifact for <hash>: artifact is not a readable archive" — the
      bytes blamed for the plugin's shape — and a `hasMany` that
      resolved an array passed through to the prefetch pass's `.has()`.
      Probed first through `LayeredCache` with six malformed layers:
      nothing crashed (the never-fail contract holds), the words were
      wrong. The layer checks both shapes now and names the call and
      the shape through `onRemoteError` ("remote cache layer returned
      an invalid result: get(<hash>) resolved body is string (expected
      { body: ArrayBuffer | Uint8Array, durationMs } or null) — a
      plugin bug, degraded to a miss"; a `hasMany` array reads as no
      batch info). Pinned in `layered-cache.test.ts`; both fail without
      the fix (the corrupt-artifact line; the array passed through).
      `has()` is left as is: a truthy non-boolean only costs a `get`
      that then misses.

253.  DONE (2026-09-16, the gate's own shape): ten test files added
      since `tests/shard-weights.json` was recorded (the day's pins:
      the tree kill, the watch self-write loop, no git, no sh, the
      TMPDIR refusal, the CI output …) carried the table's median, and
      the 12 shards ran 10.1 to 16.7 s — the gate's wall time is the
      heaviest. Weighed from a junit run of all twelve as `probe`
      (the junit reporter per shard, then the shard script's weigh
      mode): the new deal predicts 13.3 s on every shard by the
      same weights (the old deal, 11.7 to 16.6 by them), and the next
      gate measured 13.4 to 15.0 s — the heaviest 1.6 s lighter, the
      spread 1.7 s where it was 6.6. Refresh again when a new file
      lands heavy: the median is what an unknown file costs, and a
      6 s e2e is not the median.

254.  DONE (2026-09-16, a measurement — the second-day user, then the
      restore arm): `vx why` after each kind of change names its cause
      (a source file, an env var, the project's package.json, the
      lockfile with the upstream it moved, the config, an upstream
      source, and a hit); clean, and each verdict row but three has a
      pin (env, package and upstream rows are read in the e2e suites
      through the run, not by the row — left as is). Then the stage
      tables at 1,000 and 5,000 projects: the cold arm is spawn-bound
      and the restore arm is the extract (`restore: extract` 13.4 s
      accumulated over 5,000 artifacts under 4 workers, 1.8 s of run
      graph); `save: pack` read 2 ms per one-file artifact there, which
      is neither zstd (26 µs a call, measured) nor a fixed cost —
      isolated, a one-file save is 0.82 ms and a restore 0.62 ms, and
      with four in flight 0.35 and 0.26 ms of wall each — so the
      accumulated span table over-counts wall under concurrency and its
      per-task figures are not costs. No change to the warm path; the
      arms' floors are the spawn and the extract, both known (193).

255.  DONE (2026-09-16, housekeeping after the lenses): Next 8(c) said
      only `vx lock` reads configs raw; five call sites read them by
      now, and each was read — the doctor, the selector and watch fall
      back to a raw per-file load only when the staged load throws, and
      a `turbo()` workspace's `vx info` counts the plugin's tasks —
      so the note is corrected, not the code. Core names no plugin in a
      branch (every `@vzn/vx-` in `src/` is a comment or a pointer the
      user reads). The day's measured traps went into CLAUDE.md's rules:
      the probe user's PATH, Bun.Glob's brace with a slash, a dead
      proxy as no network, the accumulated span table under
      concurrency, a TMPDIR pin's path length on macOS. The gate script
      runs its steps itself, so `vx last` holds no `ci` run to read the
      gate's shape from; the shard table (253) is that shape.

256.  DONE (2026-09-16, the rows 254 read by eye): `why.test.ts` walks
      a two-project workspace through an env change, the project's
      `package.json`, the lockfile (the fingerprint row and the
      upstream row it moves), the config and an upstream source, and
      pins each verdict row by its kind and the hash pair; the hit is
      the control with no row. `docs/cli.md` § `vx why` lists the six
      kinds and what each folds.

257.  DONE (2026-09-16, a persona: the tool that moved): a task whose
      command is `tsc --version` with `tsc` installed only in a sibling
      package's `node_modules/.bin` failed with the shell's line ("sh:
      1: exec: tsc: not found", exit 127) — true, and silent on the one
      thing that is vx's: the PATH it built (the project's bin, then
      the root's, never a sibling's). On exit 127 the frame gets one
      line naming the word (`execWord`, the same predicate `execWrap`
      uses, so a pipeline says "a command in this task"), the two bin
      directories and the rule; `taskBinDirs` is the one place both
      the env and the line read them from. Pinned in
      `tool-not-on-path.test.ts` with a PATH of bun, sh and git alone
      and a control (the same tool at the root's bin runs green, no
      line); fails without the fix. Read on the way: a first probe
      "passed" because the box's PATH had a `tsc` — an ambient PATH is
      part of every task's env by design (the allowlist), and a
      changed PATH is not a key change (env is folded only when
      declared), so a probe of a missing tool needs a stripped PATH and
      a miss. The darwin job of #420 taught the pin to compare against
      the workspace's real path (`/tmp` is `/private/tmp` there; the
      class of 242's pin).
258.  DONE (2026-09-16, the class of 257): a word with a slash is a file,
      not a PATH lookup, and the 257 line blamed the PATH for it — the
      shell says "not found" for a script that EXISTS when its `#!`
      interpreter does not (probed: `exec ./x.sh` with `#!/nonexistent`
      exits 127 with the file's name in the line, under dash and bash
      5), so the line would have sent a user to install a tool they
      have. The verdict moved to `shell-verdict.ts`: a bare word keeps
      the PATH rule (and `chmod +x` on 126); a path is read under
      either code — missing (the resolved path), a directory, no
      execute bit, a CRLF `#!` line (the interpreter the shell looked
      for ends in `\r`), a `#!` interpreter that does not exist, no
      `#!` line at all (126, the loader's "Exec format error"). Unit-
      pinned on real files in `shell-verdict.test.ts`; the e2e pin
      gained the shebang and the no-execute-bit cases (both fail
      without the wiring). The darwin job taught the third shell:
      macOS's bash 3.2 names a missing interpreter itself ("bad
      interpreter") and exits 1, so vx adds nothing there, and the pin
      says so per platform rather than skipping.
259.  DONE (2026-09-16, the class of 257 and 258): a task killed by a
      signal read `failed (exit 137)` and nothing else — 137, 139 and
      134 are a number to look up, and the number does not say what
      sent it. The same frame line now names the signal: definite when
      the runner saw it (`RunResult.signal`), "in the last command, or
      that command exited 139 itself" when only the code carries it (a
      pipeline, an inner sh), and each signal's usual sender — SIGKILL
      the OOM killer or a kill, SIGSEGV/SIGBUS/SIGILL/SIGFPE a crash in
      native code, SIGABRT an assertion or a JS runtime's heap limit,
      SIGPIPE a reader that left, SIGXCPU/SIGXFSZ a ulimit, SIGSYS a
      seccomp filter or the sandbox. Two paths keep their own lines and
      get none: vx's timeout (`timedOut`) and a SIGINT/SIGTERM the
      runner saw (the task reverts to aborted). Pinned in
      `signal-death.test.ts` (a `kill -9 $$` the runner sees, an inner
      sh's SEGV the code alone carries, the timeout as control) and
      per signal in `shell-verdict.test.ts`. Probed first: a subshell's
      `$$` is the outer shell's pid, so `(kill -SEGV $$)` killed the
      outer shell and the runner saw the signal — the code-only shape
      needs an inner `sh -c`.
260.  DONE (2026-09-16, the second-day reader of 257–259): `vx last`
      showed a failed task as `failed` and nothing more, though the
      record holds its exit code (the JSON had it). The row now reads
      as the frame did — `failed (exit 137)` — and ends with the signal
      an exit above 128 stands for (`128 + SIGKILL`), by one reverse
      map beside `signalExitCode` (`exitSignal`, exec) that the frame's
      verdict uses too. The frame's verdict lines themselves are not in
      the record: the run history stores an outcome per task, not its
      stderr, and a failure is never cached, so the line lives in the
      run's own output alone — by design (a run record is a summary;
      the log is the CI job's). Pinned in `last.test.ts` (a `kill -9 $$`
      row ends in `128 + SIGKILL`; `exit 3` has no signal part).
261.  DONE (2026-09-16, the CI reader of 259–260): `@vzn/vx-github`'s
      Failures callout said `exit 137` and stopped, the third surface
      with its own reading of one number. `exitSignal` joined the façade
      on the rule `escapeMarkdownCell` set (a sink rendering a failure
      faces the same decode every time; one copy), the export snapshot
      widened deliberately, and the callout names the signal after the
      code, `128 + SIGKILL` — pinned in the plugin's suite; `exit 2`
      stays bare.
262.  DONE (2026-09-16, the last copies of the number): core itself
      spelled a failure's label in three places — `outcomeLabel` (the
      frame footer, the status line, `--summarize`), the run report's
      own `failed (exit N)` and the Actions annotation's — so the
      signal of 259 reached the frame's verdict line and none of the
      labels. One `failedLabel` in `events.ts` now — the exit code and,
      above 128, the signal after a comma — everywhere a failure is
      labelled; a plain exit's label is unchanged. Pinned on the
      report, the annotation and the
      frame footer (signal-death e2e). `vx last`'s row keeps the
      signal as its last column part (its status column is 17 wide by
      design) and `vx-otel`'s `vx.task.exit_code` stays the integer it
      is: a derived string in structured telemetry is a consumer's
      call, and none has asked.
263.  DONE (2026-09-16, Next 6 — the day's diff on the warm path):
      after #420–#424 (257–262: the shell's verdict on 127, 126 and a
      signal, its label on every surface), the interleaved A/B on one
      1,000-project workspace, the pre-257 commit (#419) in an immutable
      worktree against the head of 262, 9 reps each, run twice with the
      arms swapped: after 245 / 255 and 252 / 262 ms (min / median),
      before 249 / 254 and 244 / 255 — a tie inside the box's jitter.
      Expected: `shellVerdict` and `failedLabel` sit on the exit path
      of an executed task, and a warm run executes nothing; a hit's
      label is not a failure's. The Linux job of #424 found the
      opted-down capture bound in `output-memory.test.ts` read exactly
      its 30 MiB line under twelve shards — the allocator high-water
      the logger test above it had already met and widened to half the
      volume (retention costs the full 141 MiB); the capture test now
      uses the same slack.
264.  DONE (2026-09-16, a persona: the plugin author's first sink): the
      plugins guide's two failure-reporting examples shipped a bare
      `exitCode` and named none of the façade's rendering helpers, so
      an author would roll a status `Set`, a table escape and a signal
      decode of their own — the drift the façade exists to stop. One
      section, "What the façade gives a sink", names the four answers
      (`isPassStatus` / `isCacheHit` / `TASK_STATUSES`, `exitSignal`,
      `escapeMarkdownCell`, `TaskLogBuffer`) with a runnable block; the
      Sentry example reports the signal beside the code; the reference
      names `src/index.ts` as the façade. Every block type-checks
      against the façade (`plugins-guide-snippets.test.ts`).
265.  DONE (2026-09-16, the CI reader's page): the CI guide's sample job
      summary was not what `@vzn/vx-github` writes — four columns to
      the renderer's three, `❌ failed (exit 2)` in a status cell the
      renderer never fills (the exit lives in a Failures callout the
      sample lacked), `success` / `cache hit` for `ran` / `cache` /
      `remote cache`, no footer. The sample is now the renderer's
      output for the run the page describes, and a site pin
      (`ci-guide-summary.test.ts`, `@vzn/vx-github` a site dev
      dependency like the schedule plugin) renders that run and checks
      every line is on the page; the prose says where the exit code
      and its signal go, and that core's `--report-file` writes the
      plainer four-column report. The other two rendered samples in the
      guides (`--dry`'s plan, the Flaky footer) matched the CLI byte for
      byte; the site's sweep is clean.
266.  DONE (2026-09-16, a persona: the reader of a skipped task): a red
      run's footer said `1 failed · 1 skipped` and nothing about which
      task was skipped or by what — the broad flow prints no row for a
      skipped task by design (the output-flow table, "silent"), and the
      `⊘` one-liner in `full` mode names no cause either. A Skipped
      section after the footer (beside Aborted and Flaky) names each
      skipped task under the failure at the root of its chain of skips
      (fail-fast and an aborted upstream named as such), eight names
      per cause. Pure-pinned in `summary.test.ts`, end to end in
      `skipped-footer.test.ts` with `--continue=always` as the control.
      Read on the way: a skipped outcome carries `exitCode: 1` from the
      scheduler, so `--summarize` reports 1 for a task that never ran;
      the run's own exit is 1 and the row's status says skipped, so it
      is a convention, not a lie — left as is. Cost on the footer's
      path, measured in isolation: 0.022 ms on a 5,000-task green run
      (one filter), 1.45 ms on a 4,999-skip chain behind one failure
      (the memoised walk).
267.  DONE (2026-09-16, the second-day reader of 266): the footer knew
      a skip's cause and no record did — `--summarize`, the telemetry
      record and the job summary said `skipped` and stopped. The
      scheduler now records the root of each block on the outcome
      (`blockedBy`: the failed or aborted upstream, handed down a chain
      of skips; absent for fail-fast), and every surface reads that one
      field — the footer (the walk of 266 is gone), the `--summarize`
      row, `TaskTelemetry` (additive: the version stays 2, as `where`
      and `attempts` were added), and `@vzn/vx-github`'s Failures
      callout, `— exit 3 · blocked app#build, web#build`. The `runs`
      table does not carry it: a column is a `SCHEMA_VERSION` bump that
      resets every local cache, and `vx last`'s skipped row says
      `skipped` beside its failed neighbour, so the day it is worth a
      bump is the day another column needs one. Pinned in the
      scheduler (a skip behind a skip names the root), the summary, the
      plugin's suite and end to end (the summarize row). The gate's
      first run found `@vzn/vx-otel`'s losslessness tripwire (a
      `Required<TaskTelemetry>` fixture) refusing the new field until
      it was mapped — the tripwire doing its job — so the task span
      carries `vx.task.blocked_by`, a task id as the record has it.
268.  DONE (2026-09-16, the reader of a timeout, the class of 267): since
      262 a task vx's own `timeout` killed was labelled as a SIGTERM
      death on every surface, `128 + SIGTERM` after its 143 — true of
      the number and wrong about the cause; only the frame's own line
      said "timed out", and the retry line said "after exit 143". The
      outcome now carries `timedOut` (the runner's, on the final
      attempt), and one `failedLabel` reads the reason first, "timed
      out, exit 143", everywhere: the frame footer, the status line,
      the report, the Actions
      annotation, `--summarize` (`timedOut: true`), the telemetry record
      (additive), the GitHub callout (`timed out, exit 143`) and the
      OTel span (`vx.task.timed_out`); the retry line says "after a
      timeout". `vx last` keeps `128 + SIGTERM`: the `runs` table has
      no column, the same call as `blockedBy`. Pinned at the outcome
      (the timeout test), the report, the annotation and both plugins.
269.  DONE (2026-09-16, the reader of a sandbox violation, the class of
      268): a sandboxed task that touched what it never declared failed
      on that alone — its exit forced to 1 when it was 0 — and every
      label and record said `failed (exit 1)`; only the frame's own
      SANDBOX VIOLATIONS section knew. And the OTel guide promised
      `vx.task.sandbox_violations` on the task span while the plugin
      had no such attribute and the record no such field: a claim the
      code lacked. `failedLabel` now counts the violations after the
      code, `failed (exit 1, 2 sandbox violations)`, on the frame
      footer, the status line, the report and the annotation; the
      `--summarize` row and the telemetry record carry
      `sandboxViolations` (additive); the GitHub callout counts them;
      the OTel span carries the attribute the guide named. Pinned on
      the three framed-output violation fixtures, the report, the
      annotation, the summarize row and both plugins.
270.  DONE (2026-09-16, the reader of a server that never came up, the
      last of the class): a persistent task that never became ready
      failed with a made-up `exitCode: 1` and every label and record
      said `failed (exit 1)` — only the frame's own line said "not
      ready within 300ms" or "exited before becoming ready (exit 2)".
      The runner's `ready` now rejects with a typed
      `PersistentReadyError` (reason `timeout` / `exited` / `spawn`, and
      the child's own exit code when it exited), the outcome carries
      `notReady` and the child's real exit, and `failedLabel` reads the
      reason first, "never ready: exited, exit 2", everywhere; the
      `--summarize` row, the telemetry record (additive), the GitHub
      callout and the OTel span (`vx.task.not_ready`) carry it. Pinned
      on the ready-timeout and exit-before-ready e2e cases (the second
      now exits 2 to prove the real code rides), the report, the
      annotation and both plugins; the `spawn` reason has no e2e pin —
      it needs a box without `sh`, the class `no-shell-on-path` covers
      for one-shot tasks — and is read by the same one label.
271.  DONE (2026-09-16, a CI finding on #431's first head): the Linux
      job's `@vzn/vx#lint.oxfmt` failed with "Failed to read file:
      packages/vx/.mcp.json" — the sandbox runtime's `/dev/null` mask
      on a name from its DANGEROUS_FILES, met by the walker whether or
      not the file exists (history: the review arc's item 33, fixed in
      the ROOT `.oxfmtrc.json` when core was the root). The nine
      per-package configs written when core moved under `packages/`
      never carried the ignore, and the mask is met only sometimes
      (every head since passed the same task), so it lay dormant. All
      nine now ignore `.mcp.json`, `.vscode`, `.idea` and `.claude`,
      and the package-boundaries suite's rule 5 pins that every oxfmt
      config in the repo ignores every masked name — the class, not
      the file.

## In flight

**Open after the sandbox arc (2026-09-05).** Its four Linux items
closed by 2026-09-10 — the docs build under bwrap, strace's seccomp
filter, a sandboxed port, persistent tasks inside their sandbox; the
record is in `docs/history/2026-09-status-next-log.md`. What stays
open is the one that needs a macOS box:

5. **macOS violation reporting is lossy while any violation fails the
   task.** The unified log drops records under load, so the same task can
   pass or fail run to run. Enforcement is unaffected — the OS denied the
   operation either way — but the REPORT is not a reliable gate on that
   platform.

**Releases.** v0.0.21 is on npm, the four platform packages with it
(2026-09-15, handoff 14d in the history file), published through
`npm.yml`, which reads no secret and sets no token — its publish is the
OIDC exchange or nothing — so the trusted publishers on npmjs.com are in
place. The v0.0.18 record (the token's `E401`, the held packages, the dry
run of the token-free workflow) moved to the history file with the
items above.

**Launch checklist (2026-09-10, the owner's "what is needed to go
fully live").** What a public announcement needs, in order, with the
state of each:

1. DONE by 2026-09-15 (0.0.21 published through the token-free
   `npm.yml`, so the trusted publishers exist). OWNER residue: delete
   the `NPM_TOKEN` repository secret if it still exists — nothing reads
   it. Documented in `docs/cli.md` § Releasing.
2. OWNER: cut the release — a GitHub release with the tag is the whole
   process (`release.yml` builds and signs the binaries, `npm.yml`
   publishes with provenance). Pick the version the articles will name;
   `0.1.0` says "first real release" where 0.0.19 says "another nightly".
   The release notes are the changelog — there is no CHANGELOG file, and
   GitHub's generated notes from merged PR titles are accurate since
   every merge is one titled PR.
3. OWNER: the site's address — it deploys to
   https://vznjs.github.io/vx/ on every push to main (`docs.yml`). A
   custom domain is a DNS record plus `SITE_URL` / `BASE_PATH` env in
   that workflow (`astro.config.mjs` reads both); every internal link is
   base-relative, so nothing else moves.
4. DONE 2026-09-10: the blog and its thirty posts, README and site
   numbers, LICENSE holder, SECURITY.md, CONTRIBUTING.md (items 115,
   116, 118).
5. OWNER, optional: enable GitHub private vulnerability reporting
   (Settings → Security) so `SECURITY.md`'s instruction is live; issue
   templates are not needed for a first announcement.
6. DONE 2026-09-16 as item 226: the site's introduction has a
   "Known limits" section — Bun ≥ 1.4 for source installs (the binary
   needs nothing); Linux sandboxing needs `bubblewrap`, `socat` and
   `ripgrep` (the third named 2026-09-16, item 246) and cannot run as
   root inside a container; Windows is WSL; macOS
   violation reporting is lossy under load (In-flight 5); the remote
   seam moves whole artifacts in memory (Next 2, fine below ~100 MiB);
   a task's replayed output is its first and last 8 MiB (229); a project
   inside a submodule is enumerated by its own repository (221). An
   article links it.

## Next (ordered)

0. DONE 2026-09-10 as item 87 (history) — core has no `build`; dependants stop compiling the release binaries.
1. **The live REAPI suites are green again (2026-09-04); the
   whole-graph run stays optional.** With OrbStack's docker back, the
   rehosted `vx-nativelink:bun-node` image on
   `tests/helpers/nativelink-exec.json5` ran all ten `@vzn/vx-reapi`
   files one process each with both endpoints set: 121 pass, 0 fail —
   the wire-level execution suite (15), the cache suite (16) and the
   `execute: true` composition proof (2) included, so the barrel
   narrowing and the by-name error classification (2026-09-03) changed
   nothing live. Not done: `vx run ci --all` of THIS repo at a worker —
   it needs a workspace that wires `reapi({ execute: true })` (none is
   checked in) and filesystem stores (the memory stores evict under a
   `node_modules` install, per the helper notes). An exercise, not a
   gap; do it when a worker-side change needs it.
2. **The remote seam still moves whole artifacts.** With save, ingest
   and restore bounded, `RemoteCacheLayer` is the last place a large
   artifact sits in memory: `put(hash, body: ArrayBuffer | Uint8Array)`
   gets the on-disk artifact via `Bun.file().bytes()`, and `get` returns
   an `ArrayBuffer` that ingest writes to its temp. Widening both to a
   `Blob` (a `BunFile` is one; bytes wrap in one) would let uploads
   stream from disk and downloads land in the temp directly — but
   `@vzn/vx-reapi` must digest the whole body before it can upload, so
   the plugin side needs a streaming digest and a chunked `writeBlob`
   first. A breaking seam change for plugin authors; do it with the
   plugins guide, the stub layers in the tests and `vx-reapi` in one
   commit, and measure a 150 MiB round trip through the stub before
   and after. Not started. Assessed 2026-09-04: the win is gated by the PLUGIN
   side — `@vzn/vx-reapi`'s wire zstd-compresses the whole body in
   memory and retries a wedged upload from it, so a core-side Blob alone
   measures nothing; streaming needs a two-pass digest and a chunked
   compressed upload through the adaptive-downgrade path. Do it when a
   real workspace uploads > 100 MiB artifacts, not before.
3. DONE 2026-09-09 as item 88 → `@vzn/vx-turbo` (history) — zero-migration adoption as a plugin on the `project` stage.
4. DONE 2026-09-10 as item 77 (history) — one core per process; the shipped binary serves its own façade to every `@vzn/vx` import.
5. DONE 2026-09-11 as item 148 — the watch e2e flake was the arm
   instant on the wrong clock; the macOS intermittent extra cycle stays
   recorded under item 130.
6. **Re-measure the warm run after each day's work** — the hot path is
   the product. `bun packages/vx-bench/run.ts 100 5` and `1000 5`; an interleaved
   A/B against an immutable worktree settles any gap
   (`scratchpad/ab.ts`-style: alternate arms, min and median of N).
   The closing figures of 2026-09-03 → 09-10 and the refutations
   recorded under this duty (a synchronous restore for small
   artifacts, discovery's stat memo, the `restore: rows` lead) are in
   `docs/history/2026-09-status-next-log.md`; the latest day's A/B is
   item 245 (2026-09-16, a tie; 179 was the one before), and the
   restore arm's floor is the note under item 193 (history). 2026-09-16, after item 225: 5,000 projects
   687 ms warm / 2,854 restore / 12,152 cold (medians of 3) against
   1,000's 231 / 718 / 2,436 — the warm stage table grows 3.4–3.9× for
   5× the projects (discover 23 → 89 ms, load configs 24 → 87, classify
   56 → 190, run graph 42 → 144), git's own enumeration 6× (9 → 55),
   nothing super-linear; the fixed ~30 ms of startup and workspace
   config is what makes 5,000 cheaper per project than 1,000.

7. CLOSED — the 2026-09-04 walkthrough's four follow-ups landed
   ((a) `noCache` in `--summarize` rows, (b) `init` no longer makes
   `lint` wait for `build`, (d) an empty filter set names its patterns)
   or were measured out ((c) watch's one extra cycle on an undeclared
   write is the price of not declaring it). Record: history, next-log.

8. **Improvement-loop candidates (2026-09-09).** (a), (b), (f), (h)
   DONE as items 16/63, 8(b) 2026-09-10, 75 and 58; the measurements
   behind (e) and (h) are in `docs/history/2026-09-status-next-log.md`.
   Still standing: (c) `vx lock` reads config files raw on purpose,
   and the doctor, the selector and watch fall back to a raw per-file
   read only when the staged load throws (five call sites by
   2026-09-16, each read and confirmed against a `turbo()` workspace:
   `vx info` counts the plugin's tasks) — grep for `loadProjectConfig(`
   before adding a consumer that is not a fallback; (d) was "`logger.ts` and
   `framed-output.ts` are the last large files" — by 2026-09-16 they are
   699 and 518 lines and the largest are `cache/cache.ts` 1,583,
   `cli/watch.ts` 1,121, `orchestrator/run.ts` 1,040 and
   `exec/sandbox-runtime.ts` 1,034, each one concern (the split of
   cache.ts is item 8's), so the note is closed; (e) REFUTED: a discovery memo keyed on directory and
   manifest stats saves ≈ 3–4 ms of a 230 ms run for a second staleness
   surface — revisit only if discovery's share grows; (g) `vx why` shows
   a plugin `key` part's digests, not its material, because a raw
   column is a `SCHEMA_VERSION` bump or a persisted secret — revisit
   when a plugin's part is the thing people debug.

9. Superseded by 14 (items 70–80 landed as PRs #269–#271, 2026-09-10).
10. Superseded by 14 (items 81–95 landed as PRs #272–#273, 2026-09-10).
11. Superseded by 14 (the survey and parity rounds, items 96–111, 2026-09-10).
12. Superseded by 14 (items 102–112 landed as PRs #275–#279, 2026-09-10).
13. DONE 2026-09-10 as item 120 — `vx watch` watches the projects a cycle can run.
14. The handoffs after items 153, 130, 166, 170, 176, 183, 189, 192,
    197, 202, 208, 211, 214, 221, 225, 230 and 236 (14–14p) are in
    `docs/history/2026-09-status-next-log.md`; 14q–14s below are the
    current ones.

14q. **Handoff after item 240 (2026-09-16, night).** Four items since
14p. `vx watch` no longer re-runs on a git-ignored path and names a
file the cycle rewrites every run (237, #403 — its macOS job taught the
streak to read the path's mtime, its Linux job replaced the run-lock
e2e's head start with a marker). Three configuration personas (238,
#404): `vx info` names a broken config once, an empty workspace hears
about its globs, and two gate findings rode along — the plugin
helper's sweep skips a root it cannot remove, and a fixture with no
`node_modules` made Bun auto-install a missing import from the
registry, which became Next 21 and then item 239 (#405): a config's
bare import nothing provides is refused before evaluation. Its cost,
measured after the fact, was 130 ms per 1,000 cold configs; 240 took
it to a tie (one transpiler per loader, a textual pre-filter). Measured
and clean on the way: the renderer on a 200,000-line task, the
detached spawn of 236, every MCP tool during a run, a task's own env
variables (documented), watch with `--affected` (the same refusal as
run). Open: Next 1, 2 and 16, all gated by their own terms; In-flight
5 (macOS); the owner residue — the `NPM_TOKEN` secret, the release
cut, the site's address (an install script waits on it);
`workspaceFiles` stops at a nested repository. The loop holds 38 items
(203–240): the trim's trigger is forty. No open issues. The box: as
14p; a root-run local suite leaves plugin roots the `probe` shards
cannot remove — sweep `/tmp/vx-plugin-pkgs-*` as root before a gate.
Methods that paid: a cost measured after shipping is still a cost —
the A/B belongs in the item, not the handoff; a same-tree stub A/B
isolates one function's cost from every other difference between
arms; when medians and mins disagree, the spread is the finding, and
the micro-benchmark decides what the number can be. Never end with
"what next?".

14r. **Handoff after item 242 (2026-09-16, night).** Two items since
14q, one persona carried on (a minimal image): a machine without git
gets one line at every git site (241, #407), and one without `sh` sees
why its task failed, inside the frame (242) — the runner's
spawn-failure text had no reader, and `runner.md` claimed it did. The
gate on 241 found the restore-interruption test's deleter losing its
race under load (2 in 60; a synchronous sweep now, 0 in 60; recorded
under 215). Items 203–242 moved to
`docs/history/2026-09-improvement-loop-203-242.md` with handoffs
14j–14p to the next-log file; the loop starts again at 243. Open:
Next 1, 2 and 16, all gated by their own terms; In-flight 5 (macOS);
the owner residue — the `NPM_TOKEN` secret, the release cut, the
site's address. No open issues. The box: as 14p. Methods that paid: a
result field nothing reads is a claim, not a channel — find the
consumer before trusting the doc; a race test's other process must
strike inside the window by construction, never by polling; a
persona's next missing binary is the next item. Never end with "what
next?".

14s. **Handoff after item 252 (2026-09-16, late morning).** Ten items
since 14r, merged as #409–#415, from two lenses walked to their ends.
The minimal image: a temp directory that is missing or not writable
names TMPDIR in the sandbox verdict and the run-lock line, and a
socket path past `sun_path` is refused up front with the limit (243,
the darwin job taught the second shape); the `cache.inputs.runtime`
probe names the shell (244); the sandbox's three Linux dependencies
and the install (246 — the docs had named two); `vx upgrade` with no
route names the host (247); a root without `workspaces` beside
packages full of scripts names them and the glob to add (248). The
CI container was clean and is pinned end to end (249). The plugin
author: a malformed executor result (251) and a remote layer's wrong
shape (252) are named as the plugin's bug, never a TypeError or a
corrupt artifact. Housekeeping: the day's warm-path A/B, a tie (245);
oxfmt, oxlint and the sandbox runtime current, two REAPI majors left
(250). Open: Next 1, 2 and 16, all gated by their own terms; In-flight
5 (macOS); the owner residue — the `NPM_TOKEN` secret, the release
cut, the site's address. No open issues. The box: as 14p; a manual
`su probe` needs `PATH=/opt/probe-bin:$PATH` or the sandboxed server
task's `bun` is not found and the port-bridge tests fail for the
invocation, not the code (250). Methods that paid: a runtime's own
error text is a path and no knob — name the knob; a walk of one
persona's missing pieces (git, sh, tmp, deps, network, globs) finds
one item per piece, and each item's class is grepped in the same
commit; a probe that confirms a thesis becomes a pin with a control
that proves the pin can fail; a seam's resolved value is a boundary
like its factory's. Never end with "what next?".

14t. **Handoff after item 263 (2026-09-16, midday).** Eleven items
since 14s, merged as #416–#424. One persona walked to its end — the
reader of a failure — and the shard weights refreshed on the way
(253). The shell's own line on exit 127 and 126 names the word and
nothing about why: the PATH vx built (257), the file itself — missing,
a directory, no execute bit, a CRLF or missing `#!` interpreter, no
`#!` line (258; macOS's bash 3.2 names a bad interpreter itself and
exits 1, pinned per platform) — and above 128 the signal and its usual
sender, the OOM killer, a crash in native code, an abort, a closed
pipe (259). The second-day reader then: `vx last` (260), the GitHub
job summary (261, `exitSignal` on the façade by the rule
`escapeMarkdownCell` set) and one `failedLabel` for the frame footer,
the status line, the run report and the Actions annotation (262). The
day's warm-path A/B is a tie (263). Open: Next 1, 2 and 16, all gated
by their own terms; In-flight 5 (macOS); the owner residue — the
`NPM_TOKEN` secret, the release cut, the site's address. No open
issues. The loop holds 21 items (243–263): the trim's trigger is
forty. The box: as 14p; `git cherry-pick` has no `-q`, and a chain
that assumed one stopped before its push (260) — check `git status`
after any chain that a usage line could break. Methods that paid: a
shell's exit code is three shells' conventions, not one — dash, bash 5
and bash 3.2 each got a probe before the pin; a line that names a
cause must read the evidence (the file, the runner's signal) or say
"or the command exited so itself"; a number rendered on four surfaces
is one function or it drifts; a differential's name filter must match
every pin it counts (a `-t` that matched one of two read as a broken
fix, 260). Never end with "what next?".

14u. **Handoff after item 270 (2026-09-16, afternoon).** Seven items
since 14t, merged as #425–#431, one class walked to its end: the
reason a task failed rides the outcome and every surface reads it.
First the docs that show what a reader sees: the plugins guide names
the façade's sink helpers in a type-checked block (264) and the CI
guide's job summary is the renderer's real output with a pin that
renders the same run (265; the guides' other two samples matched). Then
the reader of a skipped task: a Skipped footer section (266) and the
root blocker recorded on the outcome for the summarize row, the
telemetry record, the GitHub callout and the OTel span (267 — the OTel
losslessness tripwire refused the field until it was mapped, as it
should). Then every other reason the one `failedLabel` read as a bare
number: vx's own timeout (268), sandbox violations (269, where the
OTel guide had promised an attribute the plugin lacked), and a
persistent task that never became ready (270, a typed
`PersistentReadyError` and the child's real exit code). Each rides the
outcome as an additive telemetry field; the `runs` table carries none
of them, since a column is a `SCHEMA_VERSION` bump that resets every
local cache — the day one is worth it, they all go in together. Open:
Next 1, 2 and 16, all gated by their own terms; In-flight 5 (macOS);
the owner residue — the `NPM_TOKEN` secret, the release cut, the
site's address. No open issues. The loop holds 28 items (243–270): the
trim's trigger is forty. The box: as 14t; a Python edit script asserts
on anchors the formatter has since reflowed — every write after the
failing assertion is skipped while the earlier ones land, so check
`git status` and re-run from the failure (twice today). Methods that
paid: a claim in a guide ("the span carries X") is grepped in the
plugin before it is trusted; a made-up exit code (a skip's 1, a
never-ready 1) is a lie the label repeats on every surface — carry the
reason and the real code; the same one function on every surface is
what makes a class of fixes a class; a differential's guard reads
bun's summary line, not its per-test lines. Never end with "what
next?".

15. DONE 2026-09-11 as items 142–144, 150 and 152 — five Nx repos
    (query, strapi, novu, router, refine), the owner's 3–5. Was: **More Nx repos.** The five Turbo build sets, the two wide sets
    (item 141) and four Nx repos (items 142–144, 150) are in.
    Both gaps from the first Nx repos (item 142) are closed: `.mjs`
    output is item 145, two targets on one output path item 146. Then the harness on more
    Nx repos (owner: 3–5 popular ones; only
    `nx:run-commands`, `nx:run-script`, a plain `command` and
    `nx:noop` targets are supported, anything else is out): the
    remaining candidate was storybook (483 targets inheriting a plain
    `command`; its placeholders and root cwd map since item 147): its
    install does not fit this box — the fetch step filled the 6 GB
    left on the disk with the yarn cache alone (ENOSPC, 2026-09-11) —
    so it waits for a bench host with room; redwood is dropped — its
    `build` declares no outputs, so Nx's cache replays the log and a
    restore arm restores nothing under either tool (REPOS.md). Parity
    is the task graph as above.

16. **Two cached tasks on one output path, when one depends on the
    other.** Two of the five Nx repos have it: strapi's `build:types`
    and refine's `types` write `dist/**/*.d.ts` into the `dist` their
    package's `build` fills, and both declare `dist` as the output of
    both targets; Nx caches both, vx leaves the dependent one uncached
    (item 146 resolves the overlap at migration time). What blocks it
    is the clean: vx removes a task's declared outputs before it runs
    and before a restore, so a `types` miss under a `build` hit would
    delete the `dist` that `types` reads. A design that admits it:
    when B's outputs overlap A's and B depends on A, B's own output
    set is the files its run ADDED or CHANGED (a snapshot of the
    overlap before B runs, diffed after — size + mtime, the proof the
    hit path already trusts), B's clean removes only that set, and B's
    artifact holds only that set; the restore order follows the edge.
    Cost: one stat walk of the overlap per B miss, none on a hit. The
    catch, seen while writing this: refine's `types` ADDS nothing —
    `build` is `tsup && node ../shared/generate-declarations.js` and
    `types` is the second half again, so it REWRITES `build`'s `.d.ts`
    files with the same bytes and new mtimes. Under the design above
    B's own set is empty (same bytes) but A's proof is size + mtime,
    so the next no-op finds A's outputs moved and restores them — a
    restore where there was nothing to restore, every run. Either the
    proof compares content for files a downstream task touched (a hash
    per overlapped file, the cost the proof avoids by design), or a
    rewrite-in-place stays refused and only additions are admitted.
    strapi's `build:types` (tsc into the `dist` rollup filled) is the
    addition case; refine's is the rewrite. Not started; do it if a
    third repo shows the addition shape, with the design note first
    (`docs/design/`), and leave the rewrite refused.

17. DONE 2026-09-12 as item 158 — the producing execution's usage rides
    the artifact's sidecar; a hit's entry is the history's record.
18. DONE 2026-09-15 as item 176 — measured a 21% loss (132 vs 160 s
    on 92 builds); cores are declared, never learned.

19. DONE 2026-09-16 as item 216, as a per-RUN lock (the per-task grain is a refinement, see 216). Was: **A per-task lock for two runs on one workspace (from item 215).**
    Two vx processes that clean and restore the same output tree race;
    today the loser fails plainly ("was interrupted … another vx run").
    A per-task advisory lock (`flock` on `<cacheDir>/locks/<taskId>`,
    taken around clean + restore or execute, released with the task)
    would make the second run wait for the first and then see its
    outputs current. Cost to measure before shipping: one open + flock
    per task on the warm path (expected microseconds against a 0.2 ms
    task floor), and what a waiting run prints (the admit-held line's
    shape, item 171). Not started.

20. DONE 2026-09-16 as item 229 — the retained copy is bounded (8 MiB head + 8 MiB tail, the middle named). Was: **A task's captured output has no cap.** Measured 2026-09-16
    (item 225's probe): a task printing 200 MB costs vx 620 MB of RSS
    on the miss AND on every hit (the string, its encodings, the row),
    and its stdout lands in `cache.db` whole — 193 MB of `.vx/cache`
    beside an 18 KB `tar.zst` that holds the same bytes compressed —
    since the replay reads the row, not the archive. A realistic chatty
    suite is 5–20 MB (62 MB of RSS, a 20 MB row), so this is an
    outlier's cost today. When it is not: bound what a task's capture
    RETAINS (chunks, a head and a tail, the dropped middle counted and
    said in the replay — `[vx] … 180 MB of output not kept`), store
    the same bounded text once, and measure RSS per chatty task before
    and after. Not started; the number that decides is a real
    workspace whose logs pass ~50 MB per task.

21. DONE 2026-09-16 as item 239 — refused before the evaluation, the install named. Was: **A config's bare import that no `node_modules` can serve reaches
    the npm registry before it fails.** Bun auto-installs a package a
    module cannot resolve when no `node_modules` exists above it —
    measured 2026-09-16: sixteen connections to the registry and 150 ms
    before "cannot find", and a sandbox violation on the macOS job; with
    a `node_modules` present, 0 connections and 1 ms; `bun --no-install`
    stops it too. A fresh clone before its install, or a typo in an
    import, should be refused by vx before evaluation: `config-imports`
    already lists a config's specifiers, so a bare one with no
    `node_modules/<name>` above the config is a `UserError` naming the
    install, never an import. Not started; the pin is a config importing
    a name no `node_modules` serves, evaluated with no network.

## Decisions (this arc)

- **Resources are the schedule plugin's (owner, 2026-09-12).** Core
  gates on the worker count and asks the `admit` stage for anything
  finer; it holds no per-task cores or megabytes, no config field for
  them, no budget flag. What a task needs is learned from what it used
  (`@vzn/vx-schedule-history`), or declared to that plugin. Item 157.
- **No first-party technology plugins (owner, 2026-09-10).** A plugin
  that gives packages tasks from a framework's config (`vite()`,
  `next()`, …) is the community's to write on the `project` stage; core
  names no tool, and this repo ships no such plugin. `turbo()` in
  `@vzn/vx-migrate` is an adoption plugin, not a technology plugin, and stays.
- **Windows is WSL (owner, 2026-09-10).** vx spawns POSIX shell and ships
  linux / darwin binaries; a Windows developer runs it under WSL, and the
  docs say so instead of listing Windows as a gap.
- **One core per process (2026-09-10).** The running `vx` serves its
  own façade to every `@vzn/vx` import it evaluates. A plugin package
  never carries its own copy of core into a run; the host decides the
  runtime, as any host does. Item 77.
- **The façade names only what has a consumer (2026-09-10).** An
  export written for a consumer that no longer exists is a promise
  nobody collects and a surface nobody may change; item 78 took 41
  of them off. Core keeps every function behind its module contract;
  a new consumer widens the façade deliberately, with the pin.
- **No seam without a consumer (2026-09-10).** The `CASBackend` /
  `Digest` substrate left core after three months with zero callers
  (item 74). A content-addressed view of the artifacts directory comes
  back when a plugin needs it, shaped by that plugin's use — not
  before. The same rule retired `recordRun` / `recordRuns` from the
  layer contract (item 72).
- **Merge your own PR once it is green (owner, 2026-09-10, "Merge
  whenever you own the project").** The session's PR flow stays
  (branch, PR, CI), but a green, mergeable PR no longer waits for the
  owner's word; the next PR starts from the merged main.
- **A plugin's name is its package name; no overrides (owner,
  2026-09-10).** `definePlugin(import.meta, hooks)` reads it and stamps
  it; the workspace loader refuses anything else. Item 69.
- **Gap audit vs Nx 23 / Turbo 2.10 (2026-09-04, owner's ask).** Core
  is at parity or ahead on every must-have a developer would miss
  (graph, filter DSL superset, affected, strict caching, env
  isolation, persistent readiness, watch, prune, migrate, init, dry /
  graph / summarize / profile). The one game changer left is
  zero-config adoption — scripts as tasks with no generated file —
  whose mapping is a `project`-stage plugin and whose core half is one
  seam widening (§ Next 3). `.env` loading, configurations, cache caps,
  graph UI, release, test splitting, boundaries: plugin or the
  language. Windows is the only must no plugin can supply; parked.
  Full table in `docs/comparison.md` § Gap audit 2026-09-04.
- **Agents removed.** `@vzn/vx-agents` (synchronizer + persistent
  workers, Nomad/K8s backends) was an in-repo distributed-execution
  product. It used only public core APIs (`run`, `createEventBus`, the
  executor seam), which is the proof the seam suffices — so it lives
  outside this repo, if anywhere.
- **Predictive scheduling removed.** Opt-in, measured at ~280 ms of
  history loading on a large cache (more than a warm run), and a
  scheduler-priority policy is exactly what a plugin hook should decide.
  The scheduler keeps its `priorities` input; a `schedule` seam will feed
  it.
- **`vx mcp` removed; `metrics.ts` trimmed.** The MCP server read the
  dashboard-era analytics queries and predictive history. An MCP server
  is a good plugin (`commands` seam), not core. The queries `vx why` /
  `vx last` need stay in `metrics.ts`; the rest went.
- **`vx why` / `vx last` stay.** Cache-miss explainability is a core
  promise; both read the local run history core already writes.

## Legacy map (what the old memory called things)

- `docs/design/decision-log-archive.md` held the full 2026-05→08 log; it
  is deleted from the tree (git history: `git log -- docs/design/decision-log-archive.md`).
- "waves" = the old audit cycles. Their standing rules survive in
  `CLAUDE.md` § Rules.
