# Shipped, 2026-09 — improvement-loop items 243–281

The record `docs/STATUS.md` carried until 2026-09-16, moved here whole
so the handoff stays readable. Nothing below is current state: STATUS
holds direction, what is in flight and what is next; this file holds
what shipped and the numbers behind it. Items 1–64 are in
`2026-09-review-arc.md`, items 65–104 in
`2026-09-improvement-loop-65-104.md`, items 105–144 in
`2026-09-improvement-loop-105-144.md`, items 145–202 in
`2026-09-improvement-loop-145-202.md`, items 203–242 in
`2026-09-improvement-loop-203-242.md`, items 282–305 in
`2026-09-improvement-loop-282-305.md`, items 306–332 in
`2026-09-improvement-loop-306-332.md`; items 333 onward continue in
STATUS under the same numbering.

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
272.  DONE (2026-09-16, Next 6 — the day's closing diff on the warm
      path): after #425–#431 (264–271: the outcome fields and the one
      `failedLabel` on every executed task's exit path, the Skipped
      footer on every run), the interleaved A/B on one 1,000-project
      workspace, the main of 263 (#424) in an immutable worktree
      against the head of 271, 9 reps each, run twice with the arms
      swapped: after 253 / 266 and 254 / 266 ms (min / median), before
      257 / 266 and 252 / 264 — a tie. Expected, as at 263: a warm run
      executes nothing, and the footer's Skipped section is one filter
      over the outcomes (0.022 ms on 5,000, item 266).
273.  DONE (2026-09-16, the day the columns were worth the bump): four
      items (267–270) each left the `runs` table without its reason —
      "a column is a `SCHEMA_VERSION` bump that resets every local
      cache; the day one is worth it, they all go in together" — and
      the readers that lacked them were the second-day ones, `vx last`
      and an agent on `vx mcp`'s `getRunHistory`, which read a bare
      exit code for a never-ready server and `skipped` for a task a
      failure blocked. One bump, `v26` → `v27`, four nullable columns
      (`blocked_by`, `timed_out`, `sandbox_violations`, `not_ready`),
      bound from the run row, read by `listRuns` and the MCP query; a
      `vx last` row ends with the reason in place of the signal part
      (`timed out`, `never ready: exited`, `2 sandbox violations`,
      `after lib#build failed`), and a `getRunHistory` row carries the
      same fields with its exit code, absent where no reason applies.
      Pinned by a round trip of every column against a null row
      (metrics), end to end in `last.test.ts` (a timeout, a never-ready
      server, a skip), and on the MCP row. The three quoted copies of
      the version follow their pins; the skill file that still said
      `v24` says `v27` and why a schema bump is rare.
274.  DONE (2026-09-16, Next 6 — the schema bump on the warm path):
      273 (#432) touches every task a warm run records — four more
      bound columns per `runs` row — and resets the index once, so
      the A/B took one 1,000-project workspace copy per arm, each
      pre-warmed by its own arm (arms on different `SCHEMA_VERSION`s
      reset a shared copy): the main of 272 (#431) in an immutable
      worktree against the head of 273, 9 reps each, run twice with
      the arms swapped. Before 245 / 253 and 240 / 245 ms (min /
      median), after 244 / 254 and 238 / 244 — a tie. Expected: the
      row's insert is one prepared statement either way, and four
      nulls bind in the noise of a 1,000-row transaction.
275.  DONE (2026-09-16, the class's last surface): the frame's skipped
      header read `skipped (upstream failed)` — a claim, and false
      under fail-fast, where the run stopped and nothing blocked the
      task — and no logger path reached it anyway: every flow prints
      a skipped task as the one-liner, which said `skipped` and
      nothing else, so the reader scrolled to the Skipped footer for
      the blocker the outcome already carried (267). One
      `skippedLabel(blockedBy)` beside `failedLabel`: the one-liner
      ends `• blocked by lib#build` (nothing for a fail-fast skip),
      the block header and footer and the `--report` status cell read
      `skipped (blocked by lib#build)`, and `blockedBy` rides
      `OutcomeView`, which had every other reason but this one, so
      an embedder's `task:complete` sees it too. logger.md claimed a
      skipped requested task "is framed"; it never was.
276.  DONE (2026-09-16, the second first-run walkthrough, 14v's
      next): a fresh two-package workspace (`@acme/lib`, `@acme/app`
      depending on it, five scripts), git-initialised, under the
      source binary: `vx init` (three tasks clean, two cache TODOs,
      the next command named), the run it named (`no-cache`), the
      TODO's block applied (a miss, then `up-to-date`), `vx why` on
      the hit (key unchanged) and after an edit to lib's source (the
      changed upstream named with both keys), `app#build` made to fail
      under `vx run test --all` — the frame's `failed (exit 3)` with
      the command and its stderr, the footer's Skipped section, the
      `--report-file` table with `skipped (blocked by @acme/app#build)`
      (275), `vx last` with `after @acme/app#build failed`, `vx info`
      with `keys vx-cache-v27 · index schema v27` — then the same task
      from inside `packages/app` (focused: the one-liner with its
      blocker), a typo'd task, a typo'd filter, a bare `vx run` off a
      TTY, `vx show` and bare `vx`. Every surface read right; nothing
      to fix, and the pins that hold each are the loop's own. Three
      things read as findings and were not: the report's headline
      counts a hit under `success` AND `cached` (five numbers on four
      tasks) — deliberate and pinned, "success says how a task ENDED,
      cached where the result CAME from", where the GitHub summary's
      buckets are disjoint; a skipped `vx last` row's `no-cache` states
      the task's config, not a cache decision it never reached, and is
      true; and "No projects declare task(s): buidl" carries no
      `vx run:` prefix because it is `run()`'s line, which `watch` and
      an embedder call too — the verb is not its to name.
277.  DONE (2026-09-16, the reference's one picture of a run, read
      against the renderer after 276): `docs/cli.md`'s broad-run sample
      had drifted three ways — the rule's label sat at the right end
      where the renderer leads with it (`─ vx 0.0.0 ───…`), the time
      line read `5.34s (max … · avg … · min …)` where the renderer
      joins with `·`, and its spread averaged the hit's 4 ms restore
      in, the very pollution the spread excludes by design (one
      executed task is its own max, avg and min). The block is now the
      renderer's output for that run, bars included (the annotated
      bars moved to a sentence under it), and a pin in
      `cli-doc-drift.test.ts` renders the same two outcomes and footer
      and compares byte for byte, as 265 did for the CI guide.
      `modules/summary.md` and the output audit already carried the
      current shape; the site's copy is generated from this file.
278.  DONE (2026-09-16, the class of 277 — the second picture): the
      frame anatomy in `docs/cli.md` and `modules/framed-output.md` was
      a sketch of a frame the renderer stopped printing — a
      `├─ command` label where the command is a bare dim `$ cmd` line,
      lowercase `├─ stdout` where the sections read `├─ STDOUT ──…`
      with a blank line above and below their content. The reference
      now shows one real failed block with every section (command,
      stdout, stderr, a sandbox violation) and says what makes each
      appear; the module doc's sample and bullets follow the renderer;
      a second pin beside 277's renders that block and compares byte
      for byte. Found by reading the walkthrough's real frame (276)
      against the page that describes it.
279.  DONE (2026-09-16, the class of 277–278, the last sweep of the
      output docs): `modules/status-line.md` described a Failures zone
      pinned above the worker rows — `✗ <id> ── failed (exit N)`, five
      then `… +K more failed` — that the region no longer has: its
      state pins persistent tasks only, and a failure is the permanent
      `◼` row logged the moment it happens (`formatFailureLine`), its
      frame deferred to runEnd. The page now says so; four logger
      comments that called the row a "✗ marker" say `◼` row (the
      owner's quoted design line keeps its ✗). Found by grepping the
      docs for the shapes 277 and 278 retired: no README, guide or
      blog post carries them, and this was the one claim left.
280.  DONE (2026-09-16, the second-day reader at scale — the question
      276's two packages could not ask): `vx last` after a red run on
      the 1,000-project bench workspace (one leaf broken, the whole
      graph requested) was 1,002 lines — the failure first, then 996 `cache-hit`
      rows, so the terminal showed hits and the one row that mattered
      sat a thousand lines above the prompt. The rows are now a pure
      `formatTaskRows`: failures, then what executed or was skipped,
      then hits, and past sixteen hits the rest fold into one line with
      their count and where every row is (`--format json`); the
      sixteen shown are the slowest restores, the one thing a hit's row
      tells. The skipped `install` groups the footer named did not
      appear in the replay at all — a group is not a recorded run —
      and the footer's tasks legend showed no `skipped` for them
      either while its Skipped section counted three: recorded here,
      not chased (a group never starts by definition).
281.  DONE (2026-09-16, the mismatch 280 recorded): the footer's
      Skipped section listed three blocked `install` groups as "3 tasks
      never started" while the tasks legend beside it counted no
      skipped task — every counter (the tally, `--summarize`, the
      report, the run records) excludes a group, and the section was
      the one reader that did not. It now does: a group never starts
      by definition, and its members' rows say what was blocked.
      Pinned with a control (the same skip on a task with a command
      is listed); cli.md says so.
