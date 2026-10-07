# Caching

`@vzn/vx`'s cache is content-addressed, opt-in per task, and shaped to
cascade through the dependency graph the same way Turborepo's does.
This page explains _what's in the cache key_, _what triggers
invalidation_, _what's actually stored_, and _why_.

## Why caching is opt-in

A task is cached iff its `TaskConfig` provides a `cache` block, with
**both** `inputs.files` and `outputs.files`. Omit `cache` and the
task always runs; no read, no write.

The reasoning:

- **Defaulting caching ON with implicit globs leads to silently stale
  builds.** The first time a user forgets to revisit their config to
  add an input, the cache returns a hit for an out-of-date snapshot.
  Stale hits are the worst failure mode of a task runner — they erode
  trust in the cache itself.
- **Forcing declaration makes "what does this task read?" and "what
  does it produce?" conscious choices.** The user pays a one-time
  cost (write the globs) for a permanent gain (the cache key actually
  reflects reality).
- **The cost of a forgotten cache miss is small.** A task re-runs.
  The cost of a stale cache hit is large. Asymmetric risk justifies
  asymmetric defaults.

Turbo defaults caching ON for `outputs: []` tasks; Nx requires you to
opt _out_ via `cache: false`. We chose the strictest of the three.

## Cache key derivation

The cache key for one task is a **16-hex xxHash3 digest**, seed-chained
over (in order):

1. **`CACHE_VERSION`** — the key-derivation sentinel
   (currently `'vx-cache-v40'`, in `src/cache/key-fold.ts`). Bumped when
   the key derivation or the artifact container changes, or stored bytes
   are wrong under an unchanged key. See
   [§ Bumping CACHE_VERSION](#bumping-cache_version).
2. **`taskId`** — `${projectName}#${taskName}`. Two tasks with
   identical everything else still produce distinct keys — protects
   against e.g. `pkg-a#build` accidentally cache-hitting on a
   `pkg-b#build` entry.
3. **Workspace fingerprint** — xxh3 of every supported workspace
   marker found at the root (see
   [`modules/fingerprint.md`](./modules/fingerprint.md)):
   `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`,
   `yarn.lock`, `bun.lock`, `bun.lockb`, `pnpm-workspace.yaml`,
   `.yarnrc.yml` (Yarn 4 catalogs, which `yarn.lock` does not record),
   `.npmrc` and `bunfig.toml` (install settings no lockfile records),
   and the content of each patch the Bun lockfile names under
   patchedDependencies (it records a patch by path alone). Any
   install-resolved change (a `bun install` that bumps `bun.lock`) or
   any workspace-shape change invalidates _every_ cache entry. This is
   the single global "the world changed" lever — and a plugin can take
   one file off it: `VxPlugin.fingerprint` claims a lockfile, core
   leaves it out of this digest, and the plugin's `key` hook folds what
   the file means for each project instead (`@vzn/vx-lockfile`'s `pnpm()`
   folds the project's own resolved dependency closure and the root
   package's, so `pnpm update foo` re-keys only the projects that depend
   on `foo` — every project when the root does, since the root's tools
   run from the root `node_modules/.bin` on every task's PATH; its `bun()` is the same
   for `bun.lock`, and this repo declares that one). The
   config-evaluation cache still keys on every file: a config may import
   a dependency the lockfile resolved.

   The fingerprint is read once per run, before any task. A task in the
   root project may rewrite one of these files — `pnpm install` without
   `--frozen-lockfile` updates the lockfile and the installed tree — and
   every key taken before it names the old one. So a task that may
   (unsandboxed in the root project, or granted a write over one) tells
   the run when its command ran, the run re-checks the files then (one
   `stat` each, following a symlink as both reads do — an `lstat` missed
   a lockfile rewritten through a link, item 760 — the bytes compared
   for any written since the read), and
   once one moved nothing keyed on the old digest is probed or saved for
   the rest of the run, with one status line naming the file. Every
   reader after such a task is keyed late, not up front. Without it the
   run after a lockfile rewrite restored a build made against the old
   install, and a save filed a build against the new install under the
   old lockfile's key, replayed whenever the tree went back (item 750,
   [`modules/fingerprint-watch.md`](./modules/fingerprint-watch.md)).

