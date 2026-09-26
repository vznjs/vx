# Shipped, 2026-09 — improvement-loop items 820–852

The record `docs/STATUS.md` carried until 2026-09-26, moved here whole
when the loop reached forty items (item 859). A PREFIX,
as item 373 set the rule: the formatter renumbers an ordered list
sequentially, so a cut from the middle would renumber every entry below it
and break the cross-references that cite item numbers here, in STATUS and
in the test comments.

Items 1–64 in
`2026-09-review-arc.md`, items 65–104 in
`2026-09-improvement-loop-65-104.md`, items 105–144 in
`2026-09-improvement-loop-105-144.md`, items 145–202 in
`2026-09-improvement-loop-145-202.md`, items 203–242 in
`2026-09-improvement-loop-203-242.md`, items 243–281 in
`2026-09-improvement-loop-243-281.md`, items 282–305 in
`2026-09-improvement-loop-282-305.md`, items 306–332 in
`2026-09-improvement-loop-306-332.md`, items 333–352 in
`2026-09-improvement-loop-333-352.md`, items 353–372 in
`2026-09-improvement-loop-353-372.md`, items 373–392 in
`2026-09-improvement-loop-373-392.md`, items 393–412 in
`2026-09-improvement-loop-393-412.md`, items 413–432 in
`2026-09-improvement-loop-413-432.md`, items 433–452 in
`2026-09-improvement-loop-433-452.md`, items 453–472 in
`2026-09-improvement-loop-453-472.md`, items 473–492 in
`2026-09-improvement-loop-473-492.md`, items 493–512 in
`2026-09-improvement-loop-493-512.md`, items 513–532 in
`2026-09-improvement-loop-513-532.md`, items 533–552 in
`2026-09-improvement-loop-533-552.md`, items 553–572 in
`2026-09-improvement-loop-553-572.md`, items 573–591 in
`2026-09-improvement-loop-573-591.md`, items 592–611 in
`2026-09-improvement-loop-592-611.md`, items 612–631 in
`2026-09-improvement-loop-612-631.md`, items 632–654 in
`2026-09-improvement-loop-632-654.md` (655–713 are handoff entries in
`2026-09-status-next-log.md`; the audit's 714–718 were dropped, as that
file records), items 719–743 in
`2026-09-improvement-loop-719-743.md`, items 744–778 in
`2026-09-improvement-loop-744-778.md`, items 779–819 in
`2026-09-improvement-loop-779-819.md`; items 853 onward continue in
`docs/STATUS.md`.

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

844.  DONE (2026-09-26, the `VX_REQUIRE_*` gates in core's test helpers).
      The sandbox, root and watch-delivery gates each carried their own
      copy of one truthiness rule ("armed unless empty, `0` or `false`").
      A gate is observable only when it fires, which on CI it never does.
      `workflow-runner.unsafe.test.ts` proves each is set and forwarded,
      not that it would fail a run. The rule is now one `envFlag(name)`
      in `helpers/env.ts`, which the three gates read.
      `tests/gates.test.ts` pins its table (unset, empty, `0` and `false`
      in any case are off; `1`, `true`, `yes` and `00` are on; it reads
      only its own name). It also fires the root gate with
      `process.getuid` stubbed: as root and required it fails naming the
      row, as root alone it skips, and not as root it runs. 7 mutations,
      all held. The sandbox and watch gates' own throws still cannot
      fire in-process, because both verdicts are memoised per process;
      they now share the pinned rule.

845.  DONE (2026-09-26, the darwin sandbox canary judges by a control and
      the artifact). `tests/helpers/sandbox-canary.ts` counted any failed
      leak task as enforcement, so a sandbox that never ran a command at
      all read as ENFORCED, and a leak whose task failed for another
      reason too. Each iteration now runs a `control` task that reads a
      declared file under the same sandbox; unless it succeeds with the
      declared bytes, the iteration is RUN_ERROR. And the secret in
      `out.txt` is NOT_ENFORCED whatever the status said. Probed both
      ways on Linux: 3 iterations enforced, and a control pointed at the
      undeclared file turned the run into RUN_ERROR, exit 1.

846.  DONE (2026-09-26, the fixture helpers every suite builds on).
      `tests/fixture-helpers.test.ts` pins `tests/helpers/workspace.ts`,
      `local-workspace.ts` and `plugin.ts`: each `makeWorkspace` option,
      `gitIn`'s throw and its signing-off flags, `addProject`'s manifest,
      scoped path and empty maps, the workspace source, and the plugin
      root's dead-pid sweep (driven in a child under its own `TMPDIR`).
      42 mutations: 40 caught (one re-expressed after it failed to run),
      two equivalent (the name memo recomputes the same directory). Four
      survivors on the first pass drove rows: an empty config string, a
      hooks text that is not `{}`, a name holding the prefix mid-way,
      and the helper's own signing flags. The sweep taught
      method 8 of the sweep doc: one mutant of the dead-root check
      removed every entry of the host's `/tmp`, so every mutant now runs
      under its own scratch `TMPDIR`.

847.  DONE (2026-09-26, the orchestrator and watch-loop fixtures).
      `tests/fixture-helpers.test.ts` now also pins
      `tests/helpers/orchestrator-fixture.ts` and `watch-loop.ts`:
      `NO_CACHE` and `FORCE` equal what `parseRunArgs` resolves
      `--no-cache` and `--force` to, the silent logger's order and
      per-task bodies, the stamp command, `until`'s await and its
      timeout message, `executions` and `initialOnly`, and the watch
      fixture's app, its build, and its teardown (the case's watch is
      killed and both directories go). 30 mutations: 29 caught, three of
      them after rows for first-pass survivors (a promise judged truthy
      unawaited, zero executions passing `initialOnly`, a stale
      `f.watch`). One is equivalent: the kill grace set before or after
      the caller's env, which no caller overrides.

