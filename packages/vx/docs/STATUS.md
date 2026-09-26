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
14j–14p to the next-log file), and items 243–281 to
`docs/history/2026-09-improvement-loop-243-281.md` that afternoon
(handoffs 14q–14v to the next-log file), and items 282–305 to
`docs/history/2026-09-improvement-loop-282-305.md` that evening
(handoffs 14w–14y to the next-log file), and items 306–332 to
`docs/history/2026-09-improvement-loop-306-332.md` late that night
(handoffs 14z–14ad to the next-log file), and items 333–352 to
`docs/history/2026-09-improvement-loop-333-352.md` on 2026-09-19, and
items 353–372 to
`docs/history/2026-09-improvement-loop-353-372.md` that night
(handoffs 14ae–14af to the next-log file), and items 373–392 to
`docs/history/2026-09-improvement-loop-373-392.md` on 2026-09-20
(handoff 14aj to the next-log file), and items 393–412 to
`docs/history/2026-09-improvement-loop-393-412.md` later that day
(handoff 14am to the next-log file), and items 413–432 to
`docs/history/2026-09-improvement-loop-413-432.md` on 2026-09-20
(handoff 14an to the next-log file), and items 433–452 to
`docs/history/2026-09-improvement-loop-433-452.md` on 2026-09-20
(handoffs 14ao–14ap to the next-log file), and items 453–572 to six
files of twenty, `docs/history/2026-09-improvement-loop-453-472.md`
through `-553-572.md`, on 2026-09-22 (item 573), and items 573–591 to
`docs/history/2026-09-improvement-loop-573-591.md` later that day
(handoffs 14aq–14au to the next-log file, item 592), and items 592–611
to `docs/history/2026-09-improvement-loop-592-611.md` on 2026-09-23
(handoffs 14av–14ax to the next-log file, item 612), and items 612–631
to `docs/history/2026-09-improvement-loop-612-631.md` that afternoon
(handoffs 14ay–14ba to the next-log file, item 632), and items 632–654
to `docs/history/2026-09-improvement-loop-632-654.md` that night
(entries 14bb–14bv to the next-log file, item 677), and items 719–743
to `docs/history/2026-09-improvement-loop-719-743.md` on 2026-09-25
(item 764), and items 744–778 to
`docs/history/2026-09-improvement-loop-744-778.md` that afternoon
(item 785), so
this file stays the handoff
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

820.  DONE (2026-09-25, `vx-reapi`'s `merkle.ts`). The sweep found three
      defects, all fixed:
      - A grafted upstream `Tree` could reference directories no blob
        matched. `canonicaliseTree` found a child only by re-encoding it
        with our encoder, which misses whenever the worker's bytes differ
        (the executor's own comment measured 4 of 649 resolved). So the
        grafted parent kept the worker's digest while we shipped our
        encoding under another. A `TreeGraft` now carries the
        raw-bytes child digests `decodeTreeWithBytes` already computes.
        The row grafts a Tree whose child bytes are valid but not in our
        field order, and requires every reachable directory to have a
        blob.
      - `FileNode.node_properties` was encoded as field 5, which the
        proto reserves; it is field 6. Held by a protobufjs oracle row.
      - `decodeFileNode` dropped `node_properties`, so the executor's
        "`unix_mode` is authoritative when the server sent it" never
        ran: a comment claiming what the code lacked. It is now decoded
        (`mtime`, `unix_mode`), held by a row that decodes protobufjs's
        own bytes.
        Each fix fails its row when reverted. The sweep: 56 mutations, 18
        caught, 34 held now, 4 equivalent. Held now, in
        `tests/merkle-sweep.test.ts`:
      - protobufjs byte-for-byte: a varint boundary and a size past
        2^31, node properties, a command's platform, legacy outputs and
        node-property names sorted, an action's floored timeout, empty
        salt and sorted platform, and a Tree's children in field 2;
      - decoders: a size past two varint bytes, an explicit
        `is_executable = 0`, and stopping at a wire type they do not
        read;
      - digest functions: SHA1, an unsupported function refused, and
        `canDigest` agreeing with this runtime's `createHash`;
      - trees: a graft keeps its symlinks and ships its blobs, a graft
        wins over a disk directory, ensured directories sort and `''` is
        the root, a file graft counts, only the owner's execute bit
        counts;
      - `DigestCache`: a hit is the stored digest, and a new mtime at
        the same size is a miss.
        Equivalent: symlink sorting (paths are sorted before insertion),
        the `working_directory` and `output_directory_format` guards
        (`strField` and `intField` omit their defaults already), and a
        truncated varint's early return. Not held offline: the
        executor's passing of `childDigests` into the graft, which needs
        the Execute stub named in 819.

821.  DONE (2026-09-25, CI). The execution service's busybox base now
      comes from whichever of three mirrors of the Docker Official image
      answers (AWS, `mirror.gcr.io`, Docker Hub), in two rounds 20 s
      apart. One registry had been one outage away from a red job: AWS's
      mirror answered every attempt on #895 with a 429 ("Data limit
      exceeded") before any test ran, and Docker Hub 500'd the same step
      on 2026-08-24. The loop was exercised with a stand-in
      `docker` that fails on AWS and succeeds on the second mirror, and
      one that fails everywhere (six attempts, exit 1). The workflow
      change landed first as a port into #895, which the limit had
      blocked; this item adds the `nativelink.md` recipe's mirrors.

822.  DONE (2026-09-25, `vx-reapi`'s offline REAPI server). The Execute stub
      819 and 820 named, and more: `tests/helpers/fake-reapi.ts` serves all
      five services the client speaks (Capabilities, ActionCache, CAS,
      ByteStream with zstd resources, and Execution with `WaitExecution`)
      over maps. It records every call with its metadata, fails a method
      on demand, and lets a row script what each Execute streams (stages,
      then a response, a status, or an early end). Nothing runs a command.
      `tests/fake-reapi.test.ts` drives the real `ReapiClient` through
      each service, so the sweeps that stand on it stand on answers the
      client is known to read:
      - capabilities and zstd negotiation;
      - a batch and a streamed CAS round trip, plus the missing set;
      - zstd resources stored and served as the plain bytes;
      - an ActionCache update read back;
      - Execute's stages and a decoded final response;
      - a transient status retried, and a dropped Execute re-attaching
        through `WaitExecution` by its operation name.
        Two things the rows taught the fake: protobufjs's `encode` takes
        an enum's number (`fromObject` turns the name into it, and without
        it every stage read `UNKNOWN`), and with no instance name a
        resource starts `compressed-blobs/…` with no leading slash.
        `findMissingBlobs` returns the server's digests as proto-loader
        reads them, `size_bytes` a string, so rows compare hashes.

823.  DONE (2026-09-25, `vx-reapi`'s `wire.ts`, first slice: setup,
      metadata, CAS, ByteStream). 50 mutations: 10 caught, 38 held now,
      2 equivalent. Offline, only the integrity suite and a few pins read
      this half of the client. Held now, in `tests/wire-sweep.test.ts` on
      the 822 fake:
      - what every call carries: `RequestMetadata` byte-equal to
        protobufjs's encoding (a 128-byte name crossing a varint,
        empty fields omitted), user headers, the instance name in batch
        reads and resource names, and a `grpc://` endpoint plain while a
        `grpcs://` one is TLS;
      - negotiation: `update_enabled`, batch compressors apart from the
        stream ones, a digest function the server lacks refused,
        compression declinable, batch uploads compressed only where the
        server takes zstd, and an oversized advertised batch clamped;
      - batches: a refused blob named, a missing read absent, reads
        charged for framing (a blob past the budget streams, a full group
        flushes), uploads sending only what is missing, and zstd accepted
        on reads;
      - integrity and errors: wrong bytes and wrong sizes refused on
        `readBlob` and batch reads, RESOURCE_EXHAUSTED retried, a non-
        NOT_FOUND refusal an error on three paths, and a cancelled read
        stream cancelling its call;
      - writes: an empty blob as one finishing message, offsets and
        `finish_write`, a streamed Blob's tail, zstd for small Blobs and
        identity for streamed ones, the stall downgrade to the safe size
        for multi-message writes only, resume from the committed offset
        (bytes and a streamed Blob), and a write the server reports
        complete not sent again.
        The fake learned `QueryWriteStatus` with cut writes, per-blob
        batch rejection, `update_enabled`, recorded `finish_write`, held
        reads, and injected Write failures answered at the stream's end.
        Answered mid-stream, grpc-js leaves the client writing until its
        own deadline. Equivalent: the floor's `patch < 0` (MIN_BUN's
        patch is 0) and the short-write check's expected size on the
        compressed path (`committed > 0` decides there).
        A one-message write refused with DEADLINE_EXCEEDED waited out
        the 30 s deadline under `bun test`. Item 827 proved the cause is
        the test, not the client: awaiting the call through
        `expect(…).rejects` held it until its deadline (30,002 ms), while
        `.then(ok, err)` on the same call settled in 2 ms. The row is back
        on one client and uses `.then`.

