# Shipped, 2026-09 — improvement-loop items 203–242

The record `docs/STATUS.md` carried until 2026-09-16, moved here whole
so the handoff stays readable. Nothing below is current state: STATUS
holds direction, what is in flight and what is next; this file holds
what shipped and the numbers behind it. Items 1–64 are in
`2026-09-review-arc.md`, items 65–104 in
`2026-09-improvement-loop-65-104.md`, items 105–144 in
`2026-09-improvement-loop-105-144.md`, items 145–202 in
`2026-09-improvement-loop-145-202.md`; items 243–281 in
`2026-09-improvement-loop-243-281.md`, items 282–305 in
`2026-09-improvement-loop-282-305.md`, items 306–332 in
`2026-09-improvement-loop-306-332.md`; items 333–352 in
`2026-09-improvement-loop-333-352.md`; items 353–372 in
`2026-09-improvement-loop-353-372.md`; items 373 onward continue in
STATUS under the same numbering.

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
      it. The deleter sweeps synchronously on each turn of the event
      loop (2026-09-16, the gate on item 241): a 1 ms timer with an
      awaited unlink per file got one unlink per commit yield, and 2
      restores in 60 under a 12-way load renamed every file it aimed
      at first; 0 in 60 once the sweep is one readdirSync plus its
      unlinkSyncs in one tick. Not done, on the Next list: a per-task advisory lock so the
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
224.  DONE (2026-09-16, 223's other half): the test fixtures that
      outlived their suites. The plugin-package helper's root is one per
      PROCESS — the module is evaluated once and shared by every file a
      `bun test` process runs — so no file's `afterAll` may own it, and
      `bun test` fires neither `exit` nor `beforeExit` (measured: a
      hook on each wrote nothing). So the root carries the pid
      (`vx-plugin-pkgs-<pid>-*`) and the next process to need one
      sweeps the roots of dead pids, the run lock's own reclaim: litter
      is bounded to the processes still running, and the next test
      process removes the last one's. The schema-doc-drift provokers'
      scratch directories (`vx-drift-*`) are registered and removed
      after the file; the history suite's cache directory per test and
      its project directory, the plugin-name suite's bare and unnamed
      packages and boundary fixtures, and the plugin-capabilities
      suite's second cache are removed where they are made. Refuted on
      the way: a module-level `afterAll` in the helper (registers for
      the first file only — the second process's root stayed) and a
      process exit hook (never fires). Measured by the census: after a
      full gate `/tmp` holds the lock directories of runs the kill
      tests kill (reclaimed by the next run, by design) and the plugin
      roots of the last shard processes (reclaimed by the next), and
      nothing else of vx's.
225.  DONE (2026-09-16, 221 and 222 for users): the nested-repository
      rule lived in `modules/git-inputs.md` only. `docs/caching.md`
      § Cache key derivation, step 11 (the site imports it) and the
      site's caching guide (§ What's always excluded) say it now: a
      project inside a submodule or an embedded repository is
      enumerated by that repository's own git, one spawn per run, its
      files hashed by content; `--affected` follows; a `workspaceFiles`
      glob stops at the nested repository's edge.
226.  DONE (2026-09-16, launch checklist 6): the site had no page that
      states vx's limits together — the introduction's Requirements
      said what it needs, nothing said what it cannot do. A "Known
      limits" section follows Requirements now: Bun ≥ 1.4 for source
      installs, the Linux sandbox's `bubblewrap` + `socat` and its
      root-in-a-container refusal (with the remedy and `vx info`),
      Windows as WSL, the lossy macOS report, the in-memory remote
      seam, the uncapped captured output (Next 20), and the nested
      repository's `workspaceFiles` edge. No new page, so the sidebar
      law is untouched; the checklist item points at it.
227.  DONE (2026-09-16, 218's persistent half): a dev server declaring
      a literal write grant (`write: ['.cache']`) met the same trap as
      a one-shot task — the grant pre-created as a FILE, its own
      `mkdir` dying with "File exists" — and the persistent path
      discarded the placeholders 218 made the one-shot path sweep, so
      the file outlived the run and the readiness failure said nothing
      of it. The placeholders ride the persistent request now: swept
      when the child exits (beside the port bridge's release) and,
      when readiness fails, swept there too with the `dir/` line on the
      task's stream. Pinned in the unsafe suite (the failure names
      `.cache/` and leaves no file; `.cache/` makes its directory and
      becomes ready).
228.  DONE (2026-09-16, the deal re-weighed after the day): CI's Linux
      job ran 2:20 on #395 against 1:33 after 214, its shards spread
      13–39 s (contending with the 37 s docs build on a four-worker
      runner), and four of the day's test files sat at the median
      weight — the run-lock e2e (2.8 s, two CLI runs and a 1.5 s
      server) and the run-lock unit suite (1.8 s) among them. Re-weighed
      as `probe` from a fresh JUnit run of all twelve shards: 168 files,
      151 s of recorded weight against 135; the local shards deal to
      10–15 s. The next CI run is the number.
229.  DONE (2026-09-16, Next 20): a task's retained output is bounded.
      The live stream is untouched — every byte reaches the terminal as
      the task writes it — but the copy vx keeps for the cache entry
      and its replay is the first 8 MiB and the last 8 MiB, with the
      dropped middle counted and named where it was (`[vx] 22.1 MiB of
output not kept — vx keeps the first 8.0 MiB and the last 8.0 MiB
of a task's output for its cache entry and replay`). The
      accumulator fills a head once and keeps a ring of tail chunks
      trimmed from the front, so memory is the two bounds plus one
      chunk whatever the task prints. Measured on the 200 MB probe:
      the hit 620 → 109 MB of RSS and `.vx/cache` 193 → 17 MB; the MISS
      stays at 652 MB, which is not the capture but the logger's frame
      buffer — a task's live chunks are held until its frame prints,
      the persistent path alone routes them into a bounded tail, and
      `--output-logs none` avoids it (measured 294 → 81 MiB when that
      mode shipped). Left as it is: a frame is the whole output by
      contract, and a chatty task's operator has the mode. Pinned in `capture-cap.test.ts` (40 MB: the head, the tail,
      the exact length, the line's number, the live stream still whole;
      1 MB: whole, no line; through `run()`: the hit replays the bounded
      text with the line). `modules/runner.md`, `caching.md` § Cache
      write and the site's Known limits say it.
230.  DONE (2026-09-16, from #397's macOS job): two CLI runs on one
      workspace open the cache BEFORE the run lock is taken — the open
      is the one moment they still overlap — and the second met
      `SQLiteError: database is locked` at `PRAGMA journal_mode = WAL`,
      because `busy_timeout` was set after that pragma and the
      journal-mode switch takes a lock of its own; macOS's slower disk
      found the window first, on the run lock's own e2e (round 3 of
      four). The timeout is the first pragma now, so the open waits for
      the holder. Pinned in `cache-open-busy.test.ts`: another process
      holds an EXCLUSIVE lock for 1.5 s and `new Cache` waits it out
      (fails at once on the old order — reproduced on Linux, where the
      e2e itself never tripped).

231.  DONE (2026-09-16, a persona: the agent's pipeline): a reader that
      leaves after the first line — `vx run build | head -1` — killed
      the run with an EPIPE stack and exit 1 AFTER its task had
      succeeded, and left its lock directory behind. Bun raises the
      closed pipe as an `error` event on `process.stdout`, and an
      `error` nobody listens for is an uncaught exception. `bin.ts`
      listens on stdout and stderr now (the CLI's streams, not the
      logger's — an embedder's are its own): the write returns false,
      the run finishes, saves, releases and exits with its verdict.
      Pinned in `bin-reader-gone.test.ts` through
      `set -o pipefail; vx run first second | head -1` — an instant task
      lets `head` leave, a slow one meets the closed pipe; the next run
      is up-to-date, which needs the fingerprint the save recorded.
      Fails on the old `bin.ts` at the first assertion (the stack).
      Probed and clean on the way: every MCP tool and `vx info`, `why`,
      `last` and `cache prune --dry-run` answer during a run (340 ms at
      most, item 230's open order); a task that runs `vx run` on its
      own workspace is refused before it starts; a `fetch-depth: 1`
      checkout with `--affected` in its three shapes (no base, a base
      not fetched, a PR head against a depth-1 base) says the right
      thing each time.

232.  DONE (2026-09-16, a persona: symlinked outputs): a task whose
      `dist/` holds a link to a file, a link to a directory and a
      dangling link — the contract held as documented (a file link is
      stored as its bytes and restored as a file, the other two refuse
      the save by name), but the refusal's remedy said "exclude it from
      cache.outputs", and output globs take no `!` — the spelling it
      pointed at fails to load ("negation is not supported"). The
      remedy names what works now: narrow `cache.outputs.files` to the
      files the task produces. Pinned in `output-shape.test.ts` (the
      remedy text, not the prefix alone). Rejected on the way: storing
      a link as a link — the restore never materialises one on purpose
      (a poisoned artifact cannot smuggle a link onto disk,
      `caching.md`), and a directory link's target is not the task's
      output anyway.

233.  DONE (2026-09-16, a persona: the binary user who self-updates
      with `vx upgrade`): the download was 87 MB over HTTPS, then
      renamed over the running executable on trust — a cut transfer
      (this box's proxy drops connections; item 175's class) or a
      swapped asset became a `vx` that does not start. The release API
      publishes a `sha256:` digest per asset (every release built by
      `release.yml` carries one); `vx upgrade` reads the release
      document now, picks the platform's asset and its digest, verifies
      the download, and only then renames — a mismatch replaces nothing
      and says so, and a release with no asset or no digest is refused
      before the download. `releaseAsset` and the digest argument of
      `replaceBinary` are pinned in `upgrade.test.ts` (a truncated body
      leaves the old binary and no temp file); the compiled path was
      proven live with a scratch binary against v0.0.21. Noted, not a
      finding: the releases' only signing is macOS's ad-hoc codesign,
      so the digest is integrity against the CDN and the wire, not
      provenance — provenance is the npm route (`npm.yml` publishes
      with it).

234.  DONE (2026-09-16, the npm-installed user of 233's persona): an
      npm install runs the platform package's compiled binary — the
      launcher execs `node_modules/@vzn/vx-<os>-<arch>/vx` — so it
      passed the compiled-binary check and `vx upgrade` would have
      renamed over a file npm owns: the command upgraded until the next
      `npm install` (or a lockfile-pinned CI checkout) put the version
      npm knows back, and `npm ls` disagreed with `vx --version` in
      between. A binary under a `node_modules` refuses now and names
      the npm command; `npmOwnedBinary` is pinned for a global, a local,
      a pnpm store and a Windows path, and null for a hand-installed
      one. Ordered after the source refusal, so a source checkout still
      hears "git pull".

235.  DONE (2026-09-16, the same persona reading the README): the
      comparison table promised "npm or 1 curl line" and no install
      script exists anywhere — the quickstart offers npm or a release
      file, and 234's own comment had repeated the phrase. De-claimed
      in the README, the source and the test comment: npm, or one
      release file. An install script is a launch decision for the
      owner (it needs the site's address, checklist 3), not a line to
      promise ahead of it.

236.  DONE (2026-09-16, a persona: `exec.timeout` and `retries`): the
      retry and the timeout each read right (two attempts, the flaky
      note, `timed out after 1000ms — killed`), but the timed-out task's
      background child survived the kill, and so did every compound
      command's on a Ctrl-C — only the direct child was signalled, the
      residual the runner's own comment called "documented" and no doc
      under `docs/` stated (`cli.md` claimed a cancellation "never
      orphans a task"). Every task child is spawned `detached` now —
      Bun's `detached: true` is a new session and process group — and
      every kill (the timeout, the readiness deadline, the signal
      teardown, the persistent shutdown) signals the group through
      `exec/kill-tree.ts`; a task in its own session no longer hears
      the terminal close, so vx handles SIGHUP beside SIGINT and
      SIGTERM (129) and `vx watch` stops on it too. Pinned in
      `task-tree-kill.test.ts`: a timeout, SIGINT, SIGTERM and SIGHUP
      each reap a backgrounded grandchild (its pid from the inner
      shell's own `$$` — the first draft's marker held the OUTER shell's
      pid, which dies trivially, and proved nothing); all four fail on
      the old source. Probed and clean on the way: an undeclared env
      var is invisible to a task (eight essentials only) and never a
      stale hit; `cache.inputs.env` keys without passing through, as
      the schema doc says, and both migration mappers write a Turbo
      `env` to both; alternating a keyed value restores the right bytes
      each time.

237.  DONE (2026-09-16, a persona: `vx watch` over a dev server that
      writes a pid file): the server appended its pid to a file in its
      own project on every start, and the loop re-ran itself 29 times
      in 8 seconds from one edit — the state gate settles a write that
      leaves the same bytes, and a file that differs every run is the
      one shape it cannot. Two changes. A git-ignored path never starts
      a cycle now (`gitIgnored`: one `git check-ignore --stdin` per
      judgement, never per event; a tracked file matching a pattern is
      not ignored, by git's rule; outside a repository nothing is) —
      no cache key can see such a path, so a cycle it started could
      change nothing, and the real-world shapes (`.next/trace`, a log,
      a pid file) are gitignored. A path that is neither ignored nor
      declared still re-runs — the third mid-run write of one path
      cannot be told from a user's third save mid-run — and after three
      such cycles in a row watch names the path and the remedy, once,
      and keeps going. Pinned in `watch-loop-selfwrite.test.ts` (the
      ignored file: one execution per edit, then quiet; the free one:
      the storm, the label, the notice exactly once); the first case
      climbs past 2 within the settle window on the old source. Noted:
      under the storm the server's own background worker recorded only
      its first start — unexplained, and gone with the storm. The same
      PR's Linux job tripped the run-lock e2e (216): its 300 ms head
      start was not enough for the first run to reach the lock on a
      loaded runner, so the second took it and the two swapped roles —
      a marker the task writes replaces the sleep.

238.  DONE (2026-09-16, three configuration personas): a package with no
      `name`, a config importing a package that is not installed, and a
      workspace whose package globs match nothing are each told the
      right thing — two warts fixed. `vx info`'s config-error row named
      the file twice for the import shape (the loader's message opens
      with `Project config <abs>:`, and the doctor stripped only the
      bare path); both prefixes are stripped now, pinned in
      `show-info.test.ts`. And the empty workspace was told to run
      `vx init`, which would have found no package to write for; it is
      told its package globs matched nothing (`init.test.ts`). Measured
      on the way, no change: a task printing 200,000 lines (2.5 MB)
      costs the renderer 60–80 ms above vx's ~100 ms floor under
      `--output-logs full`, and a hit's replay 35 ms — the default under
      `--all` hides a success's output by design (BROAD flow); the
      detached spawn of 236 on 200 uncached tasks, an interleaved A/B
      against a worktree at 25d2de9 (min 255 → 264 ms, median 264 →
      267), a tie within the jitter — at most 40 µs a spawn.
      And the gate itself: the plugin helper's sweep of dead sibling
      roots (224) threw `EPERM` on a root-owned root the shards, run as
      the unprivileged user, could not remove — every plugin test fell
      with it; the sweep skips what is not its to remove.
      And the macOS job: the new fixture's unresolvable import, in a
      workspace with no `node_modules`, made Bun auto-install — sixteen
      registry connections before "cannot find", a sandbox violation
      there — so the fixture has a `node_modules` like any real
      workspace, and the product gap is Next 21.

239.  DONE (2026-09-16, Next 21): a config's bare import that no
      `node_modules` provides is refused BEFORE the evaluation. Left to
      Bun, a workspace with no `node_modules` anywhere above — a fresh
      clone before its install, a typo in an import — had the package
      auto-installed from the npm registry first: sixteen connections
      and 150 ms before "cannot find", measured, and a sandbox violation
      on the macOS job (238). `unprovidedBareImports` scans the config's
      specifiers (the transpiler's own scan, as the owners walk does)
      and climbs for `node_modules/<package>`; builtins, `@vzn/vx` (the
      core alias) and path specifiers are never listed, and the refusal
      keeps Bun's shape with the remedy: `cannot find 'x' — no
node_modules above the config provides it; install the workspace's
dependencies first`. On the evaluation path only — a warm run
      serves configs from the eval cache and scans nothing. Pinned in
      `config-missing-import.test.ts` (the refusal's suffix is the proof
      it came before the import; a provided package still evaluates).

240.  DONE (2026-09-16, the number 239 owed): the refusal's scan cost
      the cold path. An interleaved A/B on 1,000 cold configs against a
      worktree at dafe980 (a fresh cache dir per rep) put 239 130 ms
      behind (min 1181 → 1319 ms): a `Bun.Transpiler` was built per
      config, and constructing one is 42 µs against 12 µs for its scan.
      One transpiler per loader, made on first use, halved it (min
      1134 → 1202); a textual pass before the scan — a regex over the
      quoted specifiers after `from`, `import` and `require(`, and a
      config whose only candidates are `@vzn/vx` and builtins skips the
      transpiler — took the check to 2 µs per config (58 before, 13
      with the shared transpiler), and the same-tree A/B of the check
      against a stub is a tie at min-of-9 (1144 vs 1159 ms; the medians
      45 ms apart inside arms that each spread 100). The scan still
      decides: a candidate the regex finds is checked exactly, so a
      commented import or a type-only one is dropped as before. The
      warm path never ran any of it (the eval cache serves configs).

241.  DONE (2026-09-16, a persona: a machine without git — a minimal
      image): `vx run` said the right line (the enumeration's: vx
      requires git, install git and re-run), but `--affected` printed
      Bun's stack (executable not found in PATH, at
      `defaultAffectedBase`), and a git that ran and failed
      through a shell shim was read as "not a work tree — run git
      init". Every git spawn in `affected.ts` goes through two wrappers
      now, and a spawn that cannot run is util's `gitSpawnRefusal` —
      one line, shared with the enumeration; the watch judge's
      `check-ignore` ignores nothing and keeps going without git; the
      other sites (`vx info`, the run's branch and sha, the object
      format) already caught it. Pinned in `no-git-on-path.test.ts`:
      the CLI child gets a PATH of bun and sh alone, and `--affected`,
      `--affected=HEAD` and `--all` each print the line and no stack.

242.  DONE (2026-09-16, the minimal-image persona, one step on): a box
      without `sh` failed every task as "failed (exit 127)" under a bare
      `$ <command>` and nothing else. The runner put the reason on the
      result's stderr, which the orchestrator never retains (its capture
      drops stderr; the live callback is the frame), so the one line
      that explained the run reached nobody — and `runner.md` claimed it
      did. Both runners (plain and sandboxed) send the reason through
      `onStderr` now and name a missing shell: "vx runs each task with
      sh -c: failed to spawn 'sh' (working dir: <dir>). Install a POSIX
      sh and re-run."; another spawn error keeps Bun's text, and an
      ENOENT with the working directory gone stays the generic line.
      The persistent path already wrote its ready rejection to the
      frame. Pinned in `no-shell-on-path.test.ts`: a PATH of bun and
      git alone gives exit 1, the line inside the task's frame and no
      Bun stack; the control with sh runs green. Fails without the fix.