848.  DONE (2026-09-26, a Ctrl-C left vx's temp files behind). A signal
      exit is `process.exit` in `signals.ts`, which runs no `finally`
      and awaits nothing, so three files outlived it: the run lock's
      `h-<pid>-…` entry (and its directory), each running sandboxed
      task's `vx-strace-<tag>.log`, and a signed Turbo download's
      `vx-turbo-*` temp in `@vzn/vx-migrate`. Found in the audit after
      the item 846 wipe: two gates had left strace logs in `/tmp`.
      Reproduced with a sandboxed `sleep 30` and SIGINT. Each owner now
      lists what it holds and removes it synchronously on the process's
      `exit` event, the one step every exit path passes. Rows: the lock
      after one signal and after the immediate second, the strace log,
      and a child process that exits with a verified body unread. Each
      row checks the file exists before the signal, and each fails
      without its hook. A `kill -9` still leaves all three, which the
      lock reclaims.

849.  DONE (2026-09-26, a Ctrl-C skipped every plugin's teardown).
      `plugin.md` promises each sink's `flush()` and each plugin's
      `teardown()` at the end of every run. A signal exited through
      `process.exit` straight after killing the children, so a Ctrl-C
      or a CI cancel ran neither. Found by following item 848's class
      one layer up, and reproduced with a plugin whose teardown writes
      a file. `@vzn/vx-github` writes its job summary and posts its
      check run in its sink's flush, so a cancelled CI run got neither.
      Now `run()` holds one `AbortController` that both
      `RunOptions.signal` and the process handler abort. The scheduler
      stops dispatching, `run()` awaits its own abort teardown before
      it leaves, and the handler waits for `run()` to leave (bounded by
      the grace, one flush and each teardown at their bound, plus 2 s)
      and for stdout to drain. Then it exits 128+signo; a second signal
      still exits at once. The first cut ran a separate shutdown beside
      the run's own path. It flushed twice, and it let vx exit before a
      SIGINT-ignoring grandchild's SIGKILL; the kill-at-exit row caught
      that on SIGINT, 3 of 3. Rows: SIGINT gives `flush`, `teardown`,
      then exit 130; a second signal does not wait for a teardown that
      hangs. Both fail on the old code. The first gate failed the
      kill-at-exit row under the sandbox, 4 of 4, with `slow`'s TERM
      trap printing after 0.5 s. The suite was not running at the grace
      it claims: `Bun.spawn` without `env` passes the STARTUP
      environment, not `process.env` as the file sets it (probed, Bun
      1.4.2), so every vx the file spawned ran on the 2 s default. The
      old code passed that row only because `process.exit` won the race
      against the trap's output. Each spawn now passes `env`, and the
      file runs at 200 ms.

850.  DONE (2026-09-26, the warm A/B for items 848–849). Both changed
      the run path: an `exit` hook in the run lock and the sandbox
      runtime, and a second `AbortController`, a promise and an awaited
      teardown in `run()`. Base 52ae37c9 (before 848) against main
      4785436a, source bins, 1,000 projects warm all-hit, one workspace
      copy per arm pre-warmed by that arm, n=21 interleaved: base min
      258.4 / median 285.4 ms, head 259.5 / 286.3. The A/A control
      (head against both copies) reads 260.8 / 275.1 and 252.0 / 275.3:
      an 8.8 ms spread at min against the 1.1 ms difference. A tie.

851.  DONE (2026-09-26, a cancelled run no longer reads as a failure).
      Since item 849, a signal-stopped run reaches every sink's flush,
      so `@vzn/vx-github` now posted a cancelled CI job's check run too.
      It posted conclusion `failure`, titled "0 failed": aborted tasks
      are left out of the summary's task list (`run-records.ts`), and
      the record had no word of them. `RunSummaryRecord` gains
      `abortedCount` (`TELEMETRY_SCHEMA_VERSION` 2 → 3). vx-github posts
      `cancelled`, "cancelled · N aborted", with a ⏹️ verdict, when a
      run is not ok, nothing failed and something was aborted; a failure
      beside aborts stays a failure. vx-otel carries
      `vx.run.aborted_count`. Rows: the summary of an embedder-aborted
      run reads 0 failed, 2 aborted, 0 tasks (`abort.test.ts`); the
      payload's three cases and the verdict glyph (vx-github); the span
      attribute (vx-otel).

852.  DONE (2026-09-26, a Ctrl-C of a dev server no longer reads as a
      crash). Item 849 lets a stopped run finish its own path, and the
      foreground keep-alive then named the server "exited with code
      130" after every Ctrl-C of `vx run dev`. That line is now printed
      only when the run was not stopped. The row (`signal-handling.test.ts`
      › "a Ctrl-C of a foreground server does not report it as exited;
      a server that exits is") carries its control, a server that exits
      3 on its own is named, and it fails without the guard. The PR's
      macOS job then failed "SIGINT to vx reaches a one-shot task as
      SIGINT": `got.txt` was never written. Item 849 put the file on the
      200 ms grace it had always claimed, and a loaded runner SIGKILLed
      the shell before its trap ran. The four `reaches` rows test which
      signal arrives, not the escalation, so they now pass a 5 s grace;
      vx exits when the child does.