824.  DONE (2026-09-25, `vx-reapi`'s `wire.ts`, second slice: Execute,
      split, splice, GetTree). A defect, fixed: `getTree` hung on every
      call. The proto declares GetTree server-streaming, and the client
      sent it through the unary helper, whose callback a streaming stub
      never calls. It now reads
      the one stream to its end. The method is public API with no caller
      in `src/`, which is how it went unseen. Its row timed out before
      the fix. The sweep: 20 mutations, 2 caught by 822's self-tests, 18
      held now, in `tests/wire-exec-sweep.test.ts`:
      - Execute's defaults (skip the server's cache, inline stdout and
        stderr, nothing else) and its options (files to inline, both
        priorities, a negotiated digest function);
      - a non-transient status thrown with no re-attach, a stream ending
        with no operation refused by name, and an abort that cancels the
        call (the row bounds itself: an abort nobody hears held the file
        open);
      - stages: a message with no stage reports none, an unnamed number
        is `STAGE_n`, and a stage after a digest field still reads;
      - the public `waitExecution` by name, split's chunks and chunking
        function, splice's expected digest, and every GetTree page.
        The fake learned SplitBlob, SpliceBlob, a streaming GetTree,
        raw stage metadata and a count of cancelled Executes.

825.  DONE (2026-09-25, `vx-reapi`'s `executor.ts`, first slice: the
      hand-written `ExecuteResponse` decoders). 33 mutations: 18 caught,
      14 held now, 1 left for the run-path slice (a response with no
      bytes, reachable only through a run). Held now, in
      `tests/decode-sweep.test.ts`:
      - from protobufjs: a negative exit code, the stderr digest, a
        digest size past 16 bits, and the execution-start and -completed
        timestamps chosen over the input-fetch ones, with nanos;
      - by hand, for what an encoder never writes: an explicit
        `cached_result`, `human_readable` and `is_executable` of 0 read
        as false, empty `contents` as none, fixed-width fields vx does
        not read stepped over at both levels, an output directory's tree
        digest after a varint field, and a server log with no digest
        dropped rather than listed as `undefined`.

826.  DONE (2026-09-25, the trim the loop passed forty at). Items
      779–819 moved to `docs/history/2026-09-improvement-loop-779-819.md`
      in this commit. What that stretch was: the `vx upgrade` test that
      could replace the host's Bun (779); the sweeps of every core `src/`
      file no sweep had named (780–797); `vx-lockfile`'s four parsers (798–799, 802–803); the
      upstream-ledger rows, the large-upload ceiling and `setpriv`
      refuted (800–801); Next 23's signal rows made to say what they saw
      (804); `vx-schedule-history`, `vx-github`, `vx-otel` and `vx-mcp`
      (805–808); `vx-migrate` end to end (809–817); and `vx-reapi`'s cache
      layer and plugin (818–819). Next trim when the loop passes forty.

