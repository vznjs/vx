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
handoffs 14g–14i to the next-log file), so this file stays the handoff
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

203.  DONE (2026-09-16, the root-in-a-container persona): a task
      declaring `exec.sandbox` on this box fails with a precise line
      (the runtime's seccomp helper cannot create its nested user
      namespace as root inside a container; run as non-root or set
      `sandbox.weakerWhenNested`), but `vx info` said nothing about the
      sandbox at all, so the first sign was a failed run. The doctor
      has a `sandbox` fact now — the runtime probe's verdict (one
      sandboxed `true`, memoized, the Linux runtime reset afterwards so
      its proxy sockets do not hold a standalone process open) and how
      many loaded tasks declare a sandbox — rendered as one row,
      "available" with the declared count or "unavailable" with the
      probe's reason and the count that will fail; `--format json` and
      the MCP's `getWorkspaceInfo` carry it as data. Pinned in
      `show-info.test.ts` (either verdict, the fixture's zero count) and
      documented in `docs/cli.md` § vx info. CI's first run added a
      rule: inside the sandboxed test shard the runtime cannot listen on
      its mux socket, and the raw error quoted a path named after the
      process id, so two `vx info` runs differed by one number and the
      `vx stats` byte-identical alias pin failed — the doctor's text is
      pasted into bug reports and compared between invocations, so its
      reason drops the pid (`stableSandboxReason`, pinned with a
      control). No other pin compares two invocations byte for byte.
204.  DONE (2026-09-16, the same persona, one step further): the docs'
      advice under that verdict — run as a non-root user — was taken
      on this box (a `probe` user, bun copied where it can read it):
      a sandboxed task runs and `vx info` reads `sandbox: available`,
      so the reason line's first remedy holds where it is given. The
      probe's scratch workspace also had a config error, and the row
      read "0 tasks declare exec.sandbox" beside a project declaring
      one: when the shared load throws, the doctor falls back to a
      per-config count that tallied tasks but not sandboxes. The
      fallback counts both now, by the rule the docs already state (a
      config that will not load counts as zero, the rest count).
      Pinned in `show-info.test.ts`: a broken config next to a
      sandboxed project reads 5 tasks and 1 declared, with the
      whole-workspace control at the same numbers; fails without the
      fix (declared 0).
205.  DONE (2026-09-16, the gate as CI runs it, on this box): until now
      the sandbox suites ran on CI alone — the container is root, the
      runtime refuses a nested user namespace, and the local gate runs
      the tasks directly. As an unprivileged user the box hosts the
      whole thing: `vx run ci --all` with `VX_REQUIRE_SANDBOX=1` on a
      cold, user-owned copy of the repo, every shard sandboxed, 44 of
      44 in 99 s; the unsafe set 78 pass, 0 fail, 1 darwin-only skip
      (the nested-seatbelt group), `sandbox-runtime` 49 of 49. Recipe:
      a user (`probe`), a COPY of bun under a world-readable path that
      is on PATH under the name `bun` (fixtures run `bun serve.ts`; a
      differently named copy exits 127 inside the sandbox), `HOME` set,
      `cp -a` the repo and drop its `.vx`, `chown` the copy. Two traps,
      each a real failure before it was understood: (1) `bun --bun`
      links `node` to itself under `/tmp/bun-node-<build>/`, mode 0700,
      owned by whoever ran first — a second user gets no shim and no
      word of it, so `bun --bun astro build` ran the PATH's Node 20 and
      astro refused it; remove root's directory before the run. (2) A
      root-owned `dist/` left in the copy by a root control run made the
      output clean an "internal error" — item 206. The session's manual
      gate runs the unsafe step this way now; the user and the bun copy
      are box-only and die with the container, the recipe is here.
206.  DONE (2026-09-16, from 205's second trap): a declared output the
      process cannot remove (a `dist/` another user wrote, a read-only
      checkout) surfaced as `[vx] internal error in @vzn/vx-docs#build:
EACCES: permission denied, rm '…/dist/_astro/array.js'` — the
      scheduler's label for any error that is not a `UserError`, which
      sends the reader to file a bug against a permission bit. Both
      clean paths (`cleanOutputs`, `cleanWorkspaceOutputs`) raise a
      `UserError` now: `cannot remove declared output dist/a.js: EACCES
— vx clears a task's declared outputs before it runs and before a
restore; make the path removable by this user, or stop declaring
it as an output`. Pinned in `inputs.test.ts` on a 0o500 `dist/`,
      skipped as root (root removes anything; CI's runner is not root)
      and proven both ways here as the `probe` user; `docs/caching.md`
      names the failure beside the clean contract. The clean runs on
      the hit-restore path, so Next 6 on this head: 1,000 projects 244
      ms warm / 700 restore / 2,570 cold (medians of 5; the morning's
      237 / 744 / 2,520) — a `.catch` per removed file is inside jitter.
207.  DONE (2026-09-16, the class of 206 grepped as the `probe` user):
      the task path touches the tree three times — clean, restore,
      save — and each was asked what it says to a tree it may not
      write. Save was already right: an output the process cannot read
      warns `cache save failed: EACCES …` and the task succeeds
      unsaved. Restore was not: a hit into an empty `dist/` this user
      cannot write into read "internal error" with a
      `CorruptArtifactError` (not a readable archive), the artifact
      intact. The extract's catch already names what is on disk for
      the shape codes (`EISDIR`, `ENOTDIR`, `EEXIST`, `ENOTEMPTY`);
      `EACCES`, `EPERM` and `EROFS` join it as a `UserError`, "restore
      of <hash> into <dir> could not write its outputs (EACCES: …)".
      Pinned in `cache.test.ts` on a 0o500 `dist/` (skipped as root,
      proven both ways as `probe`); `docs/caching.md` names it beside
      the clean's line. Refuted on the way: `chmod 500 .vx` alone
      proves nothing — the cache's files sit in subdirectories already
      created, so the run saved as before; an unwritable cache
      directory is a separate probe, not taken.
208.  DONE (2026-09-16, that probe taken, as `probe` with the whole
      `.vx` read-only): every task failed at 0 ms, warm hits included,
      as an internal error carrying SQLite's "attempt to write a
      readonly database" — the command never ran — and with only the cache's
      own files read-only the run went to its end and died there in
      the history write, a stack on stderr. Every run writes the cache
      (its record at the end, `accessed_at` on a hit, the artifact on a
      miss), so the run's cache open asks the file system first: the
      directory and, when it exists, `cache.db` must be writable
      (`accessSync`, two calls, 1.8 µs), else a `UserError` names the directory
      and `--cache-dir <path>` before the graph starts. Refuted on the
      way, twice: a trial write inside `BEGIN IMMEDIATE … ROLLBACK`
      passes on a handle SQLite opened read-only — the write lock alone,
      and then a rolled-back `UPDATE` too, because under WAL a rolled-back
      page never reaches the disk — so the check is the file system's,
      not SQLite's. Pinned in `cache.test.ts` (unit, with a writable
      control) and `cache-dir-selection.test.ts` (the CLI: exit 1, the
      one line, no task ran), both skipped as root and proven both ways
      as `probe`; `docs/cli.md` (`--cache-dir`) and `docs/caching.md`
      (§ Storage layout) say it. Read-only verbs (`vx info`, `why`,
      `last`) open the cache without the check and keep working on a
      read-only cache, as they did.
209.  DONE (2026-09-16, 208's last sentence tested rather than
      believed): the readers kept working only while every config was
      warm in the evaluation cache. With the config changed and the
      cache read-only, `vx show` died with SQLite's "attempt to write
      a readonly database" on the eval cache's store or the
      file-hash memo's upsert, whichever came first; `vx info`
      survived only because the doctor swallows a load error and counts
      loadable configs instead, `why` and `last` read history and never
      evaluate. The cache now decides at open whether the directory is
      writable (the same two `access` calls) and, when it is not, opens
      with the local WRITE axis off: the config-evaluation store already
      honoured it, the file-hash memo does now, and the `.gitignore`
      write is skipped; a run still refuses through `assertWritable()`,
      which reads that decision. Pinned in `cache.test.ts` (a read-only
      cache: `putConfigEval` and `hashFile` throw nothing and store
      nothing) and `cache-dir-selection.test.ts` (`vx show` on the
      workspace's own read-only cache with a changed config exits 0 and
      lists the project — it takes no `--cache-dir`, so the workspace's
      cache is the one that stops being writable), skipped as root and
      proven both ways as `probe`; `docs/caching.md` says it.
210.  DONE (2026-09-16, the read-only checkout, the persona 206–209
      kept naming, walked as `probe`): with the workspace root not
      writable and no cache yet, every verb died in the cache's
      `mkdirSync` with a raw stack — the readers included — and the
      lock and init verbs died the same way writing `vx-lock.json` and
      `vx.workspace.ts`. Two fixes, one general: the cache constructor
      names an uncreatable directory with its three remedies (the
      workspace writable, the `cacheDir` field, `--cache-dir`), and the
      CLI's top level and the scheduler's error branch treat a file
      system refusal (`EACCES`, `EPERM`, `EROFS`; `isPermissionError` in
      `util/errors.ts`) like a `UserError`: one line, the path, a hint,
      no stack — so the next tree write nobody wrapped reads right
      without a fourth special case. Pinned: the rule as a unit with
      controls (`ENOENT`, a plain Error carrying the word, a
      `UserError`, a non-error), the constructor on a sealed parent
      (`cache.test.ts`), and the CLI on a 0o555 workspace root (the
      show verb names the cache directory and `--cache-dir`, the lock
      verb names the lockfile, neither prints a frame) — the last two skipped
      as root and proven both ways as `probe`; `docs/cli.md` (§ vx run)
      and `docs/caching.md` say it. Next 6 on this head, after 206–210
      put two `access` calls, a guarded `mkdir` and one axis check on
      every run's cache open: 1,000 projects 232 ms warm / 711 restore /
      2,542 cold (medians of 5; the morning's 237 / 744 / 2,520, midday's
      244 / 700 / 2,570) — inside jitter, as the microseconds said.
      Considered and declined: a doctor that prints the facts it can
      when the cache directory cannot be created. Its one line is the
      diagnosis, and the alternative is a nullable facts shape that
      every `getWorkspaceInfo` consumer would have to learn for a
      persona whose fix is a `chmod`.
211.  DONE (2026-09-16, the full disk — a 2 MiB tmpfs mounts here, so
      the persona is hostable; walked as `probe`): a save that runs out
      of room already said `cache save failed: ENOSPC …` and let the
      task's work stand, but a hit's restore onto a full workspace disk
      fell through to "internal error … CorruptArtifactError: artifact
      is not a readable archive" — 207's mislabel with a different code
      — and a green run on a full cache disk printed its summary and
      then died in the history write, SQLite's "database or disk is
      full" with a stack, exit 1 over "1 success". Three changes:
      `ENOSPC`/`EDQUOT` join the refusal class (`isDiskFull`,
      `isFsRefusal`, a hint per kind) at the CLI's top level and the
      scheduler; the restore names a full disk with its own remedy
      ("Free space on that disk and re-run"); and the run record is a
      status line when it fails ("run history not recorded: … — the
      verdict above stands") — history is observability, and a run's
      exit is its tasks'. Pinned as units with controls
      (`user-error-classify.test.ts`) and end to end in
      `disk-full.test.ts` on a small file system named by
      `VX_SMALL_DISK`: a hit whose restore cannot write (the line, no
      "internal error", no "corrupt artifact") and a finished run whose
      record cannot be written (`--cache=local:r` leaves the record as
      the one write; exit 0, the line, no frame). Root is subject to
      ENOSPC like anyone, so no user switch is needed; the suite skips
      without the variable and CI's Linux job mounts a 2 MiB tmpfs and
      sets it, as the manual gate does — a gate on an env var CI sets,
      not a probe. CI's first run placed it: inside a sandboxed shard
      the mount was read-only (`EROFS` on the fixture's `mkdtemp`), a
      mount the sandbox did not make, so the suite is in the unsafe
      set — the tests a sandbox cannot host — and only that task passes
      the variable through. Both cases fail without the fix. The gate's first run caught the pin the change
      retired: `orchestrator-remote.test.ts` forced a record throw to
      prove `close()` still ran and expected the run to reject; it
      asserts the status line now, the close still. `docs/caching.md`
      and `docs/cli.md` say it.
212.  DONE (2026-09-16, the grid's last cell, as `probe`): the prune
      verb against a root-owned cache died in its first DELETE with
      SQLite's "attempt to write a readonly database" and a stack — the
      one writer verb left that opened the cache without asking. It
      asks now (`assertWritable()`, 208's check) unless `--dry-run`,
      which only reads and reads a read-only cache fine. Pinned in
      `cache-dir-selection.test.ts` (exit 1, the line, no frame; the
      dry run exits 0), skipped as root and proven both ways as
      `probe`. The other openers outside a run — the MCP tools, the
      schedule-history plugin, `why`, `last` — read, and 209 opens a
      read-only cache for them. `docs/caching.md` says it.
213.  DONE (2026-09-16, from the gate's own failure): a gate stopped
      mid-run left 255 of the sandbox runtime's mux sockets in `/tmp`
      (`srt-mux-<pid>-<seq>.sock`), and the next unsafe step, handed a
      recycled pid, met `EADDRINUSE` in the sandbox probe — every
      sandboxed task would have failed the same way after any killed
      run on a box that recycles pids. A socket file carrying THIS
      process's pid before the runtime is up can only be a dead
      process's, so `initSandbox` unlinks the contiguous run from seq 0
      (a stat per file, no scan of a `/tmp` that read 7,381 entries in
      9 ms here), guarded by a runtime-is-up flag that `resetSandbox`
      clears. Pinned in `sandbox-runtime.unsafe.test.ts`: a regular
      file at seq 0 under the current pid, and the probe succeeds and
      removes it; without the fix the probe dies on the listen. The
      manual gate clears the sockets itself too. The rest of a killed
      run's residue, checked while here: a save killed mid-write leaves
      `<hash>.tar.zst.tmp-*`, which the orphan sweep already reaps
      (refuted as a gap); the runtime's own `srt-obs-*` socket
      directories (removed on a normal stop, 186 left here by the two
      stopped gates, 4 KB each, random names, so not vx's to tell from
      a live sibling's) and its `claude-empty-*` mask directories are
      its lifecycle; and two stopped gates had left 6,537 test fixtures
      in `/tmp` (7,421 entries → 884 after the sweep) — a killed
      `bun test` leaks its fixtures, which is the test harness's, not
      the product's. Checked and left as they are, the two other doors
      the day's refusals could reach: the MCP server hands a tool's
      `UserError` back as an error result and any other error as a
      JSON-RPC error, and stays up either way; `vx watch` exits on the
      refusal with the same one line its initial run prints.
214.  DONE (2026-09-16, the deal re-weighed as `probe`): the day added
      four end-to-end cases that skip as root and a suite that runs
      only with a mounted disk, and the weights the shard dealer trusts
      were measured as root, where those cases cost nothing. The whole
      core suite ran as the unprivileged user — 2,857 pass, 1 darwin-only
      skip, 0 fail, 34 s wall on four workers — and `--weigh` took its
      JUnit: 164 files, 132→134 s of recorded
      test time, the movers `show-info.test.ts` 2→5 s, `cache-dir-selection.test.ts` 0→1 s, `flaky.test.ts` 0→1 s. The new deal predicts
      11.2 s for every shard (max/avg 1.00); the measured walls were
      9.2–13.7 s. This box hosts the suite as CI's runner sees it now,
      not only the unsafe set, so the next re-weigh has the same recipe.
      The re-deal exposed one more deal-shaped pin, as 196's did: the
      remote-usage case allocated a fixed 150 MB, and beside the
      87k-edge graph the shard's process mark was higher, so the child
      recorded no peak RSS (170) and the assertion met undefined. It
      sizes the child from the mark now, as `runner.test.ts` has since
      192; reproduced in shard 8's exact company, fixed there. CI's
      Linux job on the new deal: 1:33, against 2:04 on the run before
      it. The manual gate runs its shards as `probe` now too (2,857
      pass here), so the local gate sees the suite as CI's runner does.
215.  DONE (2026-09-16, the concurrent-runs persona): two runs of the
      same build on one workspace, outputs cold, cache warm — one
      run in five died with "internal error … CorruptArtifactError:
      artifact is not a readable archive" while the other restored 200
      files fine. The mechanism, once the scheduler's internal-error
      line carried the wrapped error's cause (it does now, for every
      such line): a restore stages each file as `<target>.vx-tmp-*`
      beside its target and renames on commit, and the other run's
      clean of `dist/**` takes the staged files, so the commit's stat
      or utime meets `ENOENT` — reproduced deterministically with a
      clean landing 4–32 ms into a 2,000-file restore. An `ENOENT` on a
      path the restore itself staged is a `UserError` now: "restore of
      <hash> into <dir> was interrupted: a file it had just written
      vanished … Another vx run is using this workspace — re-run once
      it is done." The artifact is intact and nothing is half-restored
      (the rename happens only once the whole archive has staged).
      Pinned in `cache.test.ts` with a deleter loop playing the other
      run for the whole restore (fails without the fix as a
      `CorruptArtifactError`); `docs/caching.md` § Concurrent runs says
      it. Not done, on the Next list: a per-task advisory lock so the
      second run waits instead of failing.
216.  DONE (2026-09-16, Next 19, as a per-RUN lock): two vx processes
      on one workspace take turns now. A run takes the workspace's run
      lock just before it schedules — after the early exits, which touch
      no tree — and releases it with its cache handle, before a
      persistent task's wait, so a dev server never holds it; the
      second run polls every 50 ms and after a second says whom it
      waits for. The lock is an atomic `mkdir` under the temp directory
      keyed by the resolved workspace root (so `--cache-dir` does not
      make two runs strangers, and a read-only checkout can take it)
      with the holder's pid inside, reclaimed when that pid is gone
      (`kill 0`: ESRCH is gone, EPERM is another user's live process,
      not ours to reclaim); a directory that cannot be made for any
      reason but "exists" is a one-line warning and an unlocked run —
      a courtesy between cooperating runs, never a refusal. Runs inside
      one process share it (a count; the last release removes the
      directory): the gate's first run showed the in-flight dedup
      control — two runs in one process, no registry, both execute —
      going quiet, because the lock had serialized what an embedder
      chooses to overlap and coordinates through `RunOptions.inflight`;
      the lock is for processes. Per-run, not
      per-task, because the warm no-op path must stay untouched: a
      per-task lock is a `mkdir` + `rmdir` per task (tens of µs × a
      thousand tasks, on a 232 ms run), a per-run lock is one pair per
      run; per-task granularity stays a refinement for a workspace that
      wants a watch and a run interleaved by task. Pinned:
      `run-lock.test.ts` (a second process waits for the holder — a
      sleeping child plays it — and the notice comes once after a
      second; runs in one process share it; a dead pid reclaimed and a
      live one not; an unmakeable lock warns and proceeds; an aborted
      wait returns without it) and `run-lock-e2e.test.ts` (two CLI runs,
      the second prints the line and hits the first's outputs; the race
      of 215 — cold outputs, warm cache, two runs — four rounds, both
      green, 200 files each time). `docs/caching.md` § Concurrent runs
      and `docs/cli.md` say it. Next 6 with the lock in place: 1,000
      projects 225 ms warm / 670 restore / 2,494 cold (medians of 5;
      210's 232 / 711 / 2,542) — one `mkdir` and one `rm` per run is
      nothing the bench can see.
217.  DONE (2026-09-16, housekeeping, as 194 and 195): STATUS had
      grown to 1,837 lines and 72 loop items since the morning's trim.
      Items 145–202 moved whole to
      `docs/history/2026-09-improvement-loop-145-202.md`; the
      2026-09-10 measurement paragraphs that sat after the loop (the
      restore floor, the shard re-weigh, the profiles, the warm-path
      A/B, the handoff after item 45) to the 65–104 file, where their
      items are; handoffs 14g–14i to the next-log file. What stays is
      today's arc (203 onward) and the current handoffs. The record
      paragraph names every file; the 105–144 file's header points on.
218.  DONE (2026-09-16, a workspace under a path with a space, walked
      as `probe`): the path itself was fine — every verb, the sandbox,
      the lock, `--frozen` — but the probe's own config found a trap
      that has nothing to do with spaces. A literal sandbox write grant
      on a path that does not exist yet (`write: ['dist']` on a cold
      tree, the site guide's own `'coverage'`) is pre-created as an
      empty FILE so bwrap has something to bind, so the task's `mkdir -p
dist` died with "File exists" from its own tool, and the empty file
      survived every later clean (`dist/**` matches nothing under a
      file), so every run after met it again until someone deleted it
      by hand. Now: a directory is spelled `dist/` (or a glob, as
      before) and is created as one; the empty files vx makes are
      returned with the request and swept after the attempt — the ones
      the task never wrote (still empty, mtime untouched) are removed,
      so an unwritten placeholder is never archived as an output and a
      wrong spelling costs one failed run, not a poisoned tree; and a
      failed task with nothing else reported gets one line per untouched
      placeholder naming the `dir/` spelling, in the violations section
      beside the failure, the way the missing-cwd read grant is named.
      Pinned: `sandbox-request.test.ts` (a literal is a file and
      reported, `dist/` and a glob are directories, an existing
      directory stays one, the spelling does not change the grant; the
      sweep removes an untouched placeholder and keeps a written one or
      a directory put in its place) and two cases in the unsafe suite
      (the trap: run not ok, the line names `dist/`, no `dist` left
      behind; `dist/` fills). `docs/schema.md` § A write grant's shape,
      the site's sandboxing guide (its example says `coverage/` now) and
      `modules/sandbox-request.md` say it. Seen on the way, not done
      here: a config array where an object is expected reports `unknown
field "0"`, and `vx info` counts a config that fails to load as
      zero tasks without saying so.
219.  DONE (2026-09-16, seen under 218): `cache.outputs: ['dist/**']`
      — Turbo's spelling, the first thing a migrating hand writes — was
      refused as `tasks.build.cache.outputs has unknown field "0"`,
      because an array is an object to `typeof` and its indices read as
      fields. Every object level shares one field check, so the check
      refuses an array in one place now, naming the level's fields and,
      where the level has `files`, the spelling meant: `must be an
object (fields: files, workspaceFiles), not an array — did you
mean \`{ files: [...] }\`?`. Pinned in `schema-unknown-keys.test.ts`(outputs, inputs, a level without`files`, the object control);
the error table in `docs/schema.md` has the row.
220.  DONE (2026-09-16, seen under 218): `vx info` on a workspace whose
      configs do not load printed `projects: 2 (0 tasks)` and exited 0 —
      the doctor deliberately survives a broken config (204's fallback
      counts the ones that load), but a zero that hides a typo is the
      one fact a bug report needs. The fallback names them now:
      `configErrors` (`[{ path, message }]`, the path workspace-relative,
      the loader's message with its absolute-path prefix stripped,
      sorted), rendered as `4 (5 tasks · 1 config did not load)` and a
      `config errors` row present only then; `getWorkspaceInfo` carries
      the field. Pinned in `show-info.test.ts` (the JSON entry, both
      rows, the empty control); `docs/cli.md` § vx info,
      `modules/doctor.md` and the MCP README say it.
221.  DONE (2026-09-16, a project inside a git submodule — the
      persona after 218's, and a stale hit): the workspace repository's
      `git ls-files` holds a submodule, or an embedded repository, as
      ONE entry (a gitlink; `dir/` when untracked) and none of its
      files — under the pathspec naming the project, nothing at all —
      so a project under one got an EMPTY partition of the
      workspace-wide enumeration: `cache.inputs matched no files`, a key
      that never moved, and after an edit to its source a green run
      replayed the old `dist` (reproduced as `probe`: `out.txt` said
      `one` with `x.txt` saying `two`, for a gitlink and an untracked
      embedded repository alike). The partition step stores no
      partition for an empty slice now — no real project's slice is
      empty, a project has at least its `package.json` — so
      `resolveFiles` takes its existing fallback, `git ls-files` spawned
      in the project's own directory, which the nested repository
      answers, and the files hash by content (no index OID trusted from
      there): one spawn per such project per run, nothing for a
      workspace without one. Refuted on the way: reading the gitlinks
      (`160000`) and `dir/` entries out of the listing — the
      enumeration is pathspec-scoped to the project dirs, and a gitlink
      ABOVE a project never appears under its pathspec. Pinned in
      `nested-repo-inputs.test.ts` (populate leaves the two nested
      projects without a partition and resolves their files through
      their own git, the workspace project keeps its OIDs; the CLI:
      cold run no "matched no files", an edit to all three is three
      misses and every `out.txt` follows). `--affected` is 222; `workspaceFiles`
      globs still stop at the nested repository, the workspace
      repository's own limit (recorded in `modules/git-inputs.md`).
222.  DONE (2026-09-16, 221's open half): `vx run --affected` after an
      edit inside a submodule or an embedded repository selected NONE
      of the projects there — git reports the nested repository as one
      changed path (`vendor/sub` for a dirty or moved gitlink,
      `vendor/nested/` for an untracked embedded one; measured, both
      forms) and none of the files, and the path-to-project walk goes
      UP from a changed file, never down into a directory. A changed
      path that is a directory on disk is such a repository — git
      reports nothing else as one — and every project under it is
      selected now; one `stat` per changed path outside any project,
      and the scan of project dirs only for a directory. Pinned in
      `affected.test.ts` (a clean tree selects nothing, a change beside
      the gitlink only its own project, an edit inside selects the
      nested project, an untracked embedded repository is new work);
      `docs/cli.md` § --affected and `modules/git-inputs.md` say it.
223.  DONE (2026-09-16, the box's own litter): a census of `/tmp` after
      the day's gates found 1,333 `vx-*` entries, 658 of them the run
      lock directories of 216 — every one with a dead holder. The
      release was fired and forgotten at close (`void releaseRunLock()`
      inside a synchronous `closeCache`), and `bin.ts` ends the process
      as soon as `run()` resolves, so a CLI run's release lost the race
      with its own exit every time; an in-process run (a test, a watch
      cycle) lived long enough for the removal to land, which is why
      216's pins passed. The next run reclaimed the dead holder's
      directory, so nothing ever waited — the litter was the finding.
      `closeCache` is async and awaited on both exit paths now (the
      normal close before a persistent task's wait, and the teardown on
      a throw, which still swallows its own error). Pinned in
      `run-lock-e2e.test.ts`: a finished CLI run leaves no lock
      directory (fails on the old code). The rest of the census: test
      fixtures without an `afterEach` — `vx-drift-*` (378, the
      schema-doc-drift provokers), `vx-plugin-pkgs-*` (164, the plugin
      helper), `vx-plugin-boundary-*`, `vx-history-*`,
      `vx-unnamed-pkg-*`, `vx-no-pkg-*`, `vx-cache-host2-*` — swept by
      hand this time and left for the next housekeeping pass (a shared
      fixture that registers its own removal). Refuted alongside, under
      Next 6: a `node_modules` that git does not ignore — 11,125
      untracked files walked by `status -uall` every run — costs the
      warm run 5 ms of 87 (git walks it in 11 ms), so no doctor row for
      it. Next 6 after 222: 1,000 projects 231 ms warm / 718 restore /
      2,436 cold (medians of 5; 216's 225 / 670 / 2,494), a tie within
      the reps' spread.

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
6. Known limits an article should state plainly: Bun ≥ 1.4 for source
   installs (the binary needs nothing); Linux sandboxing needs
   `bubblewrap` + `socat` and cannot run as root inside a container;
   Windows is WSL; macOS violation reporting is lossy under load
   (In-flight 5); the remote seam moves whole artifacts in memory
   (Next 2, fine below ~100 MiB).

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
   item 179 (2026-09-15, a tie), and the restore arm's floor is the
   note under item 193.

7. CLOSED — the 2026-09-04 walkthrough's four follow-ups landed
   ((a) `noCache` in `--summarize` rows, (b) `init` no longer makes
   `lint` wait for `build`, (d) an empty filter set names its patterns)
   or were measured out ((c) watch's one extra cycle on an undeclared
   write is the price of not declaring it). Record: history, next-log.

8. **Improvement-loop candidates (2026-09-09).** (a), (b), (f), (h)
   DONE as items 16/63, 8(b) 2026-09-10, 75 and 58; the measurements
   behind (e) and (h) are in `docs/history/2026-09-status-next-log.md`.
   Still standing: (c) only `vx lock` reads config files raw, on
   purpose — grep for `loadProjectConfig(` before adding a fourth
   consumer of the staged load; (d) `logger.ts` and `framed-output.ts`
   are the last large files, and neither splits cleanly (one renderer,
   one formatter); (e) REFUTED: a discovery memo keyed on directory and
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
    197 and 202 (14–14i) are in `docs/history/2026-09-status-next-log.md`;
    14j–14m below are the current ones.

14j. **Handoff after item 208 (2026-09-16, morning).** Six items
since 14i, all from one persona taken one step further each time:
the root-in-a-container box, where the sandbox refuses to nest, got a
`sandbox` row in the doctor (203) and then an unprivileged user
(`probe`), which turned the docs' first remedy into a fact (204) and
the box into a host for the whole sandboxed gate — `vx run ci --all`
with the sandbox required, 44 of 44, the unsafe set 78 pass (205; the
session's manual gate runs the unsafe step that way now). Walking as
that user found the class the walk was for: three touches of a tree
the process may not write — the clean (206), the restore (207), and
the cache directory itself (208) — each an "internal error" before,
each a `UserError` naming the path and the remedy now, each pinned on
a 0o500 directory, skipped as root and proven both ways as `probe`.
Merged as #372–#375; 208 rides the next. Refuted on the way: a trial
write under WAL proves nothing about a read-only cache (208), and
`chmod 500 .vx` alone proves nothing either (207). Open: Next 1, 2
and 16 as before, all gated by their own terms; In-flight 5 (macOS);
the owner residue — the `NPM_TOKEN` secret, the release cut, the
site's address. No open issues. The box: a `probe` user, a copy of
bun at `/opt/probe-bin/bun`, `HOME=/tmp/probe-home`; the traps are
in 205 (bun's per-build `node` shim under `/tmp`, owned by whoever ran
first — remove root's before a non-root run). Methods that paid: a
persona is worth a second and third step, not one; grep the class of
a fix by walking it, not by reading (207 and 208 were not in the code
206 touched); a probe that passes for the wrong reason is caught by
running it without the fix (208's first two probes passed on the old
code too). Never end with "what next?".

14k. **Handoff after item 211 (2026-09-16, morning).** Three items
since 14j, the same walk carried to the tree's other refusals: the
readers open an unwritable cache read-only and go on (209, the
file-hash memo took the write axis it had ignored); a read-only
checkout with no cache yet, and the verbs that write the tree, print
one line naming the path instead of a stack — the file system's
refusal is a `UserError` at the CLI's top level and in the scheduler,
one rule for every write nobody wrapped (210); and a full disk, which
a 2 MiB tmpfs makes hostable here and on CI, is reported the same way
at the restore, and a run whose history cannot be written keeps its
verdict (211; `disk-full.test.ts` behind `VX_SMALL_DISK`, mounted by
CI's Linux job and the manual gate). Merged as #377–#378; 211 is
#379. Refuted or retired on the way: a doctor that prints partial
facts on an uncreatable cache directory (declined under 210 — its one
line is the diagnosis); the pin that made a record throw reject the
run (it asserts the line now). Next 6 closed the day at a tie (under
210). Open: Next 1, 2 and 16 as before, all gated by their own terms;
In-flight 5 (macOS); the owner residue — the `NPM_TOKEN` secret, the
release cut, the site's address. No open issues. The box: as 14j,
plus `mount -t tmpfs` works here as root (the small disk). Methods
that paid: a persona's refusals come in kinds (permission, space) and
each kind has three sites (clean, restore, record) — walk the grid,
not the first cell; a claim in STATUS ("the readers keep working") is
a test to run before it is a sentence to keep (209 came from testing
208's last line); when a fix retires a pin, the pin's claim usually
survives in another shape (close still runs) — keep the claim, change
the shape. Never end with "what next?".

14l. **Handoff after item 214 (2026-09-16, mid-morning).** Three
items since 14k, each found by the machinery rather than a persona:
the prune verb was the last writer that opened the cache without
asking (212, #379); a gate stopped mid-run left the runtime's mux
sockets in `/tmp` and a recycled pid met `EADDRINUSE` — vx unlinks a
dead process's sockets under its own pid before the runtime listens
(213, #380); and the shard deal, weighed as root, had never counted
the cases that skip as root — re-weighed as the unprivileged user, the
deal predicts 11.2 s per shard and CI's Linux job fell 2:04 → 1:33
(214, #381), exposing on the way one more deal-shaped pin, fixed the
way 192 was. Refuted or left: partial artifacts (the orphan sweep
reaps them), the runtime's own temp directories, the MCP server's
and `vx watch`'s handling of a refusal (both right as they are), a
doctor that prints partial facts. Open: Next 1, 2 and 16 as before,
all gated by their own terms; In-flight 5 (macOS); the owner residue
— the `NPM_TOKEN` secret, the release cut, the site's address. No
open issues. The box: as 14k, plus the manual gate runs its shards
and its unsafe set as `probe`, mounts a 2 MiB tmpfs for the disk-full
suite, and clears stale `srt-mux-*.sock` first; `/tmp` swept of 6,537
leaked fixtures. Methods that paid: a gate's own failure is an item
(213); weights measured as the wrong user are a deal nobody dealt
(214); reproduce a deal-shaped pin in the shard's exact company, not
alone, and fix it there. Never end with "what next?".

14m. **Handoff after item 221 (2026-09-16, midday).** Seven items
since 14l. Two closed the concurrent-runs persona: the restore that
another run's clean interrupts is named, not a corrupt artifact (215,
#383), and two runs on one workspace take turns through a per-run
`mkdir` lock keyed on the resolved root (216, #384; Next 19 closed as
per-run, the per-task grain a refinement). One trim (217, #385:
145–202 and the 2026-09-10 records to history). Then a new persona — a
workspace under a path with a space, as `probe` — whose own probe
config found three traps the path did not: a literal sandbox write
grant on a not-yet-existing path is bound as a FILE, so `mkdir -p dist`
died with "File exists" and the file poisoned every later run — a
directory is spelled `dist/` now, vx sweeps the placeholders it made,
and the failure names the spelling (218, #386); `outputs: ['dist/**']`
was `unknown field "0"` — an array at any object level names the shape
and the spelling meant (219, #387); `vx info` counted a config that
does not load as zero tasks in silence — `configErrors` names it (220,
#387). Last, the persona after that one: a project inside a submodule
or embedded repository had an EMPTY slice of the workspace-wide
enumeration and a key that never moved — a stale hit under a green run;
an empty slice stores no partition now and the project's own git
enumerates it (221, rides the next PR). Refuted on the way: reading
gitlinks out of the listing (it is pathspec-scoped to the project dirs,
and a gitlink above a project never appears under its pathspec). Open:
Next 1, 2 and 16 as before, all gated by their own terms; In-flight 5
(macOS); the owner residue — the `NPM_TOKEN` secret, the release cut,
the site's address; `workspaceFiles` still stops at a nested repository
(`--affected` follows it since 222; recorded in `modules/git-inputs.md`). No open
issues. The box: as 14l; the persona probes live in
`/tmp/probe-home/probe-*.sh` and run as `probe`. Methods that paid: a
probe script's OWN mistakes are findings — three of the seven came from
the config I wrote wrong before the persona even ran (218–220); a stale
hit is found by editing every input and reading every output back,
never by the status line — "the key will not change" prints under a
green run, and a persona reading the exit code alone misses it (221);
when a listing is scoped, detect by what is absent from a slice, not
by what the scope would have to include. Never end with "what next?".

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