4. **Project `package.json` hash** — the git blob OID of the project's
   `package.json`: the index OID when the file is tracked and clean,
   else `cache.hashFile`'s blob OID of the worktree bytes (empty when
   there is none). Folded in implicitly (Turbo / Nx parity).
   Covers the case where `cache.inputs.files: ['src/**']` is narrow
   and a `package.json` dep change would otherwise leak undetected.
   (Added at v12; rationale in [§ History](#history).)
5. **Task config hash** — `xxh3(JSON.stringify(hashableConfig(node.config)))`
   of the _evaluated_ task config. The projection is one field wide:
   `exec.remote` is dropped, because it says WHERE a task runs and not
   what it does (§ What's NOT in the key). Captures:
   - `exec` block (command, env declarations, timeout, persistent).
   - `dependsOn` and `cache.inputs.tasks` declarations.
   - `cache.outputs.files`, `cache.inputs.files`, `cache.inputs.env`,
     `cache.inputs.runtime` / `workspaceRuntime` declarations (the
     strings themselves; their resolved file content / env values /
     command output contribute separately).
   - `description` (because it's part of the resolved object — even
     though it has no behavioural effect; a description change isn't a
     correctness change but the cost of a re-run is low).
   - **Imported / computed values** — anything a preset or
     `process.env`-read at config-load time injected. Bun's native
     `await import()` evaluates the module and bakes those values into
     the object before we serialize.
6. **`forwardArgs`** — CLI args passed after `--`. Folded into the
   key so `vx run test -- --watch` doesn't cache-hit a previous
   `vx run test`. Scoped to the user-requested tasks only — dependsOn-
   pulled deps don't see them (their cache identity stays clean).
7. **`cache.inputs.env` resolved values** — `[name, value]` pairs
   read from host `process.env` at hash time (delimited `name\0value`
   so boundaries are unambiguous). Listed names get their current
   values; an unset name folds its bare name, with no `\0`, so unset
   and set-to-empty are two keys (the child tells them apart:
   `passThrough` leaves an unset name out). A name holding a NUL is
   refused at load.
8. **`cache.inputs.runtime` resolved output** — `[command, output]`
   pairs, where `output` is the trimmed stdout of each command run via
   `sh -c` in the **project dir** at hash time; a command with stderr
   (or a NUL in stdout) folds `\0<stdout length>\0<stdout><stderr>`,
   so bytes moved between the streams move the key.
   The runtime-output analog of step 7: the command _strings_ are in
   the resolved config (step 5), their _output_ is resolved live every
   run. Folded with the command count + each `command\0output` pair.
9. **`cache.inputs.workspaceRuntime` resolved output** — same as step
   8 but commands run at the **workspace root**, and the pairs fold
   into a **distinct namespace** (`ws-runtime-values:`) so an identical
   `(command, output)` never aliases the project-cwd `runtime` values.
10. **Filtered upstream task cache hashes** — every upstream task's
    own cache key, filtered by `cache.inputs.tasks` (default: all of
    them). Sorted by hash before folding so the ordering of `dependsOn`
    doesn't change the key. This is the cascade mechanism: if anything
    beneath you changes, your hash changes too. The set is `dependsOn`'s,
    never the run's selection: a dependency `--exclude-dependencies`
    keeps from running is still folded, with the key a full run would
    derive for it (nx#35234), so the flag moves no key. Its outputs are
    whatever is on disk, which nothing proves current, so a task whose
    key folds one, and everything built on it, may hit but does not
    save (`orchestrator/excluded-keys.ts`); a task with
    `cache.inputs.tasks: []` folds none and saves as usual.
11. **Plugin key material** — the `{ name: value }` pairs a plugin's
    `key(task, ctx)` stage returned for this task, stored on the node as
    sorted `plugin/name` pairs and folded after the upstream keys and BEFORE the input files,
    ONLY when non-empty — so a workspace with no `key` plugin derives
    byte-identical keys to one before the stage existed (no
    `CACHE_VERSION` bump when it shipped). `vx why` names a changed pair
    as `plugin <plugin>/<name>`. Two plugins of one package (a plugin's
    name is its package's) that return one name are told apart as
    `<name>`, `<name>#2`, … in value order, so declaration order still
    keys nothing (item 1028).

12. **Input files' content hashes** — `cache.inputs.files` resolved to
    a concrete list of project-relative paths (gitignore-aware,
    declared-outputs-excluded, nested-projects-excluded), each file
    contributing its **git blob OID** (v20). On a clean tree the OID
    comes straight from the index — the run's up-front enumeration is
    three concurrent spawns, `git ls-files -s -v -z` (every tracked
    path, its OID and its cache-state flag),
    `git status --porcelain -z -uall --ignored=matching --no-renames`
    (dirty tracked paths, the untracked files and the ignored ones) and
    `git var -l` (the clean-filter gate's config) — so deriving these hashes
    costs zero file reads and zero per-file stats. Each trusted OID's
    blob must be the size the index recorded for the file (A-60): `git
add` under a clean filter (`core.autocrlf=true`, a `text` rule)
    stores the LF blob of a CRLF file, and once the filter is gone git
    holds that stat-clean entry clean without re-reading it, so status
    and the filter gate (today's config) both let the LF blob key the
    CRLF bytes. Which paths an index distrusts is a function of its
    entries, so the verdict is kept in `blob_verdicts` by a hash of
    the index file and the pathspecs: a warm run reads the file and
    one row (the `--debug` listing and a lookup per entry cost 550 ms
    at 100,000 files). The key stands only for an index written before
    the run began and still in place after its listing, so a `git add`
    between the two cannot pair one index's verdict with the other's
    entries; any other run checks every blob. A changed index spawns
    `git ls-files -s -v -z --debug` for the recorded sizes, takes each
    blob's size from `blob_sizes` (fixed for its OID), and asks one
    `git cat-file --batch-check` for the ones not yet known (65 ms
    over 3,000 loose objects, 10 ms packed). The check is by size,
    so a filter that keeps the size (a `filter` driver such as
    `tr a-z A-Z`), removed after an add, still leaves a blob that
    stands for other bytes: probed, the run hit the build of the
    filtered bytes. Only a read of every trusted file would catch it,
    the cost the index OIDs exist to avoid. After changing a filter,
    `git add --renormalize .` makes the index describe the worktree
    again. A
    re-listing mid-run, or a nested repository's project, spawns
    `git ls-files -s --others --exclude-standard -z .` in the project
    dir instead, and its OIDs are not trusted: those files hash by
    content. `--no-renames`, because status pairs a deleted file with a
    similar unmerged path (a conflict mid-resolve) as its rename source
    and prints only `UU <path>`: the deletion went unsaid, the file kept
    its index OID, and the run hit the output built with it (A-59).

    Ref storage is not a key input: every ref vx reads comes from a git
    command, so a repository in reftable storage (git 2.45) keys every
    task as its files-backend twin (`tests/git-reftable.unsafe.test.ts`).

    A **submodule or an embedded repository** is enumerated by its own
    git: the workspace repository lists the nested one as a single entry
    (a gitlink, or `dir/` when untracked) and none of its files, so vx
    replaces that entry with the files `git ls-files` lists inside it
    (one spawn per nested repository per run, nested ones recursively),
    and those files hash by content rather than by index OID. That holds
    for a nested repository inside a project (`vendor/lib` under a
    `**` glob — until 2026-09-27 its files never reached the key, and an
    edit there was a hit on the old output), for a project inside one,
    and for a `workspaceFiles` glob. A gitlink whose directory has no
    `.git` (a submodule never initialised, or one whose `.git` was
    removed to vendor its files, the gitlink left in the index) has no
    repository to ask and `git status` says nothing of it: its files
    are listed by a walk and hash by content (A-61), so an empty one
    folds nothing. `--affected` follows the
    same shape — git reports the nested repository as one changed path,
    and every project under it is selected.

    A task with **no `cache` block** derives a key too — its dependents
    fold it (step 10) — and, declaring nothing, folds **every file in
    its project**: `**/*`, gitignore-aware, untracked files included,
    and its own outputs not excluded, since it declared none. So its
    key moves whenever it writes a file git does not ignore: a cached
    dependent misses once more after the upstream's first run and hits
    from the third. `vx why` on the dependent names the upstream as
    the moved component; on the upstream it says the file set moved
    and that no fingerprints say which. Ignore the outputs in git, or
    declare the block (`tests/uncached-upstream-key.test.ts` pins both
    arms).

    Declaring nothing, such a task may also have **written** anywhere
    in its project, so what the run learned about that project at its
    start — the git listing, the index OIDs, the `package.json` digest
    — is dropped once its command exits, pass or fail, and a later key
    re-lists and hashes by content. For the same reason a task after it
    in the same project (`dependsOn`, even with `tasks: []`) is never
    keyed up front by the local short-circuit or the remote prefetch.
    Without both, an uncached `gen` that copies a seed into a `build`'s
    declared `config.json` replayed seed B's build under seed A
    (turborepo#13788, item 743). A sandbox narrows the reach to its
    write grants: none reaches nothing, and a grant elsewhere in the
    workspace reaches every project. An unsandboxed write into another
    project crosses a project boundary and is not tracked, as for a
    cached task's undeclared write (`tests/undeclared-writes.test.ts`).

    A task **with** a `cache` block may still rewrite its own inputs in
    place — a formatter declaring `outputs: []` — and a same-project
    reader after it whose key does not fold its key (`tasks: []`, or a
    filter that leaves it out, on every path) is not keyed up front
    either: its key would be taken over the bytes before the rewrite, and
    seeds A,B,B,A replayed B on the fourth run (item 750). A reader that
    folds the rewriter's key keeps its up-front probe — that key names
    the rewriter's inputs, which are what it may rewrite. A cached task
    writing a file that is neither a declared output nor its own input
    is out of contract: a hit restores only what it declared.

    A file whose name is **not valid UTF-8** (Linux allows any byte
    but `/` and NUL) cannot be opened from a string, so it cannot be
    hashed: a task whose globs select one is refused by name, and so
    is a task whose declared outputs hold one, rather than the file
    dropping out of the key or the artifact without a word
    (turborepo#9345). Rename it, or exclude it with a negated glob.

    Your globs are a **filter over the set git reports**, so a filter
    can only ever remove — a gitignored file can never be filtered back
    in, however explicitly you name it. Naming one by hand is therefore
    a **hard error** rather than a silent nothing: it would leave the
    task ignoring a file its own config claims as an input, reporting
    `up-to-date` while that file changed. Turbo lets an explicit entry
    override gitignore; vx cannot, because the key would then depend on
    a change `git diff` cannot see and `--affected` would stop selecting
    the task. If the file is generated, depend on the task that produces
    it via `cache.inputs.tasks`. A **glob** matching nothing stays
    silent — that is legitimate — and so does a literal naming a file
    that does not exist. A literal naming a **directory** is judged the
    same way: an ignored one, or an empty one, has no file git lists
    under it, folds nothing, and is refused (item 576).

    A **bracket is literal** in a task glob, and there are no character
    classes (item 667): `app/[id]/**` folds the route directory
    `app/[id]`, and `app/\[id\]/**` is the same path. Read as a class
    — what `Bun.Glob`, Turbo and Nx do — it matched `app/i/…` and never
    the route, so the route's files keyed nothing (an edit replayed the
    old output, green) and an output declared under it cleaned an
    unrelated `app/i/page.js` before every run while the artifact
    saved nothing.

    An index OID is only trusted where git stores the worktree bytes
    **verbatim**, so the enumeration prunes it three ways:
    `git status --porcelain` drops paths whose working tree diverges;
    the `-v` flag on the same `ls-files` spawn drops `skip-worktree` /
    `assume-unchanged` entries, whose OID says nothing about what is
    (or isn't) on disk; and, once those spawns return, a clean-filter
    gate (a `git check-attr` spawn only when the gate needs one) drops paths where `text` / `eol` / `ident`,
    a `filter` driver, `working-tree-encoding`
    or `core.autocrlf` can rewrite bytes between index and worktree
    (the blob would be the LF-normalized form while the task reads the
    CRLF file). The gate costs nothing in a repo with no attributes
    and no `core.autocrlf` — see "Clean filters" below. And when the
    repository's config weakens the stat `git status` judges by —
    `core.trustctime=false`, or `core.checkStat=minimal` (whole-second
    mtime and size) — no index OID is trusted at all: a same-size
    rewrite that keeps its mtime (`cp -p`, `tar -x`) reads clean to
    git, and until 2026-09-27 (A-6) kept the old bytes' key. Every file
    is then hashed through the memo below, which keys on ctime and
    inode.

    Every pruned path, plus untracked files, falls back to an
    in-process `HASH("blob " + len + "\0" + content)` over the
    **worktree bytes** (sha1, or sha256 in `--object-format=sha256`
    repos), memoized in `file_hashes` on `(mtime, size, ctime, ino)`.
    A file changed within `FILE_HASH_RACY_MS` (50 ms) of its stat is
    hashed but not memoised; a ctime with no sub-second part, as a
    file system that keeps whole seconds writes it (ext3, HFS+,
    FAT/exFAT, some NFS), widens that window by a second, and an even
    second by two, since FAT32 keeps even seconds; a rewrite later in
    the same stamp keeps it (`racyWindowMs`; until 2026-09-27, A-2 and
    A-38, such a rewrite of the same size was a hit on the first bytes'
    output). That is the same value the index holds whenever no filter applies,
    so a file's contribution doesn't flip across dirty↔clean
    transitions. Folded as `(relPath, identity)` pairs, sorted for
    stability across OSes and walk orders. The identity is the OID
    prefixed by the file's git mode unless that mode is a plain
    file's: `100755:<oid>` for an executable, `120000:<oid>` for a
    symlink, the bare OID for 100644. The index gives the mode for a
    clean file, and the stat gives it for any other file (owner
    execute bit). A blob OID holds no mode, so until item 887 a
    `chmod +x`, or a symlink swapped for a file holding its target
    string, kept the key that `git status` and `--affected` saw move.
    Under `core.fileMode=false` (WSL's DrvFs) git reports no chmod, so
    there a clean file's mode comes from an lstat too, and its OID
    from the index (item 1076).

    A **symlink** folds as git folds it: the blob of its target
    _string_ (its mode-120000 index OID), whether it points at a file,
    a directory, or nothing. Retargeting a link changes the key; the
    bytes behind a link to a directory, or to a file outside the
    project, do not — `git diff` and `--affected` cannot see them
    either, so declare them with `workspaceFiles`. A link to a file
    inside the project tracks that file's content only when the file
    matches the task's input globs too: it is then an input of its own.
    A link under `src/**` to `other/data.txt` folds the link, not
    `other/data.txt`; name the target in the globs to track it.
    (Before 2026-09-09 a file link folded the
    bytes behind it and a directory or dangling link fell out of the
    input set entirely, so retargeting one was a stale hit.)

The composition is seed-chained (`xxh3(part, prevDigest)`) with a
label prefix per field, so two different field layouts can't collide.
Bun's xxHash3 reads only the low 32 bits of a seed, so `xxh3` feeds the
seed forward (`xxHash3(part, seed) ^ seed`) and the chain carries all 64
bits of state from step to step (item 682; `tests/hash-chain.test.ts`).
xxHash3 is non-cryptographic by design — cache keys need uniqueness
across honest inputs, not adversarial collision resistance.

## Cache lookup → restore

On a hit:

1. `cache.get(hash)` is **pure SQL**: the `entries` row carries the
   metadata and the captured stdout; the `output_files` rows carry the
   output fingerprints. The tar artifact is not touched by the probe
   (its existence is verified with one stat), so hit cost doesn't
   scale with artifact size.
2. If the on-disk output tree already matches the cached snapshot
   (size + mode + **millisecond**-mtime check against `output_files`),
   extraction is skipped entirely — the outcome reports **up-to-date**
   (`restored: false`). Mode and millisecond mtime ride the artifact's
   own `.vx-meta.json` sidecar — recorded from a stat while packing —
   so the index rows and the restored tree carry the identical values
   whether the entry was saved locally or ingested from a remote, and
   the comparison is exact in steady state. The check also requires the
   file's inode and ctime to equal the ones this machine recorded after
   the save or restore that last wrote it (`recordOutputStamps`). Size,
   mode and mtime alone cannot tell two entries apart when their
   outputs carry one fixed mtime (`tar -x`, `cp -p`, `SOURCE_DATE_EPOCH`)
   and one size: a v1 → v2 → v1 round trip reported up-to-date with v2's
   bytes on disk (item 886). No task can set a ctime, and a forged mtime
   (`touch -r`) moves the ctime too. The inode proves less than it
   seems: a restore unlinks the file and renames a new one in, and ext4
   hands the new one the freed inode (measured, item 941), so ctime is
   the guard. A row with no stamp (an ingest from a remote, or a file
   that had changed when the stamp was taken) is never current: the hit
   restores and stamps. The residual: ctime ticks on the kernel's coarse
   clock (4 ms at HZ=250), so a same-size rewrite inside the tick of
   vx's own write, in place or as a new file that took the same inode,
   with its mtime forged back, still matches.
3. Otherwise the task's declared outputs are wiped from the project
   dir (`cleanOutputs`) — see
   [§ Strict output ownership](#strict-output-ownership) — and the
   `outputs/<rel>` (+ `workspace-outputs/<rel>`) entries are extracted
   from `<cacheDir>/<hash>.tar.zst` into place.
4. Captured stdout is replayed to the live terminal via the logger —
   the framed block looks like a fresh run. (stderr is not cached —
   only successful runs are cached and their stderr is near-always
   empty; live runs still stream stderr normally.)
5. The task is marked `cache-hit` (or `cache-hit-remote` when the
   `LayeredCache` hydrated from the remote layer this run);
   `durationMs` is the wallclock for the restore op, not the original
   exec time.

The cached `exitCode` is preserved. A cached non-zero exit is
impossible by construction — see [§ Cache write](#cache-write) — and
"by construction" is literal: neither `save` nor `ingest` accepts an
`exitCode` at all, so the stored value is pinned to `0` rather than
supplied. The restore path still checks it, because the column outlives
this process: a row from a hand-edited or foreign `cache.db` with a
non-zero exit classifies the hit `failed` instead of restoring a broken
build's outputs under a green run.

### Local restore tier (two-tier scheduler)

`dependsOn` is an ordering gate, so a dependent normally can't even
probe the cache until its upstream finishes running. But a
**stable-key** task's key is provably independent of any upstream's
_outputs_ — its hit/miss status is knowable up front, and restoring
it needs none of its deps' output. So on local-only runs, `run()`
performs an up-front CLASSIFY (`orchestrator/local-shortcircuit.ts`):

1. Derive every stable, cacheable, local-read task's key (reusing the
   run's `hashCache` memo) and probe local `cache.get` **once**,
   building a `preProbed` map covering stable hits AND stable misses.
2. Confirmed hits become the **restore tier**: the scheduler makes
   them ready immediately (no dep gate, and no failed-dep→skip check —
   their key is dep-success-independent) but at LOW priority, so cache
   **misses own the worker pool and restores only backfill idle
   capacity**.
3. `execute-task` consumes `preProbed`, so the up-front probes ARE the
   probes it would have done, hoisted — no double work, and every task
   still flows through `execute()` so output is unchanged.

Stability gate (shared with remote prefetch via
`stable-keys.ts:deriveStableKeys`): a task whose input globs could
match a same-project upstream's declared `outputs.files` (compared by
literal prefix, less what its own `!` inputs take back whole; one with
undeclared writes reaches every input), whose
own `outputs.files` meet another same-project task's (it would restore
into that tree beside the producer's restore), or whose
`inputs.workspaceFiles` could reach any upstream's outputs, has a
_preliminary_ key and stays exec-tier / dep-gated. **Any**
`outputs.workspaceFiles` producer upstream also makes a dependent's key
preliminary, whatever that dependent reads: a root-anchored output is
boundary-ignoring by design, so it can land inside the dependent's own
project dir, where an ordinary project-relative glob reads it. Such a
dependent is therefore in NEITHER tier — it is excluded from probe
reuse as well as from the restore tier, because `execute-task` reuses a
`preProbed` hash verbatim, so probe reuse is itself a stale-hit path
when the key is preliminary. On top of that, an `outputs.workspaceFiles`
declaration keeps every task whose project directory its static prefix
can reach out of the restore tier — edge or no edge, because a
root-anchored output can land in any project's directory — and every
transitive dependant of one with it (their up-front keys fold a
preliminary key); a glob with no literal prefix reaches every project.
Before item 584 one such declaration emptied the tier graph-wide.
`rules.upfrontKeys` (on by default, X-54) refuses at load a task whose
input globs can match another task's declared outputs, so the clauses
on declared outputs fire only with the rule off; undeclared writes, an
`outputs.workspaceFiles` producer upstream, a rewriter the key does not
fold, and runtime probes after a writer still leave a key preliminary.
The
short-circuit never runs under a `LayeredCache` (remote prefetch owns
those runs — an up-front `get` there would put remote GETs on the
critical path), never fires with local reads off, and never throws —
any error degrades to the normal lazy schedule. Measured: −6.6% on a
mixed slow-upstream/warm-downstream workload; parity on all-hit warm
runs.

### Remote prefetch (async, remote-only)

When a run is backed by a remote cache — a plugin's `cache` capability
or an injected `RunOptions.remoteCache` layer — the network latency of
every remote GET
would otherwise sit on the critical path of the task that needs it.
So before execution starts, `run()` kicks off **background prefetches**:

1. Every cacheable task's key is derived once, up front, in
   topological order (reusing the run's `hashCache` memo, so
   `execute-task`'s later `computeTaskHash` for the same task hits the
   memo — no double hashing). This derivation touches **no cache layer**
   — keys only.
2. Each **stable-key** task's remote GET is fired concurrently under a
   bounded pool (the run's concurrency). The prefetch ingests a hit
   into the _local_ cache; misses/errors degrade to `false`.
3. Execution starts immediately — the prefetches race alongside it, so
   remote latency overlaps real work instead of blocking it.
4. When `execute-task` later calls `cache.get(hash)`, the `LayeredCache`
   **awaits the already-in-flight (resolved-or-pending) prefetch** for
   that key rather than starting a fresh round-trip: **at most ONE
   remote GET per key**, whether it was served by the prefetch, the
   lazy read-through, or both.

## A current tree: when a warm hit restores nothing

A hit whose outputs are already on disk should cost a few stats, not an
extraction. Two checks decide, both against rows the cache recorded when
the tree last matched the entry (`output_files`, and since 2026-09-03
`output_dirs`):

1. **The set.** The files under the declared output globs must be exactly
   the entry's files — no strays, nothing missing — because a restore
   wipes and rewrites the declared outputs, and a stray left in place
   would be a stale file the hit silently kept. Until Wave 6 this was a
   glob walk on every hit (0.36 ms each; 365 ms of CPU on a warm
   1000-project run). Now, for globs of the shape `<dir>/**` or a bare
   literal `<dir>` (a whole subtree — `wholeSubtreePrefixes`; a literal
   that names a file is recorded as a file, `mtime_ms` -2, and holds while
   a regular file stands there, its bytes being the per-file check's),
   the cache records every directory
   under `<dir>` with its mtime after each save and restore; on the next
   hit, unchanged mtimes on all of them prove the set unchanged, since a
   file added or removed anywhere the glob could see bumps its parent
   directory, and a new directory bumps the recorded directory that
   contains it. The rows are taken per task and written together — one
   transaction at the first read, at prune, at stats or at close, since
   item 622; a thousand commits at run end were the whole snapshot stage
   before — and a reader in the same process flushes them first. A
   save's or restore's snapshot is taken at run end, once the directories
   are past the racy window, and by then a later task or another process
   may have written into them: the walk collects the files it passes and
   records nothing unless they are the entry's rows (item 1087). Any other glob shape (`**/*.js`, `dist/*`), a missing
   row set (a remote ingest records none), a moved directory, or more
   than 8,192 directories (`OUTPUT_DIRS_CAP`) keeps the walk — and a walk that proves the tree
   current records the directories so the following hit can skip it.
2. **The files.** Every recorded file's `(size, mode, mtime-ms)` must
   match. This never left: the directory rule only replaces the
   enumeration, not the fingerprint.

The trade is the one every mtime-based skip accepts, already documented
for files: a deliberately forged directory mtime (`touch -r`) hides a
stray. Both directions are pinned in `tests/output-dirs.test.ts`.

Hard invariants of the remote prefetch:

- **Remote-only.** This entire path is gated on a `LayeredCache` being
  configured. A local-only run never prefetches; its up-front keys and
  local probes are the short-circuit's (§ Local restore tier). The
  prefetch never adds an upfront _local_ `get` / `isOutputsCurrent` /
  stat pass.
- **Stable keys only.** A task whose `cache.inputs.files` could match
  an upstream's declared output has a _preliminary_ key until that
  upstream runs (e.g. a consumer that globs `**/*` over a sibling's
  `generated.txt`). Prefetching it would target the wrong artifact, so
  it's skipped — its key resolves correctly via the lazy read-through
  in `execute-task`. Instability propagates: a task that folds an
  unstable upstream is itself unstable. When in doubt, skip.
- **At most once.** The `LayeredCache` keeps an in-flight map keyed by
  hash; `prefetch` and `get` share it, and a settled `false` (remote
  miss) prevents a second lazy probe of the same dead key.
- **Provenance preserved.** A hash pulled from remote — even when a
  later `get` finds it as a now-local hit — still reports
  `source: 'remote'`, so the outcome is `cache-hit-remote`.
- **A remote-read-off policy** (`--no-cache`, `--force`, or
  `--cache=remote:`) fires no prefetch.
- **Never fail.** Every remote path (get / put / ingest / prefetch)
  catches all errors and degrades to a cache miss. A remote 500, a
  network drop, a corrupt artifact, or a failed integrity check can
  never fail a run.
- **Said once, and said whole.** The warning names the operation
  (`probe`, `download`, `upload`), the artifact and the layer's
  `endpoint`, with a URL's credentials, query and fragment dropped:
  `upload <hash> to <endpoint> failed: HTTP 413`. One failure class
  (the error's `code` when it has one, else its message with the hash
  taken out) is said once per run, and the repeats are counted at
  close: `2 more requests failed the same way: <cause>`.

### Remote uploads (background, drained at run end)

Writes go to the local cache synchronously; the **remote PUT is a
fire-and-forget background upload**. The task's outcome (and its
dependents) never wait on upload latency — the uploads race alongside
the rest of the run and are drained before `cache.close()`, so a
short run still ships every artifact before the process exits. Upload
failures log via `onRemoteError` and are otherwise ignored (the task
already succeeded; the only loss is the remote entry).

An upload is the outputs as the task wrote them; secret masking does
not reach file contents, so a task whose outputs embed a secret is one
to leave uncached ([security](./security.md)).

### Planning probes (`--dry` / `--graph`)

The planning paths (`vx run --dry`, `--graph`) predict hits without
side effects: against a remote cache they use a **lightweight
existence probe** — no artifact download, no local ingest. A predicted
`hit-remote` means the artifact exists remotely; the bytes move only
when a real run needs them. Locally the probe reads whether the entry's
row is there and stats the artifact, never the row itself: the whole
row, its stored stdout included, made a 200-task plan over 1 MB outputs
230 ms against 28 (min of 11, 2026-10-02).

## Cache policy (read/write axes)

Caching is controlled by a four-axis `CachePolicy` — **localRead**,
**localWrite**, **remoteRead**, **remoteWrite** — independent toggles,
each enforced inside the matching cache layer at construction time. The
local `Cache` gets a `{ read, write }` slice gating only its task
artifact get/save (never `recordRun` / `stats` / `prune` / ingest /
hashing); the `LayeredCache` additionally gates its own remote
read-through (`remoteRead`), upload (`remoteWrite`), and prefetch
(`remoteRead`). The orchestrator derives two booleans per task:

- `willRead = task has a cache block AND it is not remote-only AND (localRead || remoteRead)`
- `willWrite = task has a cache block AND it is not remote-only AND (localWrite || remoteWrite)`

A task reads the cache only when `willRead`, saves only when
`willWrite`, and cleans its declared outputs before exec only when
`willWrite`. Remote-only is an `exec.remote: 'only'` task placed on a
remote executor: it never touches this machine's disk (no probe, no
restore, no output clean, no local save), and its result lives in the
remote executor's own store.

The CLI maps three flags to a policy (precedence: start all-on → apply
`--cache` → `--no-cache` forces all off → `--force` forces both reads
off): `--no-cache` = everything off (no read, no write, no output
clean); `--force` = reads off / writes on (re-execute and refresh the
cache, outputs cleaned); `--cache=<spec>` = explicit per-layer control.
See `docs/cli.md` § Cache control.

One subtlety: when `localWrite` is off but `remoteWrite` is on
(`--cache=local:,remote:rw`), there's no on-disk artifact for the
`LayeredCache` to read before uploading — so it packs the tar.zst bytes
in memory (`Cache.packArtifactBytes`) and uploads those.

## Cache write

A miss runs the task. If the final exit code is `0` and the task's
`willWrite` is true (it has a `cache` block AND at least one write axis
is on):

1. `cache.outputs.files` (and `outputs.workspaceFiles`) are resolved
   against the project dir / workspace root.
2. The per-component input fingerprint is the one captured before the
   command ran: on a miss `describeTaskInputs` fills `captureInto` once
   (the same call yields the key re-checked below), so no second
   `computeTaskHash` runs.
3. The artifact — one `stdout` entry (bounded: the first and last 8 Mi
   characters of the task's output, the dropped middle named where it was), the `outputs/<rel>` (+
   `workspace-outputs/<rel>`) entries, the `.vx-meta.json` sidecar and
   the `.vx-sum` checksum — is packed in-process (no staging dir, no subprocess) into a
   single `<hash>.tar.zst`, written to a temp name and validated.
4. One `BEGIN IMMEDIATE` SQLite transaction renames the artifact into
   place and upserts the `entries` row (taskId, command, exit code,
   duration, size, stdout, timestamps), the `output_files` fingerprint
   rows, and the `entry_inputs` component rows (`INSERT OR IGNORE`).
   Concurrent readers see either no entry or a complete entry — never a
   partial one — and bytes and rows go live together: the rename waits
   for the write lock, so no other writer's rows land beside it, and a
   commit that fails takes the artifact back out (the key then misses).
   Until 2026-09-27 (A-3) the rename came first, and a commit refused
   past the busy timeout left the new bytes beside the old rows: every
   later hit on the key failed the task as a corrupt artifact.
   A re-save (`--force`) first moves the previous artifact aside under
   a temp name and unlinks it after the commit: ext4 flushes the
   incoming file when a rename replaces one, 0.55 ms a save on the main
   thread against 0.04 (a forced 1,000-task run 4.01 s → 3.46 s,
   2026-10-02). A reader probing between the two renames misses.

**The key is re-checked before the save** (item 743). It was taken
before the command ran — at the task's start, or up front by the local
short-circuit — and the save files the outputs under it, so the inputs
must still be what it describes. Two checks, in order. The key
re-derived just before the command (`describeTaskInputs`, which the
executor seam needs anyway) must equal it. Then each input file and the
project's `package.json` is `lstat`ed once: a file whose ctime falls
after, or within `FILE_HASH_RACY_MS` before, the moment its digest was
learned — the enumeration's start for an index OID, the describe for a
hashed file — is hashed again and compared, and a file that is gone has
moved. A file written at or after the describe (just before the command)
has moved whatever it holds (a whole-second stamp counts as any moment
of its second, an even one of two, in both checks): an input changed and changed BACK while the
command ran matched its digest again, and its output, built from the
edit, was filed under the key and restored over the original (item
1015). When one moved, the task's result stands but no entry is saved,
one status line names the file (``[vx] app#format: `packages/app/a.ts`
changed after its key was taken — …``), and the run forgets what it
knew about the project, as after an uncached task (§ Cache key
derivation, step 12). This covers a formatter rewriting its own input
(turborepo#10111) and a user's edit mid-run (turborepo#1146). A task
that rewrites its own input to the SAME bytes (`sed -i` always writes)
is not saved either: its write cannot be told from an edit reverted
mid-run, so it pays a re-run each time rather than risk a stale entry;
declare what it writes as an output, which the status line says when it
names a file other than `package.json` (TanStack Router's committed
`routeTree.gen.ts`, rewritten by every build). A file ADDED under an
input glob since the listing the key filtered (`addedInput`) withholds
the save the same way, named on the same line: the listing's
directories a glob reaches are `lstat`ed, one whose ctime moved since
the listing is read, and a new name the declaration matches (or an
unlisted directory) is asked of git, which alone knows what is ignored;
a literal input absent then and present now is asked too. Not seen: a
file added inside a directory that held no listed file before (only
ignored ones, or none) and was not itself created mid-run. Cost: one
`lstat` per input and per reached directory on a miss that saves, a
`readdir` per directory that changed, and a `git ls-files` only when a
candidate turned up; a hit runs no command and checks nothing.
A file listed but gone before the key hashes it (an upstream that
deletes a file its dependant's globs match) is keyed as absent, not
read: the dependant failed as `internal error … ENOENT` on every run
until A-55. Absent stays unmoved while it stays gone.
Its dependants whose keys fold its key save nothing either,
transitively: that key does not name the bytes they built from (`[vx] app#use: ran
over app#gen's outputs, which its key no longer describes — …`). Until
2026-09-27 (A-12) they saved, and once the input was put back they hit
the edit's output.
A workspace fingerprint a task rewrote since the run read it (§ Cache
key derivation, step 3) withholds the save the same way.

A miss that ran here and saves **nothing** — it failed, the cache
policy writes nothing (`--cache=local:r,remote:r`), an upstream failed
under `--continue` — runs the same input re-check and, when an input
moved, forgets the project as above; otherwise its declared outputs are
resolved and marked in the git snapshot exactly as a save marks them.
Before item 750 only a save marked them, so a same-run reader keyed
from the snapshot's index OID for an output (or for an input the task
rewrote) restored the bytes from before the command.

A declared set that resolves to **nothing** is said on the run's
status line. `cache.inputs matched no files (lib/**)` — the key would
not change when the source does — is said on every miss of a cacheable
task, right after `describeTaskInputs` and before the command, whether
or not it saves. `cache.outputs matched no files (build/**)` — an empty
artifact was saved and a later hit restores nothing — is said on the
save path. Both are almost always a glob
against the wrong directory; the output line names one other cause when
it applies: a sandboxed task with no `exec.sandbox.allow.write`, whose
writes never reached disk, or an output directory that is a symlink out
of the project (`workspaceFiles`: out of the workspace), whose files vx
drops as outside. `outputs.files: []` is a deliberate cached
no-op and says nothing; a task with no `cache` block is never checked.

**The outputs are what exists when the task's command exits.** The run
waits for the command's own process, not for everything it started — a
backgrounded grandchild that still holds the output pipe does not hold
the run (`tests/runner.test.ts`) — and the save resolves the output
globs at once. A descendant the command detached (`setsid … &`, a
daemon) that writes after that is not in the artifact: the entry saves
what was there, often nothing (with the `cache.outputs matched no
files` line), and the next hit's clean-before-restore removes what the
descendant wrote and restores the saved entry in its place (upstream
survey, turborepo#12786). vx does not wait for it and cannot see it: a
process that left the task's session is outside the process group vx
tracks and signals ([kill-tree](./modules/kill-tree.md)). So a command
finishes writing its outputs before it exits — `wait` for what it
backgrounds, or do not detach it.

If the task exits non-zero, **nothing is cached.** This is deliberate:

- Caching a failure prevents retry flows. The next run gets the same
  failure even after the user fixes the underlying cause (the inputs
  haven't changed, so the cache key matches).
- Failures should be transient by default — flaky tests, network
  blips, transient resource exhaustion shouldn't bake into the cache.

Failed-task stdout / stderr still reach the user via the live stream
and the framed failure block replayed at run end. The `runs` table
records the failure (status + exit code) for analytics.

## Strict output ownership

Declared `cache.outputs.files` are wiped in two distinct places:

- **Before exec on a cache miss.** A leftover `dist/old.js` from a
  prior build can't survive into a fresh build that doesn't rewrite
  it.
- **Before restore on a cache hit.** The post-restore tree is the
  cached snapshot byte-for-byte. Hand-edits to output files don't
  persist through a cache replay.

Both branches use the same `cleanOutputs` helper (`src/cache/inputs.ts`)
with the same boundary rules, and two directories stay off the wipe
whatever the glob: `.git` and `.vx` (`OUTPUT_NEVER`). `node_modules` is
off it too unless a glob names it (`node_modules/**`, an install task's
legitimate output); until 2026-09-27 (A-13) `**/*.js` cleaned every
installed `.js`, and a `workspaceFiles` output glob reached even `.git`.
A task that fails while a git-tracked file another task's clean removed
is still missing gets one line naming the file and that task: vx cleans
before a run where Turbo does not, so a reader with no edge to the
producer of a committed output fails naming only the file (A-48,
vueuse's `metadata/index.json`).
Workspace outputs take the same rules, and a path an output `!` entry
takes back (A-44) is off the wipe, the artifact and the restore alike.
Skipped when:

- `cache.outputs.files` is empty (nothing declared as output).
- The task's `willWrite` is false — no write axis is enabled (e.g.
  `--no-cache`, or a read-only `--cache=local:r`). The user is debugging
  and managing the tree, so vx leaves it alone. `--force` keeps writes
  on, so it DOES clean (the saved snapshot must be clean).

A declared output the process cannot remove (a `dist/` another user
wrote, a read-only checkout) fails the task with `cannot remove declared
output <path>: EACCES — …`, and a restore that cannot write into such a
directory with `restore of <hash> into <dir> could not write its outputs
(EACCES: …)`: the environment's failure, reported plainly, never as an
internal error or a corrupt artifact.

Why so strict? Turbo and Nx restore additively — files from a prior
state can survive. We've seen this cause:

- Wrong test runs (a deleted-but-resurrected snapshot file from a
  cache miss survives a hit and now your test passes against the
  wrong baseline).
- Wrong shipped artifacts (a deleted source-mapped file from a prior
  build sits in `dist/` alongside the new bundle).

The strict-ownership behavior makes the project dir post-run a pure
function of the cache key.

### Additive outputs: two tasks, one tree, an edge between them

Two cached tasks whose declared outputs overlap are refused at graph
build. By default that holds even when one depends on the other: the
workspace rule `rules.exclusiveOutputs` (on unless set to `false` in
`vx.workspace.ts`, X-53) keeps one path to one task, and its refusal says
how to turn it off. The shape below is correct, only slower: a stamp
before every run, a diff after, and a clean by rows. Give each task its
own output path where you can (`dist-individual` beside `dist`).

With the rule off, an edge fixes the order, and the dependant is
**additive** (item 588): twenty's
`build` fills `dist` and `build:individual` depends on it and writes
`dist/individual`; strapi's `build:types` runs `tsc` into the same
`dist` as `build`. For the dependant:

- its **own output set** is what its run added or changed under its
  declared outputs — the outputs are stamped (size, mtime, inode, ctime) before the
  run and diffed after, the same proof a hit's "already current" check
  trusts — and only that set is saved; `outputs.workspaceFiles` are
  stamped the same way (until A-43 its miss cleaned them by glob, deleting
  a same-tree upstream's root-anchored files before it read them);
- a run that **removes** a file it found (a bundler deleting the
  upstream's intermediate) saves nothing: an artifact holds what a run
  wrote, never what it took away, and the upstream's restore puts the
  file back, so the dependant runs again on every warm run (X-32);
- it **cleans by recorded rows**, never by glob, before a run (nothing:
  stale files of its own are its command's to clean, as under Turbo) and
  before a restore (its rows only);
- its "already current" check requires its rows present and current and
  ignores everything else under the glob;
- it is **never restore-tier**: it restores or runs after its upstream,
  by the edge.

The upstream keeps strict ownership of its glob — a miss or a restore
wipes the whole tree, the dependant's additions included, and the
dependant restores or runs after — and its "already current" check
ignores strays a dependant's glob could have added, so a warm run stays
a no-op for both. A file the dependant rewrites in place (refine's
`types` regenerating `build`'s `.d.ts`) counts as the dependant's own
(its ctime moved, even where a tool stamps the size and mtime back; X-33),
which is correct and costs the upstream a restore on
the next warm run; the design note keeps that shape out of scope.

## Invalidation paths

A task's cache becomes invalid when any of these change:

| Trigger                                                                                                                                  | Mechanism                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit a file in the task's `inputs.files` set                                                                                             | step 12 of key derivation                                                                                                                                                                       |
| Edit a file in the task's `inputs.workspaceFiles` set (root-anchored; may live in ANY project's dir — the documented boundary exception) | step 12 — resolved workspace files join the same input-file list                                                                                                                                |
| Any package manager updates a lockfile (`pnpm`, `npm`, `yarn`, `bun`)                                                                    | step 3 (workspace fingerprint) — or, for a lockfile a plugin claims, that plugin's `key` material (`@vzn/vx-lockfile`: only the projects whose dependency closure moved)                        |
| Edit `pnpm-workspace.yaml`                                                                                                               | step 3                                                                                                                                                                                          |
| Edit `package.json`'s `workspaces` field                                                                                                 | not step 3 — membership: a project that joins or leaves changes which projects exist and which nested dirs its parent's globs exclude (step 12); the file itself is hashed per project (step 4) |
| Edit the project's `package.json` (dep / version / scripts change)                                                                       | step 4 (project package.json hash)                                                                                                                                                              |
| Edit the task's `vx.config.ts`                                                                                                           | step 5 (task config hash)                                                                                                                                                                       |
| Edit a config file that the task config imports                                                                                          | step 5 (configHash sees the resolved object after Bun evaluates imports)                                                                                                                        |
| Change CLI `forwardArgs` (after `--`)                                                                                                    | step 6                                                                                                                                                                                          |
| Change a `cache.inputs.env` host value                                                                                                   | step 7                                                                                                                                                                                          |
| Change the combined stdout+stderr of a `cache.inputs.runtime` command (resolved at hash time)                                            | step 8                                                                                                                                                                                          |
| Change the combined stdout+stderr of a `cache.inputs.workspaceRuntime` command (resolved at hash time)                                   | step 9                                                                                                                                                                                          |
| Upstream task's cache key changes (because its inputs changed)                                                                           | step 10                                                                                                                                                                                         |
| Bump `CACHE_VERSION`                                                                                                                     | step 1 — orphans every entry                                                                                                                                                                    |
| Change `exec.env.passThrough` _values_ alone                                                                                             | **NOT a trigger** by design — passThrough values are host-specific                                                                                                                              |
| Change a file not in `inputs.files` / `inputs.workspaceFiles`                                                                            | **NOT a trigger** by design — declare it explicitly                                                                                                                                             |
| Edit `vx-lock.json`                                                                                                                      | **NOT a trigger** — globally excluded from inputs (v24); it's vx's own metadata, never a task input                                                                                             |
| Change a file in a nested project's dir                                                                                                  | **NOT a trigger** for the parent's `files` globs — project boundaries are hard (workspaceFiles is the explicit exception)                                                                       |

The cascade in step 10 is what makes monorepo caching work: edit a
file in `lib/`, and every package that depends on `lib`'s `build` task
re-runs automatically.

## Cross-project boundaries

A project's `cache.inputs.files` globs **never** reach into another
project's directory, even if a `**/*` pattern would otherwise match.

`workspace/nested-dirs.ts` computes the set of nested project
directories (projects rooted inside this one) once per `vx run`. A
workspace package counts whether or not it has a vx config: it is the
project `--affected` gives its files to, and its default `build` keys
them (X-57). The same set fences the output clean, so a root
`outputs.files: ['**/*.js']` never removes a member's source. Every
glob pass drops a path under one of them (an ancestor lookup,
A-11). The only way
for project A to depend on project B's state via project-relative
globs is `dependsOn` + upstream-hash propagation (step 10).

For a task with `exec.sandbox` and `cache`, the sandbox enforces that
"only". A workspace package reached through a `node_modules` link is
granted only when the task's key folds a task of that package, walking
the same selection `cache.inputs.tasks` applies at hash time
(`orchestrator/keyed-projects.ts`, over `upstream.ts`'s
`selectFoldedDeps`); every other link target inside the root is
withheld, so an import of a sibling the key never sees fails and is
reported instead of caching a result an edit there would not re-run.
Any exec task counts, cached or not: a task with no `cache` declares no
`inputs.files`, so its key folds every file of its project. A persistent
task counts the same way: its key folds its whole project, so a cached
e2e behind a dev server re-runs when the server's sources change.
The coverage is per package, not per file: an edge to `ui#source`
(inputs `src/**`) also admits a read of `ui/README.md`, whose edit moves
no key — the same limit a grant wider than a task's own inputs already
has. A task with no `cache` keeps every link, having no key to be stale.

**Exception:** `cache.inputs.workspaceFiles` /
`cache.outputs.workspaceFiles` are workspace-root-anchored and apply
NO boundary rule — a deliberate escape hatch (owner call: "they don't
care about boundaries; it is bad practice but is there"). Prefer
project-relative declarations; reach for workspaceFiles only for
genuinely root-anchored files.

## Clean filters (`text` / `eol` / `ident`, `core.autocrlf`)

Git can store a file's blob in a different form than the bytes in your
working tree. Under a `text`, `eol` or `ident` attribute — or with
`core.autocrlf` set to `true`/`input` — the index holds the
LF-normalized (or ident-collapsed) blob while your editor and your
build see the CRLF (or expanded) file.

That matters because `git status` compares **after** applying the
filter, so such a file reports _clean_: git considers it unmodified
even though the blob and the worktree file are different byte
sequences. Trusting the index OID as the file's content hash would
then let two genuinely different worktree contents fold the **same**
cache key, and a real change would be invisible.

So vx does not trust an index OID where a filter can apply. The check
is gated in three steps, and the common case pays nothing:

1. `core.autocrlf` is `true`/`input` — conversion applies to every
   auto-detected text file with no attribute needed, so no OID is
   trusted.
2. Otherwise, if no attributes source exists anywhere (no in-tree
   `.gitattributes`, an ignored one included, which `git status
--ignored=matching` names from the walk it already does, no `$GIT_DIR/info/attributes`, and none of the
   files git reads outside the tree: the global one, which is
   `core.attributesFile` or by default `$XDG_CONFIG_HOME/git/attributes`
   or `~/.config/git/attributes`, and the system one), no rule can name
   a filter and vx does **no** extra work. This is the default
   `git init` repo. The gate reads `git var -l`, one spawn, which from
   git 2.42 names the global and system files itself
   (`GIT_ATTR_GLOBAL`, `GIT_ATTR_SYSTEM`); for an older git the global
   lookup is mirrored and the system file is looked for at
   `/etc/gitattributes` and `<prefix>/etc/gitattributes` beside the
   binary, where a standard build puts it. Before 2026-09-24 the gate
   missed the default global file, so `* text` there left a CRLF file
   keyed on its LF blob: a CRLF→LF edit was a stale hit.
3. Otherwise `git check-attr` resolves `text`, `eol`, `ident`, `filter`
   and `working-tree-encoding` from the index — without reading worktree
   content — and only the paths actually carrying one lose their OID. A
   `filter` driver was missing from the list until item 978: a clean
   driver that drops comment lines (`sed '/^#/d'`, nbstripout's shape)
   stores one blob for two worktree files, so an edit git calls clean
   replayed the old output. Git LFS files are a `filter` too, and are
   hashed from disk.

`-text` (explicitly unset) and unspecified paths keep their OIDs:
both leave the blob byte-identical to the worktree file.

Losing an OID is not over-invalidation. It routes that path to the
content hasher, which hashes the worktree bytes — the correct source
either way. The only cost is reading the file, which is exactly what
the gate exists to avoid paying needlessly.

## Runtime inputs and the lock (the env parallel)

`cache.inputs.runtime` / `cache.inputs.workspaceRuntime` are modeled
exactly on `cache.inputs.env`, and they share its asymmetry with the
lockfile:

- **The command _strings_ live in the resolved config**, so `vx lock`
  freezes them into `vx-lock.json` (just as it freezes the env _names_
  a task declares).
- **The command _output_ is resolved live at hash time on every run**
  — inside `resolveInputs`, the same place env _values_ are read from
  the host `process.env`. The lock never stores it.

A runtime command executes **once per run, per project** (memoized by
`projectDir + command`), at key-derivation time — which, with the
up-front classify/prefetch pass, is before any task runs. It is a
run-level reading of the ENVIRONMENT (toolchain versions, resolved
config), not a per-task probe: it is not asked again before a save, as
input files are, because that would be one spawn per command per miss
where a file costs one `lstat`. A command that reads another task's
OUTPUT reads whatever is on disk when it is asked. When the reader's key
folds that task's key, the upstream key covers it: an answer taken before
the upstream ran costs a spurious miss on the run after the output
changes, never a stale hit, and the answer stays shared. When it does
not (`tasks: []`, a filter that leaves it out, transitively), nothing
covered it until X-34: the save filed bytes built from the new state
under the old answer, and a later run that started from the old state
hit them. Now such a task (`probesAfterWrites`, stable-keys.ts) takes no
key up front and is never restore-tier, and its probes run for it alone,
after its upstream finished — one spawn per such task per run, not one
per project (`tests/in-run-writes.test.ts`). Declaring the producing
task's output as an input (`dependsOn` + files) is still the cheaper
spelling: files are re-checked, answers are not.

A probe runs in its own process group. One still running when vx exits
— a Ctrl-C, or a refusal, while a hung `git` or `node -e …` answers — is
SIGKILLed with its whole tree; until 2026-09-27 (A-9) it ran on under
init. A `kill -9` of vx runs no exit hook, and leaves it.

So `vx run --frozen` loads the frozen command strings but still spawns
them and folds their current output into the key. A `node -v` that goes
from `v20` to `v22` after the lock was written busts the cache under
`--frozen`, exactly as a changed `NODE_ENV` value would — the TypeScript
escape hatch (`define: { TSC_VERSION: execSync(...) }`) goes stale here
because its value was baked into the config object at lock time, whereas
a runtime input re-resolves.

Consequently **`vx lock --check` does not — and need not — flag
runtime-output drift.** `lock --check` audits that the frozen config
object still matches a fresh evaluation; the command output was never
part of that object (only the strings are), so a changed probe output
is correct, expected, live behavior rather than lock drift. This is the
same reason `lock --check` ignores `inputs.env` value changes.

## Concurrent runs

Two vx processes on one workspace (a `vx watch` beside a `vx run`, two
CI jobs on one checkout) take turns: a run takes the workspace's run
lock before it schedules and releases it with its cache handle — before
a persistent task's wait, so a dev server never holds it — and the
second run waits, saying after a second whom it waits for:

```
[vx] waiting for another vx run (pid 4821) on this workspace to finish…
```

The cache itself was always safe (SQLite waits on its lock, artifacts
land by rename); a task's OUTPUT TREE was not — both runs cleaned and
restored the same `dist/`, and a clean landing while the other run's
restore was staging took its files out from under it. The lock is an
atomic directory under the temp directory, keyed by the workspace root
(`--cache-dir` does not make two runs strangers) and holding the
holder's pid, so a lock a killed run left behind is reclaimed once its
pid is gone. The temp directory is the one each process sees, `TMPDIR`
included: two shells that set different ones (a `nix develop` shell
sets its own, as can direnv or `sudo`) hold two locks and do not take
turns (item 970). Run them under one `TMPDIR`. A lock under the
workspace would survive a reboot that `/tmp` does not, and where a
holder's start time is not readable (off Linux) a pid reused since
would read as a live holder forever. Where the directory cannot be made at all (another user's
lock, a temp directory this user cannot write) the run says so once and
proceeds unlocked — a courtesy between cooperating runs, never a
refusal — and a restore that then loses its staged files to the other
run's clean fails with `restore of <hash> into <dir> was interrupted: a
file it had just written vanished (ENOENT: …). Another vx run is using
this workspace — re-run once it is done.`; the artifact is intact
either way (a restore renames into place only once the whole archive
has staged). Machines sharing a workspace over a network file system
do not share a temp directory, so they do not share the lock.

An eviction can still land between a hit's probe and its restore: a
`vx cache prune` in another shell, or the `cacheRetention` of another
workspace that shares the `--cache-dir` (a different workspace, so a
different lock), which cannot see this run's pending `accessed_at`
bumps and reads its fresh hits as old. The restore then finds no
artifact, and that entry is a **miss**: the run says `[vx] <id>: its
cache artifact <hash> vanished before the restore … — running it`,
runs the task, and saves it again. It failed every such task as an
internal error until 2026-09-24 (upstream survey: nx#36688, nx#34032).
A hit the local short-circuit was restoring ahead of its dependencies
goes back to the schedule and runs once they are done, never in the
restore's slot: built before them, its bytes would be saved under the
healthy key (`tests/vanished-artifact.test.ts`).

A local artifact whose bytes are wrong (a failed checksum, a torn
write, one past the artifact ceiling, an entry missing a recorded
output) is a miss the same way: `[vx] <id>: cache: corrupt artifact
for <hash>: …; dropped it — running it`. The entry is dropped, so the
task's save stores the key again; it failed the task as an internal
error on every run until `--force` before A-52. A cache the run may
only read keeps the entry (`…; left it (this cache is read-only)`).

## Storage layout

The run must be able to write here — it records its history at the
end of every run, hit or miss — so a directory this user cannot write
into (another user's `.vx`, a read-only checkout) fails the run before
any task: `cache directory <path> is not writable (EACCES: …)`, with
`--cache-dir <path>` as the way out. `vx cache prune` is refused the
same way (its `--dry-run` only reads, and reads). The readers (`vx show`, `why`,
`last`, `info`) open such a directory read-only and go on: a config
that misses the evaluation cache is evaluated live and not stored.
Where the directory cannot be created at all (a read-only checkout with
no cache yet) a run says `cannot create cache directory <path>
(EACCES: …)`, naming the workspace `cacheDir` field and `--cache-dir`;
the readers and `vx cache prune` find no cache and go on.
A full disk is the same kind of failure and is reported the same way,
never as a corrupt artifact and never as a stack: a save that runs out
of room is `[vx] cache save failed: ENOSPC …` (the task's work ran, the
next run misses), a restore that does is the task's failure line
`could not write its outputs (ENOSPC: …). Free space on that disk and
re-run.`, and a run record that does is `[vx] run history not recorded:
… — the verdict above stands` (the run exits by its tasks; `vx last`
will not know that one). A full index (`SQLITE_FULL`) gives way where the
write is only a memo: the file-hash memo, the output stamps and the
access times are skipped and the run goes on; a prune unlinks the
artifacts first, so the rows it then deletes have room to go, and a
save's temp file is removed when its write fails.
A process out of file descriptors (`EMFILE`, `ENFILE`) is named the
same way: a save is `[vx] cache save failed: save of <hash> could not
open a file (EMFILE: …) — … raise the limit (ulimit -n 4096) and
re-run`, and a restore fails the task with that hint, never as a
corrupt artifact (A-39). Opening the index is named the same way: SQLite reports a
descriptor it could not get as `unable to open database file`, and vx
says `the cache index <path> could not be opened (…) — …raise the limit`
(A-56).
A restore that cannot READ its artifact (a cache directory another
user owns) names the cache, not the outputs: `restore of <hash> could
not read its artifact (EACCES: …). Make the cache directory readable
by this user, or point cacheDir / --cache-dir at one that is.` (A-40).
An input the key must hash that this user cannot read fails its task
naming the read: `<path> is not readable by this user (EACCES), and vx
reads it to derive a cache key. Make it readable, or, for a task input,
take it out of cache.inputs.files.` (A-50).

By default the entries and their artifacts live in a **shared store**
in `~/.vx/<id>/cache`, and each workspace keeps only its own index in
its `.vx/cache`: every checkout of the repository hits what another
saved (a second clone, a worktree), and none reads another's history.
The id is Nx 23's: 16 hex of a sha256 of the remote (`origin`, then
`upstream`, `base`, the first; `host/owner/repo` in lower case, so ssh
and https agree) and the workspace's path in the repository; with no
remote, the first commit. A repository with neither (no commit yet, a
shallow clone with no remote) shares nothing. Each level of `~/.vx` is
owner-only; vx closes one of yours that is open to other users (chmod 700), and one owned by another user is not used. Design: [`design/shared-store-2026-10.md`](./design/shared-store-2026-10.md).

```
~/.vx/<id>/cache/                           the shared store
├── store.db                                entries, entry_stdout, output_files,
│                                           entry_inputs, store_meta
└── <hash>.tar.zst                          the artifacts (below)

<workspaceRoot>/.vx/cache/                  this workspace's own index
└── cache.db                                run history, memos, output stamps;
                                            attaches store.db as `store`
```

The store's directory carries no version: every key is seeded with
`CACHE_VERSION`, which moves when hashing or the artifact layout does, so
two vx versions never read each other's artifacts. `store.db` is the
artifacts' inventory and records its schema (`store_meta.schema`): a vx
of another `SCHEMA_VERSION` drops its tables, says `shared cache store
… re-indexed` once, and keeps every artifact, each indexed again when
its task next hits. The check, drop, re-create and stamp are one write
transaction, so another version's open waits rather than landing between
them. A home this user cannot write keeps the store
in `<workspaceRoot>/.vx/cache/` instead, said once. Name a
cache directory (`cacheDir` in vx.workspace.ts, `--cache-dir`, or
`VX_CACHE_DIR`, in that order of precedence, relative to the workspace
root) and it holds everything, shared with no other workspace:

```
<cacheDir>/                                 (default .vx/cache when one is named)
├── .gitignore                              `*` — written when the dir is created, or into an
│                                           existing dir that lacks one, so the cache is
│                                           never committed and never enumerated as an
│                                           input (a user's own file is left alone)
├── cache.db                                SQLite metadata + run history
├── cache.db-wal                            write-ahead log
├── cache.db-shm                            shared memory
└── <hash>.tar.zst                          one artifact per cache entry:
    ├── stdout                              captured stdout (always present, may be empty)
    ├── outputs/<rel>                       declared output files, project-relative (when any)
    ├── workspace-outputs/<rel>             declared outputs.workspaceFiles,
    │                                       WORKSPACE-ROOT-relative (when any)
    ├── .vx-meta.json                       per-output [mode, mtimeMs] sidecar
    └── .vx-sum                             CRC-32 of every entry above (v36)
```

`<hash>` is the 16-hex xxh3 key. The `workspace-outputs/` namespace is
additive: tasks that don't declare `outputs.workspaceFiles` produce
byte-identical artifacts to the plain v17 format (which is why the
field needed no `CACHE_VERSION` bump). `output_files` rows mirror the
two namespaces — project rows store the bare rel, workspace rows store
the full `workspace-outputs/<rel>` name as the discriminator.

The container is written and read by vx's own streaming tar code
(`src/cache/tar-stream.ts`): ustar with the name/prefix split and a pax
`path` record past it, header checksums, and nothing else — there is no
`tar` subprocess, no libarchive, and no staging copy. **Save streams
it**: each output is stat'd once, then read from disk as it is written
and compressed straight into the temp file (measured 2026-09-03 on a
150 MiB output: peak +705 MiB → +241–269 MiB; the streamed compressor
is ~2.4× the one-call cost per byte, so a small artifact is packed in
memory and compressed in one call — tiny saves unchanged within
noise). Ingest lists entries through the reader without materialising
a byte, and **restore streams it**: the zstd
frame is decoded and the tar read as it arrives — ustar name/prefix
(the prefix under POSIX `ustar\0` magic only: old GNU's `ustar  ` keeps
atime there, A-29),
pax `path`/`size`, GNU long names, header checksums, truncation; an
extended header (read whole) past 1 MiB or a pax `size` that is not a
whole number is refused as corrupt, since a 1 GiB pax header costs 2 GiB
of memory from a ~32 KB artifact — and
every regular entry is written beside its target as a short `.vx-tmp-*` sibling (never a suffix on the target's name, which pushed a legal 242–255-byte name past NAME_MAX) and
renamed into place only after the whole archive has ended cleanly and
the index's recorded outputs are all present. vx itself holds one
chunk of the tar at a time (measured 2026-09-03, incompressible
artifacts, fresh process: 150 MiB peaked at +644 MiB through
`Bun.Archive` and +49 MiB streamed at the same wall time; a single
400 MiB entry restores at +30 MiB, the same as a 150 MiB one), while
the per-entry buffers of many mid-sized entries are garbage the
collector reclaims at its own pace (200 × 2 MiB measured +90–180 MiB,
never the artifact's size). An artifact up to 4 MiB compressed is decoded in one call
first — the stream setup costs ~35 µs each, 4% of the headline
restore row when every artifact is a one-file `dist/` — and then fed
to the same reader and extractor, so there is one extraction path.
The reader reads a header in place when it lies within one chunk and
its numeric fields off the bytes when they are plain octal (anything
else takes the full parse): a 4-entry artifact's read 50–57 µs → 22–23
(min of 15), and a 300-artifact, 20-file restore run's reader 224 → 92
ms of main thread (2026-10-02).
The 2 GiB decompression ceiling applies to both: declared size and
output length for the one-call decode, a running count for the stream.
An ingest bounds the compressed body first: a remote body past the
ceiling's zstd bound (a length header, a Blob's size, or a running count
on a chunked stream) is refused before it can fill the disk.
A frame that declares no content size (what a streaming compressor
writes — vx's own saves above 4 MiB) is always decoded as a stream, so
a sizeless bomb has nowhere to expand and vx's artifacts ingest
anywhere. So is a body that is not exactly one frame: the declaration is
the first frame's alone, while the one-call decoder decodes every frame,
so until 2026-09-27 (A-5) a 100-byte frame with a large one appended
expanded whole in memory (2 GiB from a 32 KB body) before its length was
checked. The frame's blocks are walked by their own sizes to tell. A save meets the same ceiling first: the pack plans the tar
from one stat per output, and a tar past 2 GiB is refused before a byte
is compressed — the run stays green, one status line names the task
(`[vx] cache save failed: <task> is not cached: its outputs pack to …,
past the 2.0 GB artifact ceiling a restore enforces`), and nothing is
stored for a later run to hit and fail to restore. Left to the scan, a
2.2 GB output paid the whole compress and a decode (6 to 14 s) to learn
the same thing and called the task's outputs a corrupt artifact.

The last entry, `.vx-sum`, is a CRC-32 over every entry before it (each
its name, a NUL, then its body) as 8 hex digits. Tar sums its headers
only and neither zstd writer asks for a frame checksum, so a byte flipped
in a raw zstd block (incompressible output: an image, a wasm, a tarball)
decoded clean and a hit replayed the wrong bytes: 1,141 of 1,141 flips in
a random 8 KB body went unseen (L-19). Scan and restore hash every entry
as they read it and refuse an artifact whose sum is absent, wrong, or
followed by another entry, before anything it holds lands; the refusal
is a corrupt artifact, so a restore degrades to a miss and an ingest
stores nothing. It catches damage in transit or at rest, not a store that
forges artifacts: nothing a key carries can tell those from honest ones.
Its cost is the CRC's (~10 GB/s): a 32 MB restore 11.3 → 14.4 ms and
1,000 small files 16.2 → 18.9 ms on tmpfs, min of 15.

Tar headers carry mode and second mtimes. vx needs both permission bits (a lost executable bit builds cold
and breaks warm) and millisecond mtimes (the skip-restore probe compares
them) exactly, so the pack stats each output once and writes
`.vx-meta.json` — `{ version, key, files: { <entry>: [mode, mtimeMs] }, exec? }` —
into the archive. Restore applies both, at their edges too: a mode of
000, an mtime of 0 (`SOURCE_DATE_EPOCH=0`) and one before 1970, whose
tar header carries 0 since ustar's field holds no sign. Until 2026-09-27
(A-4) the first two were skipped, so the file came back 0644 and
stamped now and every later hit restored it again, and the third wrote
a header the reader refused, so its task never saved. `exec` (`{ cpuMs?, peakRssBytes? }`,
2026-09-12) is what the PRODUCING execution used: it rides the artifact
so a machine that never ran the task — a fresh runner on a remote hit —
still learns what the task needs (`@vzn/vx-schedule-history` packs on
it), every wire ships the bytes verbatim, and an artifact without it
reads as before. The ingest side takes the numbers only as plain
non-negative numbers; anything else in a foreign sidecar is dropped. Entries that are not regular
files (symlinks, hardlinks, devices) are never materialised — the
reader reports them only to be skipped — so a
poisoned artifact cannot smuggle one onto disk. Nor can it name a file
the task did not declare: a remote artifact is ingested only when every
file it carries matches the task's `cache.outputs` (the lookup passes
them, `CacheGetContext.outputs`), and never when it holds one path as a
file and a directory at once. Either used to reach the tree, an input
overwritten or a `.git/hooks` file planted under a green
`cache-hit-remote`, or a restore that failed every later run from the
local copy (item 942); now the read is a miss and the task runs. On the save side a
**symlinked output** is captured as its target's bytes and comes back
as a regular file (a hit that finds the task's own link still current
leaves it); a link to a directory, or a dangling one, has no bytes to
store, so the save refuses it by name rather than cache an entry that
restores to nothing. So does a link whose target is outside the
project: vx reads outputs outside the task's sandbox, and a planted
link packed a file the task could not read (L-23). Each refusal names
the path as the config spells it (`workspaceFiles output gen/latest`). The clean before exec and restore removes every
file AND symlink the output globs cover (a link is unlinked, never
followed, and nothing is removed through a symlinked directory: a
`public -> static` link in the project took the tracked `static/*`
with it, X-5) and prunes the directories it emptied (before a miss it keeps
the directory a wildcard glob is rooted at, `dist` for `dist/**`, as the
task writes there), so a task whose
output changed shape — `dist/out` a directory one run and a file the
next — restores either entry over the other's tree; a stray the globs
do not cover, or an empty directory where the entry holds a file, that
stands in an entry's way fails the restore naming it, not as a corrupt
artifact (item 1094). A directory on the way that is a
symbolic link OUT of the project (a `dist` made a link after the entry
was saved) is never written through and never replaced — the link is
the user's, and replacing it is the bug nx#37061 reports — so the
restore refuses, naming it: `<dir>/dist is a symbolic link to
<target>, outside <dir> — a cache restore never writes through a link
that leaves its directory. Remove the link and re-run (the restore
puts a real directory there), or stop declaring outputs under it.` A
link that stays inside the project is written through, and so is one
whose target is gone: the restore creates the directory it names —
following a chain of links to its end — and writes through it, the
link kept. Whether a link stays inside is decided on where it resolves,
so a dangling link to `../elsewhere` or to an absolute path out of the
project is the same refusal, nothing created outside, and a cycle of
links is refused by name. (A link the output globs themselves cover,
`dist/sub` under `dist/**`, is an output: the clean unlinks it.) Entry NAMES are
validated by vx before anything decides where to write, and a bad
entry anywhere, even the last, rejects the WHOLE archive: the temps
are unlinked and the empty directories the extraction created are
pruned (`tests/archive-security.test.ts`). A backslash in a name is a
name character (vx runs on Linux and macOS; Windows through WSL), so an
output like `dist/back\slash` caches and restores as written.

**Key properties:** one entry is one file — eviction is a single
unlink; no per-entry manifest, no separate `logs/` tree; and local +
remote layers transport the exact same tar.zst bytes end-to-end.
The artifact is the record and the index its inventory (owner,
2026-10-06): a lookup reads the row first, and a key with no row whose
`<hash>.tar.zst` is on disk (a `SCHEMA_VERSION` drop, a deleted
`cache.db` or `store.db`) has the artifact indexed again from its own
bytes, checked as a remote's are (its recorded key, its names against
the task's declared outputs), and hits; one that fails the check is a
miss, and the save that follows replaces it. A `.tmp-*` a crashed save
left is never a hit. `vx cache prune` sweeps row-less files, and so does a run whose workspace declares `cacheRetention`, at
most once an hour (the sweep's clock is `schema_meta.orphans_swept_at`;
the policy sums index rows, so orphans alone never make it due), once
they are older than an hour (a save renames the artifact into place
before its row commits, so a fresh row-less file is a save in flight).
Captured stdout is stored twice on purpose: in the artifact (so it
survives the remote round-trip) and in the `entries` row (so a local
hit replays it with pure SQL, never decompressing the artifact).

### SQLite tables

`schema_meta.version` is the gate: an index written by any other
`SCHEMA_VERSION`, earlier or newer, is reset by the first run that opens
it (pre-alpha: no migrations; the index is an inventory, owner
2026-10-06): every table but `schema_meta` is dropped and recreated,
so each comes back in its current shape (A-54: `config_closures` and
`output_dirs` kept an earlier vx's columns).
A reading verb (`vx why`, `vx last`, `vx info`) leaves it untouched and
says why (item 896; `vx cache prune --dry-run` previews the reset
instead, item 1083).
That open prints nothing (owner, 2026-10-06: the cache is vx's to
keep). The artifacts stay: each is indexed again from its own bytes
when its task next asks for its key (below).

```sql
-- src/cache/schema.ts (SCHEMA_VERSION = 'v32', in cache.ts)
-- With a shared store, entries, entry_stdout, output_files, entry_inputs
-- and store_meta live in its store.db, attached as `store`; the rest is
-- the workspace's cache.db. A named cache dir holds all of them.

CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,  -- 'version', 'cache_version', 'orphans_swept_at', 'file_hashes_swept_at', 'store_dir'
  value TEXT NOT NULL
);

-- The config-evaluation cache (§ Config evaluation cache): the validated,
-- JSON-serialised result of a provably pure config, keyed by everything
-- the evaluation could have observed. Machine-local.
CREATE TABLE config_evals (
  key        TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE entries (
  hash         TEXT PRIMARY KEY,  -- the 16-hex xxh3 cache key
  project      TEXT NOT NULL,
  task         TEXT NOT NULL,
  command      TEXT NOT NULL,
  exit_code    INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL,
  size_bytes   INTEGER NOT NULL,  -- artifact size
  created_at   INTEGER NOT NULL,  -- ms-epoch
  accessed_at  INTEGER NOT NULL,  -- ms-epoch; bumps batch at flush (LRU)
  cpu_ms         INTEGER,         -- v26: the producing execution's usage, from
  peak_rss_bytes INTEGER          --      the artifact's sidecar (save + ingest)
);

-- v29: stdout apart from its entry. An UPDATE rewrites a whole record, so
-- the accessed_at bump rewrote each hit's stdout (up to 16 MB): 200 hits
-- of 1 MB cost the run's close 125-150 ms.
CREATE TABLE entry_stdout (
  hash   TEXT PRIMARY KEY,         -- FK entries(hash) ON DELETE CASCADE
  stdout TEXT NOT NULL             -- captured stdout (pure-SQL hit replay); no row = ''
);

CREATE TABLE runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  hash                TEXT NOT NULL,   -- '' when the outcome derived no key (see below)
  project             TEXT NOT NULL,
  task                TEXT NOT NULL,
  status              TEXT NOT NULL,   -- success | failed | cache-hit | cache-hit-remote | skipped
  exit_code           INTEGER NOT NULL,
  duration_ms         INTEGER NOT NULL,
  forward_args        TEXT,             -- salted xxh3 of the JSON-encoded `--` args; null when none
  started_at          INTEGER NOT NULL, -- ms-epoch
  ended_at            INTEGER NOT NULL,
  run_id              TEXT,             -- UUIDv7 shared across all tasks in one invocation
  cpu_ms              INTEGER,
  peak_rss_bytes      INTEGER,
  wallclock_start_ns  INTEGER,          -- bigint; serialized as SQLite INTEGER (signed 64-bit)
  wallclock_end_ns    INTEGER,
  cache_hit           INTEGER,          -- 0/1; convenience for flamegraph color
  attempts            INTEGER,          -- v23: attempts a retried task took (>1)
  cached              INTEGER,          -- v25: 1 = declared a cache block; 0 = runs every time
  -- v27: why the task failed or was skipped, as the run's footer said it
  -- (items 267–270); NULL where the reason does not apply
  blocked_by          TEXT,             -- a skip's root blocker (a task id)
  timed_out           INTEGER,          -- 1 when vx's own timeout killed it
  sandbox_violations  INTEGER,          -- the sandbox's violation count
  not_ready           TEXT,             -- 'timeout' | 'exited' | 'spawn' (persistent task)
  restored            INTEGER           -- v31, on a hit: 1 = outputs restored, 0 = up to date
);

-- Two indexes, both append-only under a run's inserts: every row of a run
-- carries the same run_id and a started_at newer than everything before it.
-- There is deliberately NO (project, task) index — it scattered every run's
-- rows over one B-tree leaf per pair (a 1,000-hit warm run's record stage
-- went 57–79 ms → 14–19 ms without it) while its readers gained nothing;
-- the history reader bounds its scan by rowid instead (see history.md).
CREATE INDEX runs_started_at ON runs(started_at);
CREATE INDEX runs_run_id     ON runs(run_id);
-- The one keyed index, PARTIAL over failed rows: a green run's inserts only
-- evaluate its predicate, and the flakiness probe after a miss
-- (failure-mode.ts, "did this key ever fail?") reads a few leaves.
CREATE INDEX runs_failed ON runs(hash) WHERE status = 'failed';

-- Every non-group, non-aborted outcome of a run gets a row, so
-- `invocations.task_count` always equals `COUNT(*)` here for that run_id
-- and the terminal summary's "N total". Two of those outcomes never derive
-- a cache key — a `skipped` task (its upstream failed, so it never probed)
-- and a `persistent` one (a dev server is not cacheable) — and they store
-- `hash = ''`. `''` is impossible for a real key (16 hex chars), so it reads
-- unambiguously as "no key recorded"; the key-diff surfaces (`vx why`'s
-- whyDidThisRerun, the cache-key diff) guard it rather than reporting
-- "inputs unchanged" from two rows that never had inputs to compare.
--
-- A `skipped` row is a task of the run but NOT an execution, so the rate and
-- average aggregates in metrics.ts exclude it: counting a zero-duration
-- non-event would dilute success rate, hit rate and mean duration. The
-- completeness reads (listRuns / getRun / the run-detail timeline) include it.

-- The file-hash memo: a content hash per input file that git could not
-- answer (untracked or dirty), keyed by the stat identity that proves
-- the bytes unchanged. Machine-local; § Cache key derivation step 12.
-- A writing close drops rows unwritten for 30 days, at most once a day
-- (a memo miss is the whole cost of a dropped row; item 1082).
CREATE TABLE file_hashes (
  path         TEXT PRIMARY KEY,
  mtime_ms     INTEGER NOT NULL,
  size_bytes   INTEGER NOT NULL,
  ctime_ms     INTEGER NOT NULL,
  ino          INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  seen_at      INTEGER NOT NULL
);

-- The size of each index blob the enumeration checked against the
-- worktree size git recorded (§ Cache key derivation, A-60): fixed for
-- its OID, so a warm run asks git for none. Swept with file_hashes by
-- seen_at, the time the row was written.
CREATE TABLE blob_sizes (
  oid     TEXT PRIMARY KEY,
  size    INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);

-- v30: the paths an index distrusts, by a hash of the index file and the
-- pathspecs (A-60): a warm run reads one row, not one per blob. Swept
-- with file_hashes.
CREATE TABLE blob_verdicts (
  digest  TEXT PRIMARY KEY,
  paths   TEXT NOT NULL,
  seen_at INTEGER NOT NULL
);

-- v16: per-output-file fingerprints, scoped by the entry that produced
-- them — what a hit stats to skip the restore when the tree is already
-- current (§ A current tree). ON DELETE CASCADE follows a prune.
CREATE TABLE output_files (
  entry_hash  TEXT NOT NULL,
  path        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  mode        INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  PRIMARY KEY (entry_hash, path),
  FOREIGN KEY (entry_hash) REFERENCES entries(hash) ON DELETE CASCADE
);

-- v28, its own table since v32: inode + ctime THIS workspace saw after
-- the save/restore that last wrote the file (item 886); no row is never
-- current. Apart from the shared entry: two worktrees overwrote each
-- other's stamps and every switch restored. No foreign key (the entry
-- may be the store's); prune and re-save delete what they orphan.
CREATE TABLE output_stamps (
  entry_hash  TEXT NOT NULL,
  path        TEXT NOT NULL,
  ino         INTEGER NOT NULL,
  ctime_ms    INTEGER NOT NULL,
  PRIMARY KEY (entry_hash, path)
);

-- Each config's ORDERED import closure (the config first), so a warm
-- load keys it by stat-hashing the list through file_hashes instead of
-- reading every file. Machine-local; pruned with config_evals.
CREATE TABLE config_closures (
  config_path TEXT PRIMARY KEY,
  files_json  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Every directory under a whole-subtree output glob, with its mtime as
-- of the last save or restore on THIS machine: unchanged mtimes prove
-- the output SET unchanged without a glob walk. Machine-local — a remote
-- ingest writes none, and the first hit after it walks and records.
CREATE TABLE output_dirs (
  entry_hash  TEXT NOT NULL,
  path        TEXT NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  PRIMARY KEY (entry_hash, path)       -- no foreign key since v32, as output_stamps
);

-- v22 (Tier 3): one header row per `vx run` invocation. The `runs`
-- table is per-task; this is the per-invocation record carrying the
-- command, git/CI/host context, tags, and run-level counts. Recorded
-- atomically alongside `runs` via recordRunBundle (one transaction).
CREATE TABLE invocations (
  run_id            TEXT PRIMARY KEY,         -- UUIDv7, == runs.run_id
  command           TEXT NOT NULL,            -- full argv, e.g. "vx run build --all"
  requested_tasks   TEXT NOT NULL,            -- JSON string[] of options.tasks
  cache_policy      TEXT NOT NULL,            -- compact flags, e.g. "lR,lW,rR,rW"
  concurrency       INTEGER NOT NULL,
  flow              TEXT,                     -- 'focused' | 'broad' | NULL (programmatic)
  started_at        INTEGER NOT NULL,         -- ms-epoch
  ended_at          INTEGER NOT NULL,
  total_duration_ms INTEGER NOT NULL,         -- wall clock of the whole run
  task_count        INTEGER NOT NULL,         -- non-group, non-aborted tasks recorded
  failed_count      INTEGER NOT NULL,
  hit_count         INTEGER NOT NULL,         -- cache-hit + cache-hit-remote
  hit_local_count   INTEGER NOT NULL,         -- cache-hit
  hit_remote_count  INTEGER NOT NULL,         -- cache-hit-remote
  up_to_date_count       INTEGER NOT NULL DEFAULT 0, -- v31: hits that restored nothing
  restored_local_count   INTEGER NOT NULL DEFAULT 0, -- v31: hits that restored, local layer
  restored_remote_count  INTEGER NOT NULL DEFAULT 0, -- v31: hits that restored, remote layer
  exit_ok           INTEGER NOT NULL,         -- 1 if the run's `ok`
  commit_sha        TEXT,                     -- nullable: not a git repo / probe failed
  branch            TEXT,
  dirty             INTEGER,                  -- 1 if worktree had uncommitted changes
  ci                INTEGER NOT NULL,         -- 1 if a CI env was detected
  ci_provider       TEXT,                     -- 'github' | 'gitlab' | 'buildkite' | 'circleci' | 'generic'
  host              TEXT,                     -- os.hostname()
  os                TEXT,                     -- process.platform
  arch              TEXT,                     -- process.arch
  vx_version        TEXT NOT NULL,
  tags              TEXT NOT NULL DEFAULT '{}' -- JSON object {k:v} from --tag
);
CREATE INDEX invocations_started ON invocations(started_at);
CREATE INDEX invocations_branch  ON invocations(branch);
CREATE INDEX invocations_ci      ON invocations(ci);

-- v22 (Tier 3): the input-fingerprint moat. One row per cache-key
-- component, keyed by the cache-ENTRY hash it belongs to (NOT a run
-- id). Written INSIDE the entry-save transaction — only on a cache
-- MISS, never on a hit — via INSERT OR IGNORE. A warm all-cache-hit
-- run writes nothing here. The "why did this re-run?" diff resolves a
-- run to its task hash (runs.hash), then anti-joins two entries'
-- (kind,name,hash) rows in SQL, no app-side recompute. ON DELETE
-- CASCADE sweeps the rows when a prune drops the entry.
CREATE TABLE entry_inputs (
  entry_hash TEXT NOT NULL,          -- == entries.hash / runs.hash
  kind       TEXT NOT NULL,          -- file|env|runtime|ws-runtime|upstream|package|config|forward|workspace|plugin
  name       TEXT NOT NULL,          -- file: workspace-rel path; env: var name; upstream: task id; …
  hash       TEXT NOT NULL,          -- env|runtime|ws-runtime|forward|plugin: xxh3hex(salt + value); an unset env var: 'unset'
  PRIMARY KEY (entry_hash, kind, name),
  FOREIGN KEY (entry_hash) REFERENCES entries(hash) ON DELETE CASCADE
);

-- v32: what belongs to the entries, not to one workspace: 'value_salt',
-- the salt entry_inputs digests are taken under, so they compare with
-- another workspace's run.
CREATE TABLE store_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

WAL mode is on; readers don't block writers. `PRAGMA busy_timeout =
5000` makes concurrent `vx run` invocations queue instead of failing
with `SQLITE_BUSY`.

> **Trust boundary (Tier 3):** `entry_inputs` stores a digest of each
> value-bearing component — `env`, `runtime`, `ws-runtime`, `forward`
> and `plugin` rows hold `xxh3hex(salt + value)`, an unset env var the
> literal `'unset'` — never the value, so a secret read as a cache input
> does not land in `cache.db` as plaintext. The salt is 128 random bits
> the store draws once (`store_meta` key `value_salt`): `vx why` prints
> these digests, and an unkeyed xxh3 in a public CI log let anyone
> confirm or brute-force a short secret. The "why did this re-run?" diff
> only needs to know a component changed, which the digest tells it.
> `cache.db` still records commands and captured stdout; it is a local,
> gitignored, single-user file.

The Tier-3 tables persist components that were **already fed to
`Cache.key()`** — the cache key derivation is unchanged, so the
`CACHE_VERSION` is NOT bumped (only `SCHEMA_VERSION` rolls to `v22`).
Capture happens as a pure side-channel inside the existing `key()` fold
(`CacheKeyInput.captureInto`), **only on a cache miss** (the warm path
captures nothing), and the rows are persisted with the entry — so a
warm all-cache-hit run does no extra hashing, I/O, or DB writes for the
moat.

### Why SQLite + a single artifact per entry

- **Index queries are fast.** Stats (`SELECT COUNT(*) FROM entries`),
  TTL pruning (`WHERE accessed_at < ?`), per-task lookup
  (`WHERE hash = ?`) all hit a B-tree.
- **A hit costs SQL, not decompression.** Metadata + stdout live in
  the row; the artifact is only opened when outputs actually restore.
- **One artifact = one wire payload.** The same tar.zst bytes serve
  local storage and the remote round-trip — no repacking.
- **One handle, one schema-meta sentinel.** An older schema drops
  and recreates every table but `schema_meta` (pre-alpha) — there's no migration code to maintain.

## Config evaluation cache

Evaluating configs is the largest fixed cost of a warm run on a big
workspace (~80 ms for 1000 synthetic configs; reading them as data is
~12 ms). A config that is **provably pure** — every import relative or
`@vzn/vx`, and no mention of `process`, `Bun`, `Date`, `fetch`,
`import.meta`, `require`, a dynamic `import()`, `await`, … outside string
literals and comments — is served from `cache.db`'s `config_evals` table,
keyed by the git blob id of the config and of every file in its
relative import closure, the workspace fingerprint (lockfiles) and Bun's
version. Editing a shared preset moves the key. On a warm run the
closure is remembered per config, so the key comes from a stat-backed
identity per file — no read, no scan — for every config whose relative
imports name their files outright: an explicit extension, the file
itself, no symlink on the way (an extensionless import, a `.js` Bun
answers with a `.ts`, or a link could be re-resolved without touching a
listed file, so such a config keeps the scan). Anything the static check cannot prove
pure evaluates live, exactly as before, so the cache can be slower but
not wrong for a config written in good faith (the check is syntactic; one
built to defeat it can). Details and the deny-list:
[`modules/config-cache.md`](./modules/config-cache.md).

## Performance characteristics

- **Hashing cost** on a clean tree is near-zero per file: git index
  OIDs come from the bulk enumeration spawn, so key derivation does no
  file reads. Dirty/untracked files — and any path whose OID is not
  trustworthy (see "Clean filters") — hash in-process (whole-file
  read, behind a `(mtime, size, ctime, ino)` memo). Narrow
  `inputs.files` still helps on heavily dirty trees.
- **Cache read** is three indexed `SELECT`s (the `entries` row, its
  `output_files` and its `output_dirs`) plus an `existsSync` of the
  artifact.
  Restore is a tar.zst extract, skipped entirely when the on-disk
  tree already matches. `accessed_at` bumps are batched into one
  UPDATE at flush time.
- **Cache write** is one in-process tar.zst pack + atomic rename +
  one SQLite transaction. Hashing dominates the run; storage itself
  is cheap. The remote upload (if any) is backgrounded.
- **Workspace fingerprint** is computed once per `vx run` invocation
  and reused for every task in that run; after a task that may rewrite
  one of its files ran, one `stat` per file re-checks it (item 750).

## What's NOT in the key (and why)

- **`exec.env.passThrough` _values_.** Would force cache misses across
  machines with different CI flags, regions, or shell prompts. The
  _names_ are in the config hash (step 5) so adding/removing a
  passthrough still bumps the key for affected tasks.
- **Files outside the project directory that aren't declared.**
  Workspace-root configs (`tsconfig.base.json`, etc.) are not
  auto-included — declare them via `cache.inputs.workspaceFiles`
  (root-anchored globs).
- **Node / Bun / OS / build-tool versions — unless you declare them.**
  The canonical mechanism is `cache.inputs.runtime` /
  `workspaceRuntime` (e.g. `workspaceRuntime: ['node -v']`): the
  command output is resolved live at hash time, so it stays correct
  under `--frozen`. Avoid baking versions via
  `define: { X: execSync(...) }` — that value freezes into the config
  object at lock time and goes stale.
- **`vx-lock.json`** — globally excluded (v24); also filtered out of
  `--affected` change sets.
- **`exec.remote`.** Pure PLACEMENT: it decides _where_ a task runs,
  never what it produces, so pinning a task to this machine does not
  bust its cache. It must not — the
  whole contract of a remote executor is that the same command over the
  same inputs yields the same outputs, so a key that moved with
  placement would split your laptop from the worker pool over nothing.

  **`exec.timeout` and `exec.retries` are the deliberate exception** —
  they stay in the key. That asymmetry is easy to misread as an
  oversight, so: a timeout or a retry budget can change _whether the
  task completes at all_, which is a different question from where it
  ran. They were folded in before the placement fields existed, and
  stripping them now would be a `CACHE_VERSION` bump for no correctness
  gain.

## Bumping `CACHE_VERSION`

The cache records the version it was written under
(`schema_meta.cache_version`). After an upgrade every cached task
misses once and re-saves, with nothing printed (owner, 2026-10-06: the
cache is vx's to keep). The index survives, so the old entries stay
until they age out under `vx cache prune --older-than` or
`cacheRetention`; no key derives to them again.

Required when:

- A new field is added to the cache key derivation (step list above).
- The order or framing of existing key fields changes.
- The on-disk layout changes (artifact format, entry naming).
- The `CacheEntry` shape changes in a way that affects restore.
- The SQLite schema changes in a way that affects existing rows
  (`SCHEMA_VERSION` also bumps in that case).

Not required when:

- Behavioural changes that adjust _which_ values flow into existing
  key components — those naturally produce different keys for
  affected tasks.
- Changes to WHEN reads/writes fire (policy, prefetch, restore tier,
  background uploads) — key derivation and artifact bytes untouched.
- Doc-only updates.
- Refactors that don't change the bytes fed into the hash.

`tests/contract-stored-format.test.ts` holds the layout rows: it
records the index's DDL beside `SCHEMA_VERSION` and a fixture
artifact's entries, sidecar and digest beside `CACHE_VERSION`
(`tests/contract/stored-format.json`), and fails when either layout
moves under its recorded version. Every bump of either version
regenerates the record
(`VX_UPDATE_CONTRACT=1 bun test tests/contract-stored-format.test.ts`),
which refuses a layout that moved without one.

The bump procedure has a dedicated skill at
`.claude/skills/bump-cache-version/` (used as `/bump-cache-version`).
Files touched, in the skill's order: `src/cache/key-fold.ts` (the constant),
this doc (history), `docs/modules/cache.md` (the quoted version, and the
key/entry shape if it changed), `CLAUDE.md` § Live invariants (the quoted
version — the decision log it once named was retired 2026-09-02),
`docs/STATUS.md` (the entry that says why the bump was needed, or why it
was not), the cache tests, `tests/contract/stored-format.json`
(regenerated, above), and
`packages/vx-docs/src/content/docs/guides/upgrading.md` (the bump's
breaking footer).

### History

- **v38 → v39**: stored bytes wrong under an unchanged key (A-61). A
  gitlink whose directory had lost its `.git` but held files listed
  none of them, so an entry built from them sits under the key the
  same directory empty derives.
- **v37 → v38**: stored bytes wrong under an unchanged key (A-60). A
  file added under a clean filter that was later removed kept its LF
  index blob, git held it clean by its stat, and the key folded that
  blob while the task read the CRLF bytes. The blob-size check cannot
  reach an entry already saved that way.
- **v36 → v37**: stored bytes wrong under an unchanged key (A-59).
  `git status` paired a deleted file with a similar unmerged path as its
  rename source and printed only `UU <path>`, so the file kept its index
  OID and the key folded it while the task ran without it. The fix
  (`--no-renames`) cannot reach an entry already saved that way.
- **v35 → v36**: the container changes (L-19). Every artifact ends in a
  `.vx-sum` entry, a CRC-32 over the entries before it, and scan and
  restore refuse one whose sum is absent or wrong: a byte flipped in a
  raw zstd block restored as a hit, undetected. A v35 artifact carries no
  sum, so the bump retires them rather than refusing each on read.
- **v34 → v35**: the container changes (item 943). The sidecar records
  the cache key the artifact was packed under, and ingest refuses bytes
  whose key is not the one it asked for, or that record none. Nothing
  tied an artifact to its key before: a remote layer that answered one
  key with another's bytes (a truncated or colliding key mapping, two
  namespaces mixed) replayed the other task's outputs under a green
  `cache-hit-remote`, probed with project `b` restoring project `a`'s
  `out.txt`. An artifact from v34 records no key, so the bump retires
  them rather than refusing each one on read.
- **v33 → v34**: stored bytes wrong under a key a CORRECT derivation now
  produces (item 750). A root task that rewrote the lockfile mid-run
  (`pnpm install` without `--frozen-lockfile`) let a reader after it save
  a build made against the new install under the key of the lockfile the
  run started with, and that key is exactly what the fixed code derives
  when the tree is back on that lockfile. The fix stops new entries, not
  old ones. Probed, not argued: seeds A then B through the previous
  commit, then A twice through the fixed code under v33 — the last run
  started on lockfile A, installed A, and restored the build made against
  B; under v34 it built A. The item's other two edges poisoned nothing:
  their stale restores happened in runs that saved nothing (a read-only
  policy, a tainted upstream) or saved under a key the 743 re-check
  already guarded.
- **v32 → v33**: stored bytes wrong under a key a CORRECT derivation now
  produces (item 743). The three stale-hit fixes of that item stop new
  poisoned entries, but not the ones already saved: a formatter's entry
  sits under the key of its unformatted input, an uncached `gen`'s
  consumer's under the key of the seed before `gen` ran, an edit-mid-run's
  under the key of the file before the edit — and each of those keys is
  exactly what the fixed code derives when the tree is back in that
  state. Not self-healing, unlike a fix whose old key no correct run
  derives. Probed, not argued: an entry saved by the previous commit's
  formatter, the input checked out unformatted, and the fixed code under
  v32 reported `up-to-date` and left it unformatted; under v33 it runs.
- **v31 → v32**: stored bytes wrong under a key the fix does not change
  (item 739). A declared output whose name is not UTF-8 (`x\xffy`) came
  back from `Bun.Glob` decoded lossily as `x�y`, which names no file, so
  the save packed the tree without it and every hit restored a tree
  missing that file under an unchanged key. vx now refuses such a name
  by name; an artifact saved before the fix is the wrong bytes, so v31
  entries are not trusted.
- **v30 → v31**: stored bytes wrong under a key the fix does not change
  (item 726), v30's shape for a sibling. A sandboxed task that declared
  `cache` was granted every workspace package linked in its
  `node_modules`, so it could import a sibling its key never folded and
  save what it built. The fix withholds that link unless the key answers
  for the package (§ Cross-project boundaries), so the next miss fails
  on the read; but an entry saved before it still hits when only the
  sibling changes. Probed, not argued: an entry saved by the previous
  commit, `@x/ui` edited, then this commit's run under v30 reported
  `up-to-date` and left the old `ui` in `dist/`; under v31 the same run
  misses and fails on the read, with the hint.

- **v29 → v30**: stored bytes wrong under a key the fix does not change
  (item 720). npm and Yarn link every workspace package at the root, the
  task's own included, and the sandbox granted every link target whole,
  so a sandboxed task was handed its own project back whatever its
  `allow.read` said. An undeclared read of its own file ran unreported
  and the result was saved under a key that never saw that file. The fix
  withholds the self-link, so the next miss fails on the read; but an
  entry saved before it hits for as long as only that file changes.

- **v28 → v29**: every key moves, and the bump is for the notice, not
  for wrong bytes (item 682). The key is a seed-chained xxHash3 fold,
  one step per field and per input file, and Bun's xxHash3 reads only
  the low 32 bits of its seed: a bare chain carried 32 bits of state, so
  two input sets whose running digests shared their low halves merged at
  the next step, a stale hit at about 2^-32 per step rather than 2^-64.
  A birthday search over 2^17 values of one env variable found two that
  gave one `Cache.key` in under a second. `xxh3` now feeds the seed
  forward (`xxHash3(part, seed) ^ seed`): states that share their low
  half keep their high-half difference through every later step. The
  old keys were wrong but their stored bytes are not, so the fix alone
  is self-healing; without the bump every entry would miss silently.

- **v27 → v28**: stored bytes wrong under a key the fix does not change —
  the v25/v26 shape (item 667). A bracket in a task glob became a literal
  character; before, `Bun.Glob` read it as a character class. An INPUT
  glob over a route directory folded the wrong files, and that fix is
  self-healing: the file set, and so the key, moves. An OUTPUT glob is
  not: `outputs: ['app/[id]/page.js']` folds as its text, which the fix
  leaves unchanged, and the entries under it hold nothing (or the class's
  namesake `app/i/page.js`). Proven through a real run: an entry written
  by v27 code, read by the fixed code, was a `cache-hit` that cleaned
  `app/[id]/page.js` and restored nothing; under v28 it is a miss, and
  the next hit restores the route.

- **v26 → v27**: the artifact CONTAINER changed, so the stored bytes
  under an unchanged key are no longer readable the same way — the
  layout case, not the wrong-bytes case. Packing moved from a `tar`
  subprocess (with a staged copy of every output and a per-host
  `--format=gnu` / `--format=gnutar` probe) to `Bun.Archive`, and the
  per-entry mode + millisecond mtime that tar headers carried natively
  now ride a `.vx-meta.json` sidecar. Measured on the real `Cache.save`
  path (300 outputs / 12 MB, min-of-5, interleaved arms against a
  `git worktree` of the previous commit): **158 ms → 11 ms** to pack,
  the artifact grows ~7 compressed bytes per output for the sidecar.
  Restore is indistinguishable up to ~12 MB, but on a 150 MB
  incompressible artifact it costs +28% time and +19% peak RSS
  (74 → 95 ms, 575 → 683 MB peak, fresh process per arm): `files()`
  returns entries that OWN their bytes, so they coexist with the
  decompressed tar where the old reader returned views into it. Peak is
  ~4.5× artifact size, up from ~3.8×. The bump is mandatory rather than
  self-healing: a v26 artifact has no sidecar, so a v27 reader would
  restore its outputs mode-0644 and mtime-now — silently wrong on disk
  rather than a miss. Since 2026-09-03 the same layout is written and
  read by vx's own streaming tar code (no bump: the bytes are readable
  either way), and the peak above is history — save, ingest and restore
  hold one chunk now; see § Storage layout.

- **v25 → v26**: the same shape as v25 — stored bytes that are wrong
  under a key nothing about the fix changes — reached by a different
  producer. A task whose child was killed by a shutdown signal reports
  `aborted`, but `aborted` did not propagate to dependents the way
  `failed` and `skipped` do. So a dependent ran against the aborted
  task's PARTIAL outputs, succeeded, and cached what it had built.
  Because a dependent's key folds its upstream's INPUT key — and a
  signal changes no input — that entry sits under exactly the key a
  healthy run derives, and the next run replays it as a green hit with
  exit 0. Reproduced end to end: run 1 killed mid-write leaves
  `PARTIAL`, run 2 is fully healthy and still serves `PARTIAL` from
  cache.

  Making `aborted` propagate stops new poison but cannot reach entries
  already written, and a `LayeredCache` uploads them — so the reach is
  a whole team's shared cache, not one developer's disk. That is what
  makes the trade worth it: one cold rebuild against a class of
  silently-wrong output. The interactive Ctrl-C path was never the
  vector (vx's handler exits before a dependent can cache); the
  reachable ones are an external `kill`, a supervisor, `docker stop`, a
  self-terminating script, and every `handleSignals: false` embedder —
  which includes `vx watch` and the distributed agent loop.

- **v24 → v25**: the ARTIFACT BYTES in every existing entry are wrong
  while the key addressing them is unchanged — the one situation a
  version bump exists for, and the opposite of the recent self-healing
  no-bump cases. Two defects on the pack/restore path, both silent data
  loss on an ordinary cache hit with no attacker involved:
  - **The executable bit was stripped from every cached output.**
    `packArtifact` staged each output with `Bun.write`, which creates
    the destination under the process umask and does NOT carry the
    source's mode, so the tar header recorded 0644 and the restore
    faithfully reproduced 0644. Any build emitting a CLI shim, a
    compiled binary or a generated script worked cold and broke warm —
    including this repo's own `build.bun.*` release binaries. Fixed by
    chmod-ing each staged copy to the source's mode.
  - **Outputs whose archive entry name exceeded 100 bytes were dropped
    on every restore.** POSIX ustar splits such a name into
    `prefix` + `name`; the reader read only `name`, which no longer
    starts with `outputs/`, so the file was neither restored nor
    indexed. Not self-healing: with no `output_files` row, the
    skip-restore check compared a truncated expectation against a
    truncated tree and agreed forever. Threshold is a
    project-relative output path of ~93 chars — ordinary for a modern
    bundler. Fixed by reading `prefix` (gated on the POSIX magic, since
    GNU headers reuse those bytes for atime) AND by packing
    `--format=gnu`, which carries long names in an `L` record.

  The format switch also fixes a working build being reported as
  FAILED: ustar cannot split a single path COMPONENT over 100 bytes and
  exits non-zero ("file name is too long (cannot be split)"), which
  `packArtifact` raised _after_ the task had already succeeded. 120-char
  filenames are legal everywhere and routine in snapshot/fixture trees.

  Shipped with three defence-in-depth fixes that needed no bump of their
  own: `restoreOutputs` now throws instead of returning quietly when the
  artifact is gone or cannot produce an output the index recorded (the
  caller has already wiped the declared outputs by then, so a quiet
  return reported a green hit over an emptied tree — reachable via a
  concurrent `vx cache prune`); the tar reader rejects an entry whose
  declared size runs past the end of the archive (`subarray` clamps, so
  it used to install short, NUL-padded content as a cache hit instead of
  degrading to a miss); and directory entries now get the same
  containment + realpath checks as file entries (`mkdir` follows a
  pre-existing symlink, so directories could be created outside the
  destination). No `SCHEMA_VERSION` bump — no table changed.

- **SCHEMA v23 → v24 (no `CACHE_VERSION` bump)**: `file_hashes` gains
  `ctime_ms` + `ino`. The memo keyed on `(mtime, size)` alone, and its
  row persists across runs, so any producer that preserves mtime —
  `tar -x`, `unzip`, `cp -p`, `rsync --times`, a `SOURCE_DATE_EPOCH`
  generator — got the previous run's digest for genuinely different
  bytes: a stale cache hit. `utimes` cannot suppress ctime
  unprivileged and an atomic write-then-rename changes the inode, so
  the two together close it (git's index keys on ctime+ino+dev for the
  same reason); both come free from the stat already taken. The key
  DERIVATION is unchanged — the memo simply stops answering wrongly —
  so an affected task's key moves from a wrong value to the right one:
  it misses once, re-runs, re-caches. Self-healing, never a wrong hit.
  Landed alongside two other stale-hit fixes that needed no schema
  change: the cache-miss path now marks the outputs `cleanOutputs`
  wiped (it was the only one of four sibling call sites that dropped
  the return, so a deleted output kept a live index OID and stayed in
  a consumer's input set), and `skip-worktree` / `assume-unchanged`
  entries no longer keep a trusted OID (they sit at stage 0 and
  `git status` reports nothing for them, so a sparse-checkout path
  that was absent from disk still counted as an input). The schema
  gate drops + recreates on the version mismatch (pre-alpha, no
  migration), so this costs one cold rebuild.
- **SCHEMA v21 → v22 (no `CACHE_VERSION` bump)**: Tier-3 dashboard
  tables — `invocations` (one header row per `vx run` with command,
  git/CI/host context, tags, and run-level counts, recorded with `runs`
  via `Cache.recordRunBundle`) and `entry_inputs` (one row per cache-key
  component, keyed by the cache-ENTRY hash — the input-fingerprint
  moat). `entry_inputs` is written **inside the entry-save transaction,
  only on a cache miss** (`INSERT OR IGNORE`), so a warm all-cache-hit
  run writes nothing for the moat — Tier 3 has **zero warm-run cost**.
  The cache KEY derivation is unchanged: these tables persist components
  already fed to `Cache.key()` (captured via a pure side-channel,
  `CacheKeyInput.captureInto`, at the same fold sites — only on a miss),
  so existing artifacts stay valid and `CACHE_VERSION` stays `v24`. The
  schema gate drops + recreates on the version mismatch (pre-alpha, no
  migration).
- **v23 → v24**: exclude `vx-lock.json` from the input file set
  globally (`ALWAYS_IGNORE` in `cache/inputs.ts`). The lockfile is
  committed, so git enumerates it, but it's vx's own frozen-config
  metadata — never a task input. Without this, a `vx lock` re-write
  busts every key on a project that globs the root lockfile (a broad
  `**/*` on the root project). Tasks whose `cache.inputs.files` never
  matched it derive byte-identical keys. No SCHEMA bump — only the
  hashed file set changed, not the key layout or on-disk format.

- **v22 → v23**: fold `cache.inputs.runtime` / `workspaceRuntime`
  command output into the key (two namespaced sections after
  env-values). The command _strings_ stay in the config hash (step 5);
  their combined trimmed stdout+stderr is resolved live at hash time
  and folded as `runtime-values:` (project-cwd) and `ws-runtime-values:`
  (root-cwd) sections, each `command\0output`. No SCHEMA bump — only
  `Cache.key` derivation gained two sections; the on-disk format is
  unchanged. Tasks declaring neither field fold a `:0` count for both
  and derive byte-identical keys to before the bump.

- **v21 → v22: pure-input transitive** (+ SCHEMA v21): reverted the v21
  output-fold. Downstream keys fold the upstream's **input key** (its
  own task hash) — a pure function of the filesystem, like Turbo/Nx.
  No output content participates in any cache key. **Early cutoff is
  gone**: an upstream that re-executes (comment edit, env change) but
  reproduces byte-identical output now still re-runs its dependents.
  This was a deliberate simplification — cutoff is rare in practice
  and not worth the cascade complexity (it forced output content into
  keys, which blocks any upfront/batched probe). **Multi-state is
  preserved**: branch ping-pong A→B→A still re-hits, because the
  upstream's _input_ differs per state and folds transitively into
  every dependent key. SCHEMA v21 drops the now-unused `outputs_hash`
  column; `CacheLayer.save` returns `void`.

- **v20 → v21: early cutoff** (+ SCHEMA v19, **reverted in v22**):
  downstream keys folded the upstream's output content identity
  (`outputsHash`) instead of its task hash. Removed — see v22.

- **v7 → v8** (PR #2): folded `forwardArgs` into the key for CLI
  argument-forwarding alignment.
- **v8 → v9** (PR #3): `TaskConfig` shape changed — `exec` collapsed
  from an array to a single command, `tasks` nested under `run`.
- **v9 → v10** (PR #7): on-disk layout switched from per-entry
  `meta.json` + `outputs/` directory to a workspace-wide `cache.db`
  (SQLite) plus output files directly at `<hash>/` and log files at
  `logs/<hash>.{stdout,stderr}`. Adds run history for `vx stats`.
  Removes the per-entry manifest.
- **v10 → v11** (PR #19): analytics columns added to the `runs`
  table: `run_id` (UUIDv7), `cpu_ms`, `peak_rss_bytes`,
  `wallclock_start_ns` / `wallclock_end_ns`, `cache_hit`. All
  nullable; directly queryable via `sqlite3 cache.db`. The on-disk
  `<hash>/` layout itself was unchanged.
- **v11 → v12** (PR #42): project's `package.json` bytes folded into
  every task's cache key implicitly. Matches Turbo / Nx "implicit
  dependencies" behavior — a `package.json` dep change invalidates
  the project's tasks even when `cache.inputs.files` is narrow and
  doesn't cover the file.
- **v12 → v13** (PR #65): per-entry on-disk layout unified. Outputs
  moved from `<hash>/<rel>` (mixed with metadata) to
  `<hash>/outputs/<rel>`; stdout / stderr moved from the sibling
  `logs/<hash>.{stdout,stderr}` into `<hash>/stdout` and
  `<hash>/stderr`. Eviction collapses to a single `rm -rf <hash>/`.
  Also dropped the runner's `logs/<run_id>/<project>__<task>.{stdout,stderr}`
  dump — output is already streamed live, surfaced on the outcome
  object, and the cache entry covers successful runs; CI captures
  parent stdout natively. The duplicate sibling dump was pure
  redundancy.
- **v13 → v14**: file enumeration switched from a `Bun.Glob` walker
  with our own `ignore`-library filter to `git ls-files --cached
--others --exclude-standard`. Matches what Turborepo and Nx both do
  at the bottom of their hash pipelines. Side-effects user-visible:
  (a) nested `.gitignore` patterns are anchored to the gitignore's own
  directory, fixing the v13 footgun where `pkg/.gitignore: src/skip.ts`
  was misinterpreted as `<workspaceRoot>/src/skip.ts`; (b)
  `.git/info/exclude` and global excludes participate; (c)
  untracked-but-not-ignored files enter inputs immediately (no
  `git add` required). (The non-git fallback walker was later removed
  entirely — vx hard-requires git; a non-repo workspace gets a clean
  `UserError` telling the user to `git init`.)
- **v14 → v15**: cache-key hash swapped from SHA-256 (via
  `Bun.CryptoHasher`) to xxHash3 (via `Bun.hash.xxHash3`). Key strings
  shrink from 64 hex chars to 16, matching Turbo's xxh64 output width;
  derivation is ~5× faster, dominating the cache-warm path that
  hashes hundreds of input files. xxHash3 has no streaming Hasher
  API, so `Cache.key()` chains via the seed parameter (each
  `xxh3(part, prevDigest)` folds one field into the running digest)
  and `hashFileFromDisk` reads the whole file before hashing — fine
  for source files (typically < 1MB each); the throughput win
  outweighs the memory hit. `SCHEMA_VERSION` bumps to `v15` at the
  same time (PR #86 already took `v14` for the tar.zst artifact
  layout): the `file_hashes.sha256` column is renamed to
  `content_hash`, and the schema-mismatch path now `DROP`s the stale
  tables before `CREATE TABLE IF NOT EXISTS` runs so the rename
  actually takes effect on existing DBs. Non-cryptographic by design
  — cache keys never need collision resistance against an adversary,
  just uniqueness across honest inputs.
- **v15 → v16** (PR #86 series): artifact storage moved to a single
  compressed `<hash>.tar.zst` per entry; the manifest.json entry was
  dropped (file fingerprints live in the `output_files` table).
- **v16 → v17**: artifact narrowed to exactly `stdout` +
  `outputs/<rel>` — no `meta.json`, no stderr (only successful runs
  are cached and their stderr is near-always empty noise). Local and
  remote layers transport the same bytes end-to-end; entry metadata
  lives solely in SQLite.
- **v17 → v18**: env-value folding in `Cache.key()` switched its
  name/value delimiter from `=` to `\0`. `${n}=${v}` was ambiguous —
  `("A", "B=C")` and `("A=B", "C")` folded identical bytes. Env names
  containing `=` are unreachable from a real POSIX environ, so this
  is contract hardening rather than a field bug, but the key
  derivation's stated invariant is unambiguous part boundaries —
  now it holds everywhere (file inputs already used `\0`).
- **v18 → v19**: `'^task'` dependsOn expansion switched from
  transitive-deps to nearest-holder frontier semantics (Turbo/Nx
  direct-deps parity, plus vx's sparse bridging through deps that
  don't declare the task). Task graphs lose the redundant deep edges,
  so the filtered-upstream-hash set (step 10) shrinks for any task
  whose deps chain `'^task'` themselves — same inputs now derive a
  different key. Reachability/ordering is unchanged whenever holders
  chain `'^task'` (the universal pattern); a holder that doesn't is
  now the documented stopping point. No on-disk format change.
- **v19 → v20**: input-file content hashes switched from xxh3 to
  **git blob OIDs** (Turbo's technique). The bulk enumeration spawn
  became `git ls-files -s --others --exclude-standard` — `-s` lines
  carry `<mode> <oid> <stage>\t<path>` for tracked files, so one
  spawn yields the file list AND the index OIDs; a second
  `git status --porcelain -z` spawn prunes OIDs for paths whose
  working tree diverges from the index (renames drop both sides;
  stage>0 conflict entries never get one; symlinks did not either
  until 2026-09-09, when the fallback started hashing a link the way
  the index does). A clean
  tree's key derivation does zero reads / stats / SQLite per file.
  Everything else falls back to `Cache.hashFile`, which now computes
  the identical blob OID in-process (object format auto-detected via
  `git rev-parse --show-object-format`, sha1 default) behind the
  existing mtime+size memo. `SCHEMA_VERSION` bumps to `v18` in the
  same change: pre-v20 `file_hashes.content_hash` rows store 16-hex
  xxh3 digests that must not leak into the OID domain through the
  memo. File-set visibility semantics are unchanged (verified: the
  `-s --others` path set is identical to `--cached --others`,
  including staged-but-deleted files and per-stage conflict
  duplicates).