827.  DONE (2026-09-25, `vx-reapi`'s `executor.ts`, second slice: the run
      path of `reapiExecutor`). Three defects, fixed, each row failing
      without its fix:
      - a record replay wrote EMPTY output files. It took inline
        `contents` whenever the field was present, and the decoder hands
        an empty buffer for an absent one, so every replayed file was
        zero bytes. Now only non-empty contents count, and a zero-size
        digest (a string "0" once decoded) is written empty without a
        read;
      - `materialiseTree` looked children up by re-encoding its own
        parse, so a Tree whose child bytes were not vx's encoding (a
        server's field order, an unknown field) lost the directories
        below the first level ("not present"). It now keys them by the
        worker's own bytes, as 820 did for grafts;
      - a record replay delivered stdout only when `capture.stdout` was
        set. `capture` governs retention, not delivery, as the execute
        path already says; a deferred producer saves nothing, so its
        replay printed nothing at all.
        The sweep: 48 run-path mutations plus the three fixes'
        differentials; 47 held, in `tests/executor-sweep.test.ts`
        (replay, its misses and its deferral; the Action's platform,
        timeout, salt and priority, and the Command's platform; the
        action id on every call; the stall bound's precedence; operation
        errors, failed statuses with logs, no result; delivery and the
        worker; the record's paths, bits, symlinks, per-match
        decomposition and a failed write; upstream grafts from disk,
        from a record, empty, evicted and shadowing; root-anchored
        outputs). This also holds 819's I10 and I12 (the plugin's
        platform and execute timeout reach the executor), 820's
        executor-side graft, and 825's D33. Equivalent: the stall
        timer's re-arm guard (a lost timer fires at the same moment and
        later aborts a settled signal). The fake learned an operation
        that ends in `Operation.error`, and treats the empty blob as
        always present, as the spec says. Item 823's open question is
        answered in place: `expect(…).rejects` held a gRPC call to its
        deadline under `bun test`.

828.  DONE (2026-09-25, `vx-reapi`'s `executor.ts`, last slice: the
      helpers). 45 mutations: 15 caught by 827's rows and
      `executor.test.ts`, 29 held now, 1 equivalent. Held in
      `tests/executor-helpers-sweep.test.ts`:
      - the command line, RUN by `/bin/sh` rather than compared as a
        string: the root climbed to from the project, `$PWD` from the
        input root, both `node_modules/.bin` dirs leading PATH, forwarded
        args quoted (one holding a quote), and a missing project dir
        stopping the script with exit 1 before the command runs;
      - the environment: an unset input stays unset, a define wins;
      - the record's decomposition: a literal glob recorded whole without
        reading its Tree, an unreadable or rootless Tree recorded whole
        with its warning, a glob matching nothing or with a partial
        wildcard recorded whole, and each match recorded once, its Tree
        carrying every descendant past a hole and uploaded when the probe
        fails;
      - server logs: only human-readable ones up to 64 KiB, and one that
        cannot be read left out rather than failing the message;
      - materialisation: files past 1 MiB kept out of the batch, the
        executable bit and `unix_mode` applied, a symlink replacing a
        file, and under a literal capture a missing Tree, a rootless one,
        a missing child and a missing file each refusing by name.
        Equivalent: `globToOutputPath`'s literal return, since joining
        the split segments rebuilds the glob. `vx-reapi`'s `src/` is now
        swept file by file.

829.  DONE (2026-09-25, `vx-migrate`'s `nx-env.cjs` and `nx-dotenv.cjs`,
      the last `src/` files no sweep had named). 22 mutations: 8 caught
      by the rows already there and `nx.test.ts`, 9 held now, 5
      equivalent. Held in `tests/nx-dotenv.test.ts`: each usage error
      named (a flag with no value, no command after `--`), `--help` and
      `-h` printing the usage with exit 0, no `nx` refused by name with
      exit 1, Nx's loader never required when there is nothing to load
      (an Nx that moved `task-env` still runs a plain line), a shell
      killed by a signal reported as 128 plus its number, and no `sh`
      on PATH exit 1 by name. Equivalent: the quoting's empty-string
      and safe-character shortcuts (the shell reads the same words),
      `r.status ?? 1` (a null status without a signal comes only with
      `r.error`, which returns first), resolving the `.env` paths (the
      loader resolves them against the same cwd), and unloading the
      `envFile` first (Nx unloads only names equal to the file's own
      values, which the load puts back). The core and plugin `src/`
      trees are now all named by a sweep; the loop goes to STATUS's
      Next list.

830.  DONE (2026-09-25, Next 6's warm A/B, owed since the last measured
      commit). Items 759 (the run lock, taken on every run) and 760
      changed the run path with no number beside them. Current main
      (30191b66) was measured against 7ee7fa27, the commit of the last
      warm-path work, on `run build --all` over a pre-warmed
      synthetic workspace per arm. The arms ran interleaved, with an A/A
      arm on main as the control, under Bun 1.4.2 on 4 CPUs:
      - 1,000 projects, 11 reps: before 271.5 ms min (290.8 median),
        main 268.0 (301.1), A/A 273.8 (293.8);
      - 100 projects, 15 reps: before 127.5 (135.5), main 128.5
        (133.9), A/A 128.0 (136.1).
        A tie at both sizes: every gap is inside the A/A spread. The run
        lock costs nothing measurable. The plan's D2 (the streaming
        remote seam) is struck through, since it shipped as item 662.

831.  DONE (2026-09-25, the playground's `semver.ts`, a browser port no
      sweep had named). A defect, fixed: the port disagreed with
      `Bun.semver` on ranges core admits. It closed a `<` bound over a
      partial (`<3.x`, `<3.1`) and a hyphen range's partial end below
      the release's prereleases, as node-semver does. Bun closes both
      at the release, so it admits `3.0.0-beta` to
      `>=3.0.0-alpha <3.x` and to `3.0.0-alpha - 2`, and the site's
      graph drew those edges differently from the CLI's. `<=` over a
      partial keeps node-semver's bound in Bun too. The claim this
      exposed is corrected in place: core hands Bun only the grammar
      "where the two agree", and in that corner they do not (npm 7.6.0
      and node-semver 7.8.5 say false). `package-graph.ts` and
      `modules/package-graph.md` now name it; behaviour is unchanged.
      The sweep: 47 mutations, 39 held by the Bun-oracle test. Its
      manifest shapes gained the multi-space hyphen, `^0.0.N`,
      prereleases of unequal length and numeric identifiers, the two
      corners, and versions written with `v`, `=`, build metadata,
      padding, or none at all. 8 are equivalent inside core's grammar,
      where they cannot be reached: a wildcard major after `^`, `<` or
      `>`, whitespace inside a partial, an empty set, a hyphen with no
      numeric end, the `m = 0` already set, and a partial's absent
      patch and prerelease when its minor is absent.

832.  DONE (2026-09-25, the playground's `xxh3.ts`, the pure-TS port of
      the hash every cache key folds). 37 mutations over every length
      branch, the long-input accumulator, the seeded secret and the
      32-bit seed read: 34 caught by the Bun-oracle rows already there,
      1 held now, 2 equivalent. Held in `tests/playground-xxh3.test.ts`:
      a view that starts past its buffer's first byte (a pooled
      `Buffer`, a subarray) hashes its own bytes, in every length
      branch. The port reads the view's offset; nothing held it.
      Equivalent: the long path's `seed !== 0n` shortcut (a secret
      derived from seed 0 is the default one) and the reference entry's
      64-bit seed mask (its only caller, `bunXxHash3`, has already cut
      the seed to 32 bits).

833.  DONE (2026-09-26, the playground's platform shims: `vfs.ts`,
      `node-fs.ts`, `node-fs-promises.ts`, `platform.ts`). Core's parity
      rows plan whole workspaces through them and held 4 of 28
      mutations: the directories a file implies, a listing's
      subdirectories, the hash's seed, and `setEnv`'s assignment. The
      rest were reachable and unheld. `tests/playground-shim.test.ts` in
      `vx-docs` now holds 25, each answer as the real call gives it:
      - the VFS: `.`/`..` normalised, reads recorded normalised, a
        directory's stat, a file's size, a listing's own entries only
        (not a sibling sharing its prefix), the root, a missing
        directory, ENOENT codes;
      - `node:fs`: `throwIfNoEntry: false`, `existsSync` true for a
        directory, bytes without an encoding;
      - `node:fs/promises`: ENOENT from all four readers, names or
        entries from `readdir`, bytes without an encoding;
      - `Bun`: `file().exists()` false for a directory, a missing
        read's ENOENT, `semver.satisfies` answering the range, and
        `setEnv` dropping the last environment.
        Equivalent: `process.platform` as `darwin`. Discovery's two
        per-platform strategies answer identically by design
        (`findConfigFile`), and parity agrees. The worktree's
        `playground-view.test.ts` needs a built `dist/`, so it failed
        at load under every mutant; its column was read as no signal,
        not as a catch.

834.  DONE (2026-09-26, the playground's `glob.ts`, the 651-line port of
      Bun's matcher that item 692 wrote and no sweep had named). 51
      mutations: 31 caught by the Bun-oracle fuzz, 6 held now, 14
      equivalent. The survivors' pairs were found by a differential
      search: each mutant against `Bun.Glob` over a wider alphabet
      (multibyte characters, escapes, ranges, nested braces), with a
      step cap so a looping mutant skips a pair instead of hanging.
      Held in `tests/playground-glob-sweep.test.ts` and
      `-utf8.test.ts`, each pinning Bun's own answer:
      - a star's backtrack resumes one character on, not one byte;
      - the globstar is a copy of the wildcard, not an alias;
      - a backtrack resumes only inside the path;
      - a branch's globstar looks back only to its own branch start;
      - `\t` is a tab;
      - a dangling `\` with path left to match fails.
        Two files, because three of these mutations loop forever on
        other pairs, and a synchronous loop cannot be bounded inside a
        row. Each mutation has a file that fails on it without looping.
        Equivalent:
      - six decode branches (overlong, bad continuation, out of range,
        a 5-byte lead, a zero-filled tail) that well-formed UTF-8 from
        `TextEncoder` never reaches, and `\a` in a class (it decodes
        to `a` either way);
      - three redundant guards: the FIXME clause's `isEndInvalid`, the
        `!inGlobstar` reset, and the literal-`/` wildcard reset (a star
        re-entered at a separator resets it);
      - the multibyte literal's bounds check (a complete sequence);
      - the at-end wildcard bump (already past the path);
      - `braceDepth > 0` before a skip (no stacked frame encloses a
        `,` or `}` outside every group);
      - the unterminated group's skip (past the glob either way).

835.  DONE (2026-09-26, the playground's `entry.ts`, what the bundle adds
      to core's planner). 21 mutations: 12 held by the parity rows, 6
      held now, 3 equivalent. Held in
      `tests/playground-parity.unsafe.test.ts` § item 835, against the
      built bundle (core's source reads the host's `node:fs` unless it
      is bundled behind the shim):
      - a key the simulated cache holds is a hit, the others unmoved;
      - a package with no config file is planned around;
      - an invalid config is refused naming its file;
      - an unknown task is reported unresolved, and reads are counted;
      - a project listing started in the same tick as a plan waits for
        it, so each sees its own workspace.
        Equivalent: cloning the caller's configs (core's plan never
        writes to them; the row's snapshot stays as the control), the
        missing-file refusal in the OID reader (every VFS file is tracked
        and clean, so the fold takes its trusted OID and never asks), and
        `closure: false` (with every project a seed, the closure branch
        never runs). A first cut of the listing row awaited the configs
        before the plan started, so the two never overlapped. The
        mutation survived until both started in one tick.

836.  DONE (2026-09-26, the playground's `config-eval.ts`: the reader's
      config rewritten to import only `@vzn/vx`, then evaluated in a
      Worker or in process). 34 mutations: 10 caught by the rows there,
      16 held now, 8 not holdable (reasons below). The tokenizer's cases
      were found by a differential search over lexical fragments, then
      written as a config would spell them. Held in the site's
      `tests/playground-config-eval.test.ts`:
      - left alone: a non-ASCII identifier ending in `import`, an
        escaped `${` in a template, an escaped `/` and a `/` in a class
        inside a regular expression, a regular expression opening the
        module;
      - refused: an import after an empty template, after an object
        inside a template expression, after a division of an index or
        of a template, and `import('@vzn/vx' + …)` as computed;
      - an import after a local export list rewritten once, not twice;
      - both evaluators: `null` is not an object, a function is not
        JSON, a throw keeps its name; and a Worker left with a running
        interval is terminated (a subprocess row: without it the
        process ran 10 s, against 17 ms).
        Equivalent: the `${` depth push (balanced either way), a
        comment's newline (whitespace), the non-JSON check before
        `json` is read. Reachable only through text that is no module,
        whose evaluation fails either way: an unterminated string at a
        line's end, a regular expression opened at a line's end (its
        flags read the next line's word), and two invalid import-clause
        shapes. Not observable under Bun: the Worker error's
        `preventDefault` (a browser's console only). The first cut of
        the escaped-`/` row was held by the regex's own flags, which
        swallowed the `import` right after it. The row now leaves a
        space.

837.  DONE (2026-09-26, `vx-docs`'s `scripts/import-docs.ts`, which turns
      `packages/vx/docs` into the site's pages). The script ran at
      import time, so no test could call its transforms. A per-mutant
      harness that re-ran it and fingerprinted its output measured the
      cost: 2 of 34 mutations held. 24 changed what the site serves with
      every row green (a wrong link prefix, a lost anchor or title, an
      unescaped placeholder, a missing description or edit link,
      unsorted design notes), and 8 left the output byte-identical on
      today's tree. It is now a module: `importDocs(docsDir, outDir)`
      runs only as the entry point, the link map is passed explicitly,
      and the transforms are exported. The refactor wrote all 157 pages
      byte for byte as before. `tests/import-docs.test.ts` holds 32:
      URLs and output files, link resolution (`.`/`..`, directories,
      anchors, titles, protocol-relative and unknown links left alone),
      placeholders escaped only in prose, fences closing on their own
      marker, the title, description and edit link, the description's
      skips and cut, the design index's order, and a run that clears a
      stale generated page and keeps an authored one. Equivalent: the
      link key's trailing-slash strip (`normalize` already drops it) and
      the duplicate-output guard (unreachable while `outRelFor` is
      right; it stays as the defence).

838.  DONE (2026-09-26, `vx-docs`'s `scripts/build-playground.ts`, the
      build of the planner bundle). 15 mutations: 6 caught by core's
      parity rows, 4 held now, 5 equivalent. Held in
      `tests/playground-build.test.ts`, from a fresh build:
      - each of the seven platform specifiers the planner's graph names
        is met as the shim, the polyfill or a stub (`bun:sqlite` as the
        shim);
      - each names its importers relative to `packages/`;
      - no stub export survives tree-shaking (without `@__PURE__`, the
        `node:module` stub's dozens of exports stayed);
      - the file is minified (60 lines, against 5,842).
        Equivalent: the aliases for bare `fs`, `fs/promises` and `path`
        (nothing in today's graph imports those spellings; they stay for
        the day something does), the stub proxy's `then` guard (a stub
        is never awaited on the plan's path), and the refusal of a failed
        build (it rejects either way, only with another message).
        `vx-docs`'s scripts are now swept.

839.  DONE (2026-09-26, a stale name). `choosing.ts` said its sources
      are checked by `tests/learn-choosing.test.ts`, a file that was
      renamed to `compare.test.ts`, which still holds both checks (every
      other tool's cell links that tool's docs; every vx cell a site
      page or a test row that exists). A scan of every tracked code file
      for a `tests/….test.ts` that does not exist found no other stale
      name. It found four references a law would have to exempt: a label
      beside its full URL, a CI comment on core's suite, a prose
      mention of another package's test, and a hypothetical in a
      comment. So there is no law; the scan is recorded here instead.

840.  DONE (2026-09-26, the playground page's model,
      `src/components/demos/model/playground-view.ts`: the Run, the
      results table's words, the env and task fields, the static table).
      46 mutations: 35 caught by the rows there, 11 held now, none
      equivalent. Held in `tests/playground-view.test.ts`, over a fake
      planner where the real one cannot reach the case:
      - a discovery that throws is refused with its message;
      - only projects with a config file are evaluated;
      - tasks sort by config task order within a project;
      - the cache keeps the keys it held;
      - a plan with no task is refused in the CLI's words;
      - an env line with no `=` is refused;
      - `^task` names only used packages that declare it, and
        `pkg#task` is taken as named;
      - a config needs its manifest and a manifest its config;
      - `uses` names only workspace packages.
        The worktree runs these against a planner built into its
        `dist/`, as the site's `build` task does.

841.  DONE (2026-09-26, the site's diagram kit,
      `src/components/guide/diagram/diagram.ts`: box sizes, arrow
      routing, the drawn stretch, timeline lanes, the phone layout). The
      kit's laws (`diagram-kit.test.ts`, `landing.test.ts`) read the
      built pages, so they see a change here only after a site build. A
      worktree cannot build the site: astro refuses the symlinked
      `node_modules` from outside the project. Against the pages already
      built, those laws held 1 of 32 mutations; what a full rebuild
      would hold went unmeasured. `tests/diagram-geometry.test.ts` holds
      30 directly, with numbers worked out by hand:
      - sizes: 130 × 52 boxes, 60 with a sub line, 0.6 em a glyph;
      - arrows: the 3 and 5 gaps, the label's offsets across and down,
        45 degrees counting as across, waypoints aimed at by each end
        with the label on the middle stretch, an unknown box refused;
      - the drawn stretch: 14 of padding around boxes, notes, frames,
        waypoints and labels, stopping at 0 and at the picture's height;
      - lanes: rows, names, bar widths, labels and subs dropped when
        too narrow (margin included), titles and tones kept;
      - the phone layout: named apart, or none.
        Equivalent: the two `dx`/`dy === 0` guards in the exit point
        (`r.w / 2 / 0` is `Infinity` without them).

842.  DONE (2026-09-26, the doc laws' Markdown reader,
      `tests/helpers/markdown-anchors.ts`). The site's code with logic in
      it is swept (items 831–841; `one-run.ts`, `sections.ts` and
      `choosing-matrix.ts` are data, held by the landing, sidebar and
      compare pins). So the loop turned to the helpers core's laws stand
      on, where a lenient helper makes a law pass vacuously. Against
      the two `doc-references` laws, 4 of 13 mutations of this reader
      were caught. One survivor dropped every link's anchor, and the
      laws stayed green while they checked no anchor at all.
      `tests/markdown-anchors.test.ts` now holds all 13: slugs as
      github-slugger renders them at every level (closing hashes
      dropped, punctuation and dots removed, one hyphen per space), a
      repeat suffixed `-1`, `-2`, fences skipped however indented or
      spelled, links with their anchors and same-page anchors, and no
      URL of any scheme.

843.  DONE (2026-09-26, the Turbo / Nx parity suites' shared workspace,
      `tests/helpers/parity.ts`). 10 mutations against the parity, filter
      and output-shape suites: 7 caught (the dependency shape, `^build`
      and `build`, the commit a `[ref]` filter reads, the sort, the `--`
      split). One survivor was a row that proved less than its title:
      the Nx `{workspaceRoot}/tsconfig.base.json` row passed with the
      fixture's file never written, because creating the file moves the
      key too. It now reads the committed file before editing it, so
      it holds what it names: an edit to a tracked root file. Not held:
      `dry()`'s own throw on a non-zero exit (the empty stdout's parse
      fails either way) and the helper blanking `CI` and
      `GITHUB_ACTIONS`. No assertion in these suites turns on vx's CI
      mode, even with `CI=true` set around the run. It stays as the
      defence for the day one does.

## In flight

**The gate's runtime (settled 2026-09-21, item 572; plan F4).** A gate
under Bun 1.4.2 is the only gate: the 2026-09-19 container shipped
1.3.11, below `engines.bun: >=1.4`, and every "flapper" of that arc — the
shard-9 SIGILL (3 of 24 reps on 1.3.11, 0 of 24 on 1.4.2), the three
recorded failing tests, the inert symlink tripwires that scored three
containment guards as survivors — was the version. `bun upgrade` is
refused there; the release asset
`github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip`
downloads through the proxy and the gate with it first on PATH is 44 of
44 green. A shard failure under 1.4.2 is the diff's. The diagnosis of
the 23-test baseline as it stood on 1.3.11 is in
`docs/history/2026-09-status-next-log.md` § "In flight as it stood
2026-09-22"; the `ci` task refusing a Bun below the floor is plan F4.

**The sandbox arc (2026-09-05) is closed.** Its four Linux items closed
by 2026-09-10 (`docs/history/2026-09-status-next-log.md`); the fifth,
macOS violation reporting being lossy under load, is a recorded decision
since item 586 (Decisions below), not an open item.

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
2. OWNER: cut the release — the notes are drafted in
   `docs/history/release-0.1.0-notes.md` (item 581); a GitHub release with the tag is the whole
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
   violation reporting is lossy under load (In-flight 5);
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
2. DONE 2026-09-23 as item 662 (entry 14bj) — the remote seam streams: `get` resolves `Blob | Response`, `put` takes a file-backed `Blob`, every first-party layer moved in the same commit.
3. DONE 2026-09-09 as item 88 → `@vzn/vx-turbo` (history) — zero-migration adoption as a plugin on the `project` stage.
4. DONE 2026-09-10 as item 77 (history) — one core per process; the shipped binary serves its own façade to every `@vzn/vx` import.
5. DONE 2026-09-11 as item 148 — the watch e2e flake was the arm
   instant on the wrong clock; the macOS intermittent extra cycle stays
   recorded under item 130.
6. **Re-measure the warm run after each day's work** — the hot path is
   the product. CI wall time is the other number this duty carries
   (plan I2): 2:23–3:16 per push run on main over 2026-09-21's eleven,
   all three jobs; a run past six minutes is the signal to fold the
   heaviest witness files onto a shared fixture. `bun packages/vx-bench/run.ts 100 5` and `1000 5`; an interleaved
   A/B against an immutable worktree settles any gap
   (`scratchpad/ab.ts`-style: alternate arms, min and median of N).
   The closing figures of 2026-09-03 → 09-10 and the refutations
   recorded under this duty (a synchronous restore for small
   artifacts, discovery's stat memo, the `restore: rows` lead) are in
   `docs/history/2026-09-status-next-log.md`; the latest day's A/B is
   item 830 (2026-09-25, a tie at 100 and 1,000 projects; 285 was the one before), and the
   restore arm's floor is the note under item 193 (history). 2026-09-16, after item 225: 5,000 projects
   687 ms warm / 2,854 restore / 12,152 cold (medians of 3) against
   1,000's 231 / 718 / 2,436 — the warm stage table grows 3.4–3.9× for
   5× the projects (discover 23 → 89 ms, load configs 24 → 87, classify
   56 → 190, run graph 42 → 144), git's own enumeration 6× (9 → 55),
   nothing super-linear; the fixed ~30 ms of startup and workspace
   config is what makes 5,000 cheaper per project than 1,000. PARKED for
   the 2026-09-19 arc (items 341–362): it changed docs, comments and
   tests only, so there is no run-path delta to A/B, and the arc ran on
   a shared 4-core container whose own baseline fails 23 tests for
   environmental reasons — an absolute figure from it is not comparable
   to the table above, and an A/B has no arms. Re-measure on the first
   run-path change. REFRESHED 2026-09-20 (item 420): this container, at
   1,000 projects, reads warm 271 ms / restore 1 031 / cold 3 147, and at
   5,000 warm 807 / restore 3 931 / cold 14 181 — the dev box's figures
   below are a DIFFERENT MACHINE and only the 1k→5k scaling (×2.98 warm
   here against ×2.97 there) compares. The harness's warm arm spreads
   ±13 % on identical code. UNPARKED 2026-09-20 (item 404), with the
   container's own noise floor measured first: interleaved min-of-7, one workspace
   copy per arm pre-warmed by that arm, 1,000 projects warm all-hit —
   the A/B read 232.1 ms before against 218.9 ms after, and the A/A
   CONTROL (the same arm against both copies) read 246.4 against
   259.0. A 12.6 ms spread between identical code is the same size as
   the 13.2 ms "difference", so this box resolves nothing below about
   6 % even at min-of-7. Absolute figures here, for the record and not
   for the table: 1,000 projects warm 194–204 ms total
   (`bun packages/vx-bench/run.ts 300 3`: no-cache 987 ms, warm
   172 ms, warm-restore 329 ms). Any future claim on this container
   needs an A/A control beside it. 2026-09-22 (item 580), the sweep week
   (items 342–572, PRs #488–#681) as one arm: base 164.7 ms, head
   167.8 ms warm min-of-15 at 1,000 projects, A/A 170.1 against 169.2 —
   a tie. Item 588 (the additive hit path, every task's): main 173.5
   against head 170.5, A/A 168.3 against 164.2 — a tie. The COLD path
   has its own number since 2026-09-23 (item 615): 1,000 projects,
   `.vx` removed, 2,938–3,420 ms before against 2,680–2,997 after, the
   `load configs` stage 507–607 → 207–272; a cold arm is five reps with
   the cache removed before each, no A/A needed at that size. 2026-09-24 (items
   690–702, the day's run-path changes being the key fold's move to
   `key-fold.ts`, one config worker per repeat round and the JSON-data
   walk): base 39294a8d against head, compiled binaries, 1,000 projects
   warm, interleaved, n=25 — medians 266.5 ms before and 266.4 after,
   mins 245.1 and 230.8; A/A 270.4 against 264.8 (mins 238.5, 238.1).
   A tie; a first n=15 pass read the mins the other way round (225.9
   before, 251.8 after) with the same tied medians, which is the box's
   min-of-N noise, not a cost.

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
    197, 202, 208, 211, 214, 221, 225, 230, 236, 240, 242, 252, 263,
    270, 275, 281, 287, 293, 299, 305, 312, 319, 326, 332, 383 and
    394, 400, 403, 409, 412, 419, 426, 432, 441 and 452 (14–14ap) are
    in `docs/history/2026-09-status-next-log.md`; items 453–572 are in
    `docs/history/2026-09-improvement-loop-453-472.md` through
    `-553-572.md`; items 573–591 are in
    `docs/history/2026-09-improvement-loop-573-591.md`, 592–611 in
    `docs/history/2026-09-improvement-loop-592-611.md`, 612–631 in
    `docs/history/2026-09-improvement-loop-612-631.md`, 632–654 in
    `docs/history/2026-09-improvement-loop-632-654.md` and 719–743 in
    `docs/history/2026-09-improvement-loop-719-743.md` (entries
    14aq–14di and loop item 677 in the next-log file). The loop above
    is the record since 744 (14dj in the next-log file); 14dk is below,
    and the next entry written here is 14dl.
15. **The plan after the sweep week: `docs/design/plan-2026-09-22.md`.**
    Fixes F1–F6, improvements I1–I7, arcs D1–D5, in the order that
    document gives (F4 → F1 → F3 → F2; F5 → I1 → I4; D3 → D1, D5
    alongside, D4 with the owner, D2 when a workspace asks). Each entry
    names its seam, the constraint that must survive, the measurement
    and what not to do; strike an entry through there when its item
    lands here.

14dk. **Handoff after item 727 (2026-09-24, midday).** Since 14dj the
site was redone as one story and read on a phone: the Guide of ten
chapters on one toy monorepo, Docs and Reference around it, internals
out of the sidebar, one look, build-time pictures (721); the old Learn
pages retired with redirects (722); the widgets restyled and cut (723);
every picture, the cover, the graph explorer (724) and the scheduler's
charts (725) given a phone form, held by the diagram kit's laws, and
code blocks wrapped. Core alongside: a sandboxed task no longer reads
its own package through its self-link (720, `CACHE_VERSION` v30), nor a
linked sibling its key does not cover (726, v31, the Decisions entry on
narrowing core's grant), and a task downstream of a persistent task has
one key on both paths (727). WHAT STANDS: 14dj is in the next-log file
(§ Handoff 14dj); the loop holds 719–729. OWNER, unchanged: the site's read
(Next 16), cut 0.1.0 (the tag, then delete `NPM_TOKEN`), the scope list (roadmap 2.4), the soak length. NEXT: the owner's read of the short site (Next 16); the trim when the loop reaches twenty items; the warm-path A/B on the next run-path change (Next 6). Never end with "what
next?".

16. **The site, short (owner, 2026-09-24, after 728).** Shipped as item
    729 (`design/site-short-2026-09.md`). Left: the owner's read.
17. DONE as item 744 — **Turbo 2.11 won warm at 476 packages on the Linux box (item 735).**
    Two one-rep runs read Turbo at 255 and 303 ms against vx's 334 and
    376 (restore: 436 and 446 against 524 and 478). Measure it min-of-N
    with interleaved arms, find where vx's warm path spends it at that
    size, and fix it or say so on the site. The 3,270-task run on the
    same box reads the same way: Turbo 496 ms warm against vx's 678.
18. **Re-run the site's benchmark with the fixed harness (item 735).**
    The landing's Nx numbers (34m 44s cold, 3,270 tasks, macOS) come
    from the harness that gave Nx npm; npm was two thirds of Nx's cold
    run at that size on the Linux box. OWNER: re-run `compare.ts 100 11
1` on the macOS machine and `update-site.ts`, or take the Linux run
    in `benchmarks.md` for the site. The Linux run of this exact shape
    (`compare.ts 100 11 1`, 2026-09-25, item 758) has vx leading every
    column; its generated `RESULTS.md` / `results.json` were not
    committed over the macOS run the site reads.
19. DONE as item 751 — **A sandboxed task's `kill 0` killed the
    sandbox (Linux, found in 736).** The command runs in a session of
    its own inside the sandbox.
20. DONE as item 752 — **A cancelled sandboxed task got no TERM grace
    (Linux, found in 751).** SIGINT and SIGTERM reach the command's
    group through fd 3; SIGKILL stays the group's.
21. **The rest of the 476-package warm profile (item 753).** In order
    of measured saving, each on a patched copy (interleaved, stage
    mins): scheduler priorities over the exec tier only (DONE as item
    754); one multi-row insert for the run's history rows (REFUTED
    2026-09-25: 40-row INSERTs made 85 rows three statements, and a warm
    476-package run's `record history` stayed 8.2 → 8.6 ms at min, wall
    174.3 → 176.6, N=21; the 5 ms the profile saw was skipping the
    rows, and binding 21 columns a row is the cost, not the statement
    count); `node:readline/promises` imported only by
    the picker (REFUTED 2026-09-25: two compiled binaries, one importing
    it beside the other node: modules vx loads, differ by 0.27 ms at min
    and 0.1 at median, 41 interleaved; the 2.5 ms was the source run's
    transpile under the profiler); `git rev-parse` in the enumeration
    as an async spawn beside the others (REFUTED 2026-09-25: as a fourth
    spawn in the `Promise.all`, two interleaved passes of 21 read min
    168.7 → 171.8 and 165.5 → 183.8 ms; the sync spawn's block overlaps
    git's own run, which is the enumeration's wall anyway);
    the group hash computed once instead of in the stable-key pass and
    again at execute; and `resolveFiles`' memo checked before it builds
    its key (both declined in item 756). The large lever, persisting
    last run's stable keys, is designed and DEFERRED (item 756).
    (`vx-bench/strace-vx.ts` counting git's worker threads as vx: fixed
    in item 755.) DONE through items 753–756.
22. DONE as item 771 — **`baseAllowWrite` had one value (item 770).** Core sends `[]` on
    every sandboxed request, so the field on `ExecuteSandbox` and
    `SandboxedRunArgs` is a knob no producer turns; an executor plugin
    reading it learns nothing. Remove it from the seam and let the
    runtime's own write set be `allow.write` alone. Three runtime rows
    pass it as a direct write grant (two of them macOS `sandbox-exec`
    rows, which this box cannot run) and move to `allow.write` in the
    same change, proven on the darwin CI job.
23. **Two signal rows went red once each, root cause unproven
    (2026-09-25).** (a) `watch-signals.test.ts` › "SIGINT during the
    initial run reaches its task as SIGINT", on the macOS job of #878.
    The recap cut the assertion, it passed on the same code in #879, and
    it passed 49 of 49 Linux repetitions. (b) `signal-handling.test.ts`
    › "at the moment vx exits on a signal every task process is gone and
    its pipes are closed", in a full local gate. On SIGINT one task pid
    was alive at vx's exit; the shard passed 4 of 4 alone and a gate
    re-run passed. Under the sandbox `procfsIsOwn()` is false, so the
    test's `isAlive` counts a zombie, and `slow`'s `sleep 30 &` starts
    with SIGINT ignored and dies only to the SIGKILL. An orphan zombie
    that init has not reaped yet is the leading suspect, not a proven
    one. Both rows now print what they saw on a mismatch (item 804); the
    next failure names the process and what vx said, and this entry
    closes on that evidence.

## Decisions (this arc)

- **Persisted stable keys: deferred (item 756).** Designed and
  prototyped (`docs/design/persisted-stable-keys-2026-09.md`): 13–21 ms
  of a 476-package warm run, exact-repeat runs only, and any input the
  digest misses is a stale hit on every run. Not built while vx leads the
  warm column; revisit on a measured warm-no-op loss or an agent-loop
  workload, and land only through that doc's gate.
- **Once per run (owner, 2026-09-24, item 732).** Within a run nothing
  outside vx changes the files it reads; what vx learns once (a read, a
  stat, a PATH lookup, a spawn's answer) it reuses, and only vx's own
  writes or its tasks' runs invalidate a fact. A repeat that stays has a
  measured reason in a comment and in the strace laws that pin it.
- **Tools resolve on vx's own PATH (item 732).** The task's PATH decides
  what its command runs, never which shell parses it.
- **What a cached task may write undeclared (item 750).** Its own
  inputs, in place (a formatter), and nothing else: its key names those,
  so a reader folding it is covered. A root-project task may rewrite the
  lockfile; the run watches for it. An `inputs.runtime` answer is the
  environment, asked once per run and never re-checked: a task that
  changes it is out of contract, and a file another task writes is
  declared as an input instead.
- **Every project's lockfile key folds the root importer (item 733).**
  What the root declares is reachable from every task.

- **Declaring `cache` may narrow core's own grant, never widen one
  (owner-delegated, 2026-09-24, item 726).** The user's `sandbox.allow`
  still derives nothing from `cache` (2026-09-05). Core's implicit
  `node_modules` link grant is bounded by the key for a task that
  declares `cache`: a linked workspace package is granted only when the
  key folds a task of it, because an unkeyed read is exactly the stale
  hit the sandbox exists to rule out. A task with no `cache` keeps the
  whole grant, having no key to be stale. The coverage is per package,
  not per file (an edge to `ui#source` also admits `ui/README.md`), the
  same limit a grant wider than a task's own inputs already has.

- **macOS violation reporting is lossy under load, and stays so
  (2026-09-22, item 586).** The store is fed by the unified log, which
  drops records under pressure; the settle window that halved the loss
  cost 300 ms per clean sandboxed task and went 2026-09-05 (owner); no
  unprivileged channel reports a denial the child survived. Enforcement
  is unaffected and the Known limits page says so. Not an open item.
- **`--affected` includes dependents (2026-09-16).** The sugar is
  `--filter '...[<base>]'`: the changed projects and everything that
  depends on them, the superset a CI gate needs and what the guides
  promised; `--filter '[<base>]'` is the changed-only form for "test
  what I touched". Item 287.
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
