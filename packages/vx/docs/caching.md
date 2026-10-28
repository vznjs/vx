# Caching

`@vzn/vx`'s cache is content-addressed, opt-in per task, and shaped to
cascade through the dependency graph the same way Turborepo's does.
This page explains _what's in the cache key_, _what triggers
invalidation_, _what's actually stored_, and _why_.

## Why caching is opt-in

A task is cached iff its `TaskConfig` provides a `cache` block, with
`cache.outputs.files` and the task's `inputs.files`. Omit `cache` and
the task always runs; no read, no write. `inputs` stands alone: a task
is keyed on it whether it caches or not, and its dependents fold that
key.

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

Core keys no package file: no `package.json`, lockfile or install
setting is a part of its own. A `package.json` keys a task as an input
it lists (step 11), a lockfile or install setting as a plugin's key
material (step 9); `@vzn/vx-lockfile`'s `bun()`, `pnpm()`, `npm()` and
`yarn()` add both. Without a lockfile plugin an install moves no key, so
a JS workspace declares one (`vx init` and `@vzn/vx-migrate` write it).

The cache key for one task is a **16-hex xxHash3 digest**, seed-chained
over (in order):

1. **`CACHE_VERSION`** — the key-derivation sentinel
   (currently `'vx-cache-v48'`, in `src/cache/key-fold.ts`). Bumped when
   the key derivation or the artifact container changes, or stored bytes
   are wrong under an unchanged key. See
   [§ Bumping CACHE_VERSION](#bumping-cache_version).
2. **`taskId`** — `${projectName}#${taskName}`. Two tasks with
   identical everything else still produce distinct keys — protects
   against e.g. `pkg-a#build` accidentally cache-hitting on a
   `pkg-b#build` entry.
3. **Task config hash** — `xxh3(JSON.stringify(hashableConfig(node.config)))`
   of the _evaluated_ task config. The projection is one field wide:
   `exec.remote` is dropped, because it says WHERE a task runs and not
   what it does (§ What's NOT in the key). Its keys are sorted all the
   way down, so the order a config or a plugin spells them in moves no
   key; `vx lock` writes them sorted, so a run only checks.
   Captures:
   - `exec` block (command, env declarations, timeout, persistent).
   - `dependsOn` and `inputs.tasks` declarations.
   - `cache.outputs.files`, `inputs.files`, `inputs.env`,
     `inputs.runtime` / `workspaceRuntime` declarations (the
     strings themselves; their resolved file content / env values /
     command output contribute separately).
   - `description` (because it's part of the resolved object — even
     though it has no behavioural effect; a description change isn't a
     correctness change but the cost of a re-run is low).
   - **Imported / computed values** — anything a preset or
     `process.env`-read at config-load time injected. Bun's native
     `await import()` evaluates the module and bakes those values into
     the object before we serialize.
4. **`forwardArgs`** — CLI args passed after `--`. Folded into the
   key so `vx run test -- --watch` doesn't cache-hit a previous
   `vx run test`. Scoped to the user-requested tasks only — dependsOn-
   pulled deps don't see them (their cache identity stays clean) — and
   to a command: a requested default `build` runs none and folds none
   (X-119).
5. **`inputs.env` resolved values** — `[name, value]` pairs
   read from host `process.env` at hash time (delimited `name\0value`
   so boundaries are unambiguous). Listed names get their current
   values; an unset name folds its bare name, with no `\0`, so unset
   and set-to-empty are two keys (the child tells them apart:
   `passThrough` leaves an unset name out). A name holding a NUL is
   refused at load.
6. **`inputs.runtime` resolved output** — `[command, output]`
   pairs, where `output` is the trimmed stdout of each command run via
   `sh -c` in the **project dir** at hash time; a command with stderr
   (or a NUL in stdout) folds `\0<stdout length>\0<stdout><stderr>`,
   so bytes moved between the streams move the key.
   The runtime-output analog of step 5: the command _strings_ are in
   the resolved config (step 3), their _output_ is resolved live every
   run. Folded with the command count + each `command\0output` pair.
7. **`inputs.workspaceRuntime` resolved output** — same as step
   8 but commands run at the **workspace root**, and the pairs fold
   into a **distinct namespace** (`ws-runtime-values:`) so an identical
   `(command, output)` never aliases the project-cwd `runtime` values.
8. **Filtered upstream task cache hashes** — every upstream task's
   own cache key, filtered by `inputs.tasks` (default: all of
   them). Sorted by hash before folding so the ordering of `dependsOn`
   doesn't change the key. This is the cascade mechanism: if anything
   beneath you changes, your hash changes too. The set is `dependsOn`'s,
   never the run's selection: a dependency `--exclude-dependencies`
   keeps from running is still folded, with the key a full run would
   derive for it (nx#35234), so the flag moves no key. Its outputs are
   whatever is on disk, which nothing proves current, so a task whose
   key folds one, and everything built on it, may hit but does not
   save (`orchestrator/excluded-keys.ts`); a task with
   `inputs.tasks: []` folds none and saves as usual.
9. **Plugin key material** — the `{ name: value }` pairs a plugin's
   `key(task, ctx)` stage returned for this task, stored on the node as
   sorted `plugin/name` pairs and folded after the upstream keys and BEFORE the input files,
   ONLY when non-empty — so a workspace with no `key` plugin derives
   byte-identical keys to one before the stage existed (no
   `CACHE_VERSION` bump when it shipped). `vx why` names a changed pair
   as `plugin <plugin>/<name>`. Two plugins of one package (a plugin's
   name is its package's) that return one name are told apart as
   `<name>`, `<name>#2`, … in value order, so declaration order still
   keys nothing (item 1028).

   A plugin that reads a root file claims it (`VxPlugin.fingerprint`).
   `@vzn/vx-lockfile`'s `pnpm()` folds the project's own resolved
   dependency closure from `pnpm-lock.yaml` and the root package's, so
   `pnpm update foo` re-keys only the projects that depend on `foo` —
   every project when the root does, since the root's tools run from the
   root `node_modules/.bin` on every task's PATH; `bun()`, `npm()` and
   `yarn()` are the same for their lockfiles (`npm()` reads
   `npm-shrinkwrap.json` over `package-lock.json`, as npm does; `bun()`
   refuses a `bun.lockb` with no `bun.lock`, which it cannot read), and
   this repo declares `bun()`. Each also claims its manager's install
   settings (`pnpm()`: `pnpm-workspace.yaml`, `.npmrc`; `bun()`:
   `bunfig.toml`, `.npmrc`; `npm()`: `.npmrc`; `yarn()`: `.yarnrc.yml`, `.yarnrc`, the root `package.json`'s `workspaces.nohoist` and `installConfig`)
   and folds each whole into every task.

   The run reads each claimed root file once, before any task. A task
   in the root project may rewrite one — `pnpm install` without
   `--frozen-lockfile` updates the lockfile and the installed tree — and
   every key taken before it names the old one. So a task that may
   (unsandboxed in the root project, or granted a write over one) tells
   the run when its command ran, the run re-checks the claimed files
   then (one `stat` each, following a symlink as both reads do — an
   `lstat` missed a lockfile rewritten through a link, item 760 — the
   bytes compared for any written since the read), and once one moved
   nothing keyed on the old bytes is probed or saved for the rest of the
   run, with one status line naming the file. Every reader after such a
   task is keyed late, not up front. Without it the run after a lockfile
   rewrite restored a build made against the old install, and a save
   filed a build against the new install under the old lockfile's key,
   replayed whenever the tree went back (item 750,
   [`modules/fingerprint-watch.md`](./modules/fingerprint-watch.md)).
   With nothing claimed, no root file is read or watched.

10. **Task platform** — the platform core placed a task naming
    `exec.platforms` on (`platform:linux-x64`), folded ONLY for such a
    task, so each platform it runs on keeps its own entry and a task
    naming none keys as before. `vx why` names it as `platform`.
11. **Input files' content hashes** — `inputs.files` resolved to
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
    task as its files-backend twin. A sha256 repository keys from its
    64-hex index OIDs, and a dirty file is hashed in-process as sha256,
    so Git 3's defaults (reftable and sha256 together) run, hit and
    select `--affected` as a sha1 repository does
    (`tests/git-reftable.unsafe.test.ts`).

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

    A task with **no `cache` block** derives a key too, from its
    `inputs` — its dependents fold it (step 8), as Turbo and Nx hash
    every task. That key is for its dependents only: the task always
    runs, and no cache, local or remote, is asked about or handed
    anything under it; its log goes to the run's own store
    (`run/<id>/<task>/log`). A lookup follows `cache`, never a key
    (`tests/uncached-no-lookup.test.ts`). One that also declares no
    `inputs` is **keyless**: no
    key can stand for what it read, so a key that folds it is this
    run's alone, and every task behind it misses and saves nothing.
    A task reading `**` with no `cache` folds its own outputs too,
    since it declared none: its key moves whenever it writes a file
    git does not ignore, so a cached dependent misses once more after
    the upstream's first run. Ignore the outputs in git, narrow its
    `inputs`, or declare the block (`tests/uncached-upstream-key.test.ts`).

    Declaring no outputs, such a task may also have **written** anywhere
    in its project, so what the run learned about that project at its
    start — the git listing and the index OIDs — is dropped once its command exits, pass or fail, and a later key
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

    Your globs are a **filter over the set git reports**, so a broad
    glob never reaches a gitignored file. An entry that names one
    outright does: a literal (`.env.local`, `gen`), or a glob whose fixed
    prefix git ignores (`dist/**`), walked on disk under that prefix
    only (2026-10-16). Such a file is hashed from disk with the
    blob formula an untracked file gets, and is never stored or
    restored. `--affected` reflects only what git sees, so an edit to
    one never selects a task on its own (as in Nx); `vx watch` re-runs
    it on an edit there.
    A **glob** matching nothing stays silent, and so does a literal
    naming a path that does not exist, until it does. An ignored
    directory named outright folds every file under it; an empty one
    folds nothing.

    A task glob is a **standard glob**: `[ab]` is a character class, as
    in `Bun.Glob`, Turbo and Nx, and a route directory is escaped:
    `app/\[id\]/**` folds `app/[id]`. Bare, `app/[id]/**` is the class
    and folds `app/i/…` and `app/d/…`, never the route; `vx lock`
    refuses it when `app/[id]` exists. When an input or output glob
    matches no files and, read as a literal path, names one that exists,
    the "matched no files" warning says so and gives the escaped spelling.

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
    output). Every such window compares a file's stamp, on its file
    system's clock, with a moment vx read from its own, so a run first
    measures how far the file system runs behind (one file written and
    removed in the cache dir) and widens every window by a lag past the
    kernel's tick (20 ms): a WSL2 VM drifted from the Windows host that
    stamps `/mnt/c`, a Docker Desktop bind mount or an NFS server dated an
    edit made while a command ran before the command, and the entry
    filed the edit's output under the old bytes' key (until 2026-10-16).
    That is the same value the index holds whenever no filter applies,
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
    from the index (item 1076). Each of these settings is read as git
    reads a boolean: `false`, `no`, `off`, the empty value or a zero
    integer (`0`, `00`) is false, and a bare key is true.

    A **symlink** folds as git folds it, the blob of its target
    _string_ (its mode-120000 index OID), and then the content behind
    it, as Nx reads a linked file where it points: a file's identity, or
    for a directory every file beneath it at any depth, tracked or not
    (`.git`, `node_modules`, `.vx/cache` and `.yarn/cache` aside, as Nx's walker skips them), a link
    among them followed in turn. The target may be anywhere: in the
    project, elsewhere in the workspace, outside it. Retargeting a link
    changes the key, to equal bytes too; an edit behind it changes the
    key. A dangling link, or a loop of links, keys its target string
    alone. `--affected` selects a link whose target changed (a file
    the diff names, or one under a linked directory) as a changed path of
    its project, and a target git cannot diff (outside the workspace,
    git-ignored) on every run; `vx watch` arms each link's target and
    names the link when it changes (`linked-inputs.ts`). Nx does not
    enter a linked directory; vx does, since the task reads it. A glob
    whose static directory passes through a link (`lib/**` over
    `lib -> ../shared`) takes the link as an input: git lists a linked
    directory as the link alone, so the glob matched nothing and an
    edit behind it was a hit (2026-10-25). A link to a directory below
    a glob's fixed prefix (`src/**/*.ts` over `src/v -> ../shared`,
    `**/*.ts` over `lib -> ../shared`) is an input the same way whenever
    the glob could match a path under it: its name alone matched no
    pattern, and an edit behind it was a hit (2026-10-28).

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
3. Otherwise the `outputs/<rel>` (+ `workspace-outputs/<rel>`) entries
   are extracted from the artifact (its bytes inline in the index, read
   in one read transaction with the entry's rows, or
   `<cacheDir>/<hash>.tar.zst`) **in place**: every entry is staged in
   the workspace's `.vx/tmp/` (never an output folder), and only once the
   whole archive has staged is each renamed over the file it replaces.
   A folder missing on the way (a cleaned `dist/`) is built whole there
   and renamed in once, so a reader sees it complete or not at all; one
   rename per file, each across directories out of one staging
   directory, doubled a 5,000-artifact restore's kernel time. A
   file that already holds the entry's bytes (compared byte for byte, up
   to 4 MiB) is left in place, only its mode and mtime set. A
   target on another filesystem is first copied to a temp beside it,
   every such copy before any rename, so a copy that fails (a full disk
   there) changes nothing; a file
   takes the group its directory gives new files (setgid on Linux, any
   directory on macOS), ACLs are not copied. The next run removes
   the staging a killed run left. A process reading the output tree during the
   restore never finds a declared output missing or half-written, and a
   restore that fails first (a full disk, a damaged entry) leaves the
   outputs as they were. Then the declared outputs the entry does not
   hold are removed — see
   [§ Strict output ownership](#strict-output-ownership). Only a found
   output that blocks a rename (a file where the entry needs a directory,
   or the reverse) goes before. Turbo also restores in place; Nx deletes
   and copies each file, and a reader meets a missing or short file.
4. The captured output is replayed to the live terminal via the
   logger — stdout and stderr, each on its own stream, in the order the
   task wrote them — so the framed block looks like a fresh run.
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
   run's `hashCache` memo, or, when nothing any key folds has moved
   since a run of the same selection, reading that run's keys back
   whole: `orchestrator/run-keys.ts`) and probe local `cache.get` **once**,
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
`vx lock` refuses a task whose input globs can match another task's
declared outputs (X-54, no opt-out), unless git ignores those outputs
whole (and the entry does not start inside them) or the producer is a
dependency its key does not fold, whose bytes it then hashes after the
producer ran, so the clauses on declared outputs fire only for such a
dependency read or a pair the check cannot decide. An output git ignores whole is no reach either:
a key reads only what git lists, so a `**/*` reader beside a gitignored
`**/dist/**` producer keys up front, the same key before and after the
build. The run asks git once, beside its walk and only when a reader
reaches a same-project output: one `git check-ignore` over each such
output's directory (`dist/`, and a fresh `__vx_probe__/dist/` for a
glob that starts with `**`), and the walk's listing must hold no file
the glob matches (a tracked output, a directory a `!` rule takes back);
anything git cannot answer keeps the key late. Undeclared writes, an
`outputs.workspaceFiles` producer upstream, a rewriter the key does not
fold, and runtime probes after a writer still leave a key preliminary.
With a
remote declared the short-circuit probes the local store alone, so a
local hit still restores ahead of its dependencies and no remote GET
sits on the critical path (remote prefetch asks the remote for the
rest). It never fires with local reads off or on a local cache
that holds no artifact (`Cache.holdsNothing`: every probe would miss,
and a cold 1,090-package run started its first task ~90 ms sooner
without it), and never throws —
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
   bounded pool (`cache.concurrency.download`). The prefetch ingests a hit
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
   1000-project run). Now every glob names the directory its matches
   live under (`outputDirPrefixes`): `<dir>/**` and a bare literal `<dir>`
   are that tree (a literal that names a file is recorded as a file,
   `mtime_ms` -2, and holds while a regular file stands there, its bytes
   being the per-file check's), any other glob the tree under its static
   prefix (`dist/*.js` is `dist`), and a root-anchored one (Turbo's
   `**/dist/**`) the whole project. The cache records every directory
   under each with its mtime after each save and restore; on the next
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
   records nothing unless the files the globs take there are the entry's
   rows (item 1087), so a source file beside the outputs is no stray. A
   glob that leaves the project, a missing row set (a remote ingest
   records none), a moved directory, or more than 8,192 directories
   (`OUTPUT_DIRS_CAP`, recorded as one never-current row, `mtime_ms` -3,
   so the hit does not snapshot it again) keeps the walk — and a walk that
   proves the tree current records the directories so the following hit
   can skip it.
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
- **Stable keys only.** A task with a _preliminary_ key (§ Local
  restore tier's stability gate: undeclared writes, an
  `outputs.workspaceFiles` producer upstream, or input globs that match
  the outputs of a dependency the key does not fold) is not prefetched: its key would name the wrong
  artifact, and it resolves via the lazy read-through in `execute-task`. Instability propagates: a task that folds an
  unstable upstream is itself unstable. When in doubt, skip.
- **A lookup waits on no probe.** A task that asks for its key while
  the batch probe is out GETs it at once: waiting made a remote hit two
  round-trips (`layered-cache.test.ts` › "a get() while the batch probe
  is out GETs at once…").
- **The first pool of keys, pulled at once.** The first
  `cache.concurrency.download` stable keys in graph order are pulled as
  the batch probe is sent, not after it answers: on CI the probe took
  ~490 ms and a GET ~250 ms, so a hit's dependant waited on a GET of its
  own. A local run against a fake remote at those delays went from
  ~810 ms to ~330 ms. At most that many GETs can 404
  (`remote-prefetch.test.ts` › "pulls the first pool of keys…").
- **Kept hits, trusted at once.** What a `hasMany` says a remote holds
  is kept in the index's `remote_hits` table (shared by every worktree),
  so a later process trusts it: `vx run --dry`
  followed by `vx run` probes once in each, and the run GETs the kept
  hits before its own probe answers. Only hits are kept. A plain run
  waits on the remote for nothing; an executor that plans its machines
  (`demand`, vx-dte) plans after the batch probe answers, since a key
  with no row may still be held (2026-10-23: "We wait for remote
  before we plan. We need data to plan. We don't wait for remote without
  dte"; `remote-prefetch.test.ts` › "a kept hit is pulled before the
  probe answers…"). When a remote's batch gives no answer (Vercel's on
  main f71b377: every task then counted as left to run, and 11 of 15
  workers asked were cancelled), such a run asks that remote `has` for
  each key instead (`remoteHasEach`, `concurrency` at a time); a failed
  one leaves the run with no answer, as before. Each run still asks `hasMany` for every key the local
  store lacks, in the background, and its whole answer rewrites the
  rows it asked: new hits are added, gone ones dropped. A GET every
  remote answers with nothing drops the row too, and the task runs
  (`orchestrator-remote.test.ts` › "plan then run…", "a kept hit the
  server dropped…").
- **At most once.** The `LayeredCache` keeps an in-flight map keyed by
  hash; `prefetch` and `get` share it, and a settled `false` (remote
  miss) prevents a second lazy probe of the same dead key.
- **Provenance preserved.** A hash pulled from remote — even when a
  later `get` finds it as a now-local hit — still reports
  `source: 'remote'`, so the outcome is `cache-hit-remote`.
- **A remote-read-off policy** (`--no-cache`, `--force`, or
  `--cache-policy=remote:`) fires no prefetch. With remote writes on
  (`--force`), the same up-front keys go to one `hasMany` per remote
  the run writes but does not read and that can batch, in the
  background: no task waits for it, only each upload does. An upload
  of a key that remote holds is skipped (an entry is immutable) and is
  counted nowhere. A key the probe did not cover, or a remote with no
  `hasMany`, asks `has` for that key inside its upload job; a probe
  that fails uploads, as before.
- **No `has` before a `put`.** An entry is immutable: a remote's `put`
  of a key it holds keeps the stored bytes, and a wire that would
  overwrite checks inside (`turboCache()` asks HEAD unless a 404 or a
  batch answer this run said the key is absent; `reapi()` looks the
  action up beside its upload and keeps a stored result; Nx servers
  answer 409). `ctx.cache.put` and a run's own entries send the `put`
  alone.
- **`--dry` batches too.** The plan derives every key first, then asks
  each remote with `hasMany` once, and keeps the hits for the run that
  follows; a remote without it is asked `has` per key.
- **Never fail.** Every remote path (get / put / ingest / prefetch)
  catches all errors and degrades to a cache miss. A remote 500, a
  network drop, a corrupt artifact, or a failed integrity check can
  never fail a run. A key whose remote bytes do not read back is
  uploaded again after the task re-runs, held or not, so a remote that
  replaces on `put` heals.
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
failures are warned once per failure class and are otherwise ignored (the task
already succeeded; the only loss is the remote entry).

An upload is the outputs as the task wrote them; secret masking does
not reach file contents, so a task whose outputs embed a secret is one
to leave uncached ([security](./security.md)).

### Planning probes (`--dry`)

The planning path (`vx run --dry`) predicts hits without
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
local `Cache` gets a `{ read, write }` slice gating its task artifact
get/save and the file-hash memo's writes (never `recordRun` / `stats` / `prune` / ingest
/ key derivation); the `LayeredCache` additionally gates its own remote
read-through (`remoteRead`), upload (`remoteWrite`), and prefetch
(`remoteRead`). The orchestrator derives two booleans per task:

- `willRead = task has a cache block AND it is not remote-only AND it folds no keyless task AND (localRead || remoteRead)`
- `willWrite = task has a cache block AND it is not remote-only AND (localWrite || remoteWrite)`

A task reads the cache only when `willRead`, saves only when
`willWrite` and it folds no keyless task, and cleans its declared outputs
before exec only when `willWrite`. A keyless task runs a command and
declares no `inputs`: its key is unknown, so a task that folds it
(through `dependsOn`, directly or through a group) always misses. Remote-only is an `exec.remote: 'only'` task placed on a
remote executor: it never touches this machine's disk (no probe, no
restore, no output clean, no local save), and its result lives in the
remote executor's own store.

The CLI maps three flags to a policy (precedence: start all-on → apply
`--cache-policy` → `--no-cache` forces all off → `--force` forces both reads
off): `--no-cache` = everything off (no read, no write, no output
clean); `--force` = reads off / writes on (re-execute, outputs cleaned;
a key already stored, locally or in a remote, is kept as it is); `--cache-policy=<spec>` = explicit per-layer control.
Off CI, unless a spec names the remote, `remoteWrite` starts off: a key
holds only declared inputs, so a laptop's undeclared tool or file could
replay on CI. See `docs/cli.md` § Cache control.

The setup we recommend for a shared remote: the write token only in the
default branch's CI (a protected environment), a read-only token on
laptops and in pull request jobs, and the branch's cache scope
(`github()` names it, a laptop derives it) so a PR's own writes, when its
token allows them, land apart. The token
is the boundary; the policy and the scope are the client's half
(`docs/security.md` § Cache poisoning).

One subtlety: when `localWrite` is off but `remoteWrite` is on
(`--cache-policy=local:,remote:rw`), there's no on-disk artifact for the
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
   single `<hash>.tar.zst` and validated. One of at most 32 KiB
   compressed (`INLINE_MAX`, almost every artifact: a one-file `dist/`
   is a few hundred bytes) stays in memory; a larger one is written to a
   temp name.
4. One `BEGIN IMMEDIATE` SQLite transaction upserts a small artifact's
   bytes into `artifacts` (v33), or renames a large one into place and
   deletes the key's inline bytes, and upserts the `entries` row (taskId, command, exit code,
   duration, size, stdout, timestamps), the `output_files` fingerprint
   rows, and the entry's one `entry_inputs` row (`INSERT OR IGNORE`).
   Concurrent readers see either no entry or a complete entry — never a
   partial one — and bytes and rows go live together: the rename waits
   for the write lock, so no other writer's rows land beside it, and a
   commit that fails takes the artifact back out (the key then misses).
   Until 2026-09-27 (A-3) the rename came first, and a commit refused
   past the busy timeout left the new bytes beside the old rows: every
   later hit on the key failed the task as a corrupt artifact.
   A `--force` save of a key the index already holds is skipped, so
   `--force` rewrites nothing. A re-save (a key dropped as corrupt, or
   two writers that both found it absent) first moves the previous
   artifact aside under
   a temp name and unlinks it after the commit: ext4 flushes the
   incoming file when a rename replaces one, 0.55 ms a save on the main
   thread against 0.04 (a forced 1,000-task run 4.01 s → 3.46 s,
   2026-10-02). A reader probing between the two renames misses.
   An inline save moves aside whatever file its key has, the same way
   (a rename that finds nothing on a first save, in place of a statement
   asking the index). As of every commit a key's bytes are in one place,
   and a reader takes the inline bytes first, so a file an older vx
   wrote beside them is never read and the sweep takes it. An inline save writes no file at all: no temp, no rename,
   and a crash leaves nothing behind (the bytes and the rows are one
   transaction in one database file).

**The key is re-checked before the save** (item 743). It was taken
before the command ran — at the task's start, or up front by the local
short-circuit — and the save files the outputs under it, so the inputs
must still be what it describes. Two checks, in order. The key
re-derived just before the command (`describeTaskInputs`, which the
executor seam needs anyway) must equal it. Then each input file is
`lstat`ed once: a file whose ctime falls
after, or within `FILE_HASH_RACY_MS` before, the moment its digest was
learned — the enumeration's start for an index OID, the describe for a
hashed file — is hashed again and compared, and a file that is gone has
moved. A file written at or after the describe (just before the command)
has moved whatever it holds (a whole-second stamp counts as any moment
of its second, an even one of two, in both checks): an input changed and changed BACK while the
command ran matched its digest again, and its output, built from the
edit, was filed under the key and restored over the original (item
1015). A symlinked input is also followed again: the key folds the
content behind it, which an edit changes without touching the link, and
a different digest there has moved. When one moved, the task's result stands but no entry is saved,
one status line names the file (``[vx] app#format: `packages/app/a.ts`
changed after its key was taken — …``), and the run forgets what it
knew about the project, as after an uncached task (§ Cache key
derivation, step 11). This covers a formatter rewriting its own input
(turborepo#10111) and a user's edit mid-run (turborepo#1146). A task
left remote (`--cache-download=none`) is held to the same checks: a moved
key still lets a local consumer fetch its outputs, but the fetch saves
no entry; until X-123 it saved them under the old key. A task
that rewrites its own input to the SAME bytes (`sed -i` always writes)
is not saved either: its write cannot be told from an edit reverted
mid-run, so it pays a re-run each time rather than risk a stale entry;
declare what it writes as an output, which the status line says when it
names a file other than `package.json` (TanStack Router's committed
`routeTree.gen.ts`, rewritten by every build). That holds on CI too: a
task of the same project running alongside can change an input and put
it back. A task that rewrites its own input to identical bytes (tsdown's
`package.json`) sets `cache.inputStability: { strategy: 'mutable' }`, and a write
during its command is then judged by its bytes, as an earlier write is;
different bytes still withhold the entry, and so does a write made while
another command that may write the file ran (`command-windows.ts`: one
in the same project, or one with a write grant elsewhere in the
workspace), named on the line as `while <task> ran`. `VX_CACHE_INPUT_STABILITY_STRATEGY=mutable`
makes that the default (2026-10-12); `'unchecked'` skips the
check, and `severity: 'error'` fails the task instead of warning
(`docs/schema.md`). A file ADDED under an
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
A claimed root file a task rewrote since the run read it (§ Cache key
derivation, step 9) withholds the save the same way, and no key
taken before it is probed or restored: a hit the up-front probe found
goes back to the scheduler and runs once its deps are done. Until X-124
that hit restored the old install's bytes.

A miss that ran here and saves **nothing** — it failed, the cache
policy writes nothing (`--cache-policy=local:r,remote:r`), an upstream failed
under `--continue` — runs the same input re-check and, when an input
moved, forgets the project as above; otherwise its declared outputs are
resolved and marked in the git snapshot exactly as a save marks them.
Before item 750 only a save marked them, so a same-run reader keyed
from the snapshot's index OID for an output (or for an input the task
rewrote) restored the bytes from before the command.

A declared set that resolves to **nothing** is said on the run's
status line. `inputs matched no files (lib/**)` — the key would
not change when the source does — is said on every miss of a cacheable
task, right after `describeTaskInputs` and before the command, whether
or not it saves. `cache.outputs matched no files (build/**)` — an empty
artifact was saved and a later hit restores nothing — is said on the
save path. Both are almost always a glob
against the wrong directory; the output line names one other cause when
it applies: a sandboxed task with no `exec.sandbox.allow.write`, whose
writes never reached disk, or a `workspaceFiles` directory that is a
symlink out of the workspace, whose files vx drops as outside (a project
output directory linked out of the project refuses the task instead, X-88). `outputs.files: []` is a deliberate cached
no-op and says nothing; a task with no `cache` block is never checked.

**The outputs are what exists when the task's command exits.** The run
waits for the command's own process, not for everything it started — a
backgrounded grandchild that still holds the output pipe does not hold
the run (`tests/runner.test.ts`) — and the save resolves the output
globs at once. A descendant the command detached (`setsid … &`, a
daemon) that writes after that is not in the artifact: the entry saves
what was there, often nothing (with the `cache.outputs matched no
files` line), and the next hit's restore removes what the
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
- **After restore on a cache hit.** The post-restore tree is the
  cached snapshot byte-for-byte: the restore renames the entry's files
  over the ones it finds, then removes what the entry does not hold.
  Hand-edits to output files don't persist through a cache replay. When
  the hit's own check walked the output globs to find the tree stale,
  the removal uses that walk's list instead of walking again (X-161).

Both use the same helpers (`cleanOutputs`, `cleanOutputPaths` in
`src/cache/inputs.ts`) with the same boundary rules, and vx's own paths stay off the wipe
whatever the glob: the project root's `.git`, `.vx` and `vx.lock.json`, and
for `outputs.workspaceFiles` every project's `vx.lock.json` (`OUTPUT_NEVER`;
a build's own `dist/.git` or `dist/sub/vx.lock.json` is an output like any other;
`.vx` holds the workspace config and the lock, which a clean deleted and a
hit restored stale while `.vx/cache` alone was listed). `node_modules` is
off it too unless a glob names it (`node_modules/**`, an install task's
legitimate output); until 2026-09-27 (A-13) `**/*.js` cleaned every
installed `.js`, and a `workspaceFiles` output glob reached even `.git`.
No clean deletes a file git tracks (2026-10-14). Under an output
glob it is still an output: the task may rewrite it (TanStack Router's
committed `routeTree.gen.ts`), the artifact saves the bytes the run left,
and a restore writes them. It is also in the task's key, even under its
own output glob and when no `inputs.files` glob reaches it (`dist/LICENSE`
under `dist/**` with inputs `src/**`; until 2026-10-28 that one was left
out, and a hit wrote the old bytes over a committed edit, as
turborepo#14831 fixed in Turbo), so an edit moves the key and the saved
bytes follow from it; the task's rewrite is no input that moved mid-run.
A committed file under `outputs.workspaceFiles` is keyed only where
`inputs.workspaceFiles` reaches it. Until then the
clean deleted a committed file under an output, and a reader with no edge
to its producer failed naming only the file (A-48, vueuse's
`metadata/index.json`). Untracked files under the glob are cleaned as
before. Paths compare as
git compares them: case-folded under `core.ignorecase` (macOS), and a
file inside a submodule counts as committed.
Workspace outputs take the same rules, and a path an output `!` entry
takes back (A-44) is off the wipe, the artifact and the restore alike.
Skipped when:

- `cache.outputs.files` is empty (nothing declared as output).
- The task's `willWrite` is false — no write axis is enabled (e.g.
  `--no-cache`, or a read-only `--cache-policy=local:r`). The user is debugging
  and managing the tree, so vx leaves it alone. `--force` keeps writes
  on, so it DOES clean (the saved snapshot must be clean).
- `cache.outputs.clean` is `false` (on the task, else the workspace's
  `cache.outputs.clean`): the command sees last run's outputs (tsc's
  `.tsbuildinfo`). You opt out of the clean-tree guarantee: the save
  stores every file the outputs match after the run, so a leftover from
  an older build is cached and restored everywhere. A retry cleans as
  usual; a hit's restore still removes what its entry does not hold.

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
build: any path both could write counts, so `build/{a,b}.js` meets
`build/*.js`, and `out/**` meets a glob for each `.d.ts` one level down
at `out/types/x.d.ts`. By default that holds even when one depends on the other: the
workspace rule `rules.exclusiveOutputs` (on unless set to `false` in
`.vx/workspace.ts`, X-53) keeps one path to one task, and its refusal says
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
  before a restore (its rows only, pruning emptied directories only
  inside its declared trees, so a sibling's fresh directory stays);
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

| Trigger                                                                                                                                  | Mechanism                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edit a file in the task's `inputs.files` set                                                                                             | step 11 of key derivation                                                                                                                                                                               |
| Edit a file in the task's `inputs.workspaceFiles` set (root-anchored; may live in ANY project's dir — the documented boundary exception) | step 11 — resolved workspace files join the same input-file list                                                                                                                                        |
| Any package manager updates a lockfile (`pnpm`, `npm`, `yarn`, `bun`)                                                                    | step 9 — the `key` material of the plugin that claims it (`@vzn/vx-lockfile`: only the projects whose dependency closure moved); **NOT a trigger** with no such plugin, since core keys no package file |
| Edit an install setting (`.npmrc`, `bunfig.toml`, `pnpm-workspace.yaml`, `.yarnrc.yml`, `.yarnrc`)                                       | step 9 — the claiming lockfile plugin folds it whole into every task; **NOT a trigger** without one                                                                                                     |
| Edit `package.json`'s `workspaces` field                                                                                                 | membership: a project that joins or leaves changes which projects exist and which nested dirs its parent's globs exclude (step 11)                                                                      |
| Edit the project's `package.json` (dep / version / scripts change)                                                                       | step 11 — an input file of every cached task when `@vzn/vx-lockfile` is declared (it adds `package.json` to `inputs.files`), or when a task lists it; **NOT a trigger** otherwise                       |
| Edit the task's `vx.config.ts`                                                                                                           | step 3 (task config hash)                                                                                                                                                                               |
| Edit a config file that the task config imports                                                                                          | step 3 (configHash sees the resolved object after Bun evaluates imports)                                                                                                                                |
| Change CLI `forwardArgs` (after `--`)                                                                                                    | step 4                                                                                                                                                                                                  |
| Change a `inputs.env` host value                                                                                                         | step 5                                                                                                                                                                                                  |
| Change the combined stdout+stderr of a `inputs.runtime` command (resolved at hash time)                                                  | step 6                                                                                                                                                                                                  |
| Change the combined stdout+stderr of a `inputs.workspaceRuntime` command (resolved at hash time)                                         | step 7                                                                                                                                                                                                  |
| Upstream task's cache key changes (because its inputs changed)                                                                           | step 8                                                                                                                                                                                                  |
| Bump `CACHE_VERSION`                                                                                                                     | step 1 — orphans every entry                                                                                                                                                                            |
| Change `exec.env.passThrough` _values_ alone                                                                                             | **NOT a trigger** by design — passThrough values are host-specific                                                                                                                                      |
| Change a file not in `inputs.files` / `inputs.workspaceFiles`                                                                            | **NOT a trigger** by design — declare it explicitly                                                                                                                                                     |
| Edit `.vx/projects.lock.json`                                                                                                            | **NOT a trigger** — globally excluded from inputs (v24); it's vx's own metadata, never a task input                                                                                                     |
| Change a file in a nested project's dir                                                                                                  | **NOT a trigger** for the parent's `files` globs — project boundaries are hard (workspaceFiles is the explicit exception)                                                                               |

The cascade in step 8 is what makes monorepo caching work: edit a
file in `lib/`, and every package that depends on `lib`'s `build` task
re-runs automatically.

## Cross-project boundaries

A project's `inputs.files` globs **never** reach into another
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
globs is `dependsOn` + upstream-hash propagation (step 8).

For a task with `exec.sandbox` and `cache`, the sandbox enforces that
"only". A workspace package reached through a `node_modules` link is
granted only when the task's key folds a task of that package, walking
the same selection `inputs.tasks` applies at hash time
(`orchestrator/keyed-projects.ts`, over `graph/folds.ts`'s
`selectFoldedDeps`); every other link target inside the root is
withheld, so an import of a sibling the key never sees fails and is
reported instead of caching a result an edit there would not re-run.
Any exec task counts, cached or not: its key folds its project's files
through its `inputs`, and one with no `inputs` is keyless, so a key that
folds it is never stored or read. A persistent task counts the same way,
so a cached e2e behind a dev server keyed on its sources re-runs when
they change.
The coverage is per package, not per file: an edge to `ui#source`
(inputs `src/**`) also admits a read of `ui/README.md`, whose edit moves
no key — the same limit a grant wider than a task's own inputs already
has. A task with no `cache` keeps every link, having no key to be stale.

**Exception:** `inputs.workspaceFiles` /
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

`inputs.runtime` / `inputs.workspaceRuntime` are modeled
exactly on `inputs.env`, and they share its asymmetry with the
lockfile:

- **The command _strings_ live in the resolved config**, so `vx lock`
  freezes them into `.vx/projects.lock.json` (just as it freezes the env _names_
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

So a run loads the frozen command strings from the lock but still
spawns them and folds their current output into the key. A `node -v`
that goes from `v20` to `v22` after the lock was written busts the
cache, exactly as a changed `NODE_ENV` value would — the TypeScript
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
land by rename; a transaction that reads before it writes takes the
lock at BEGIN, since SQLite answers its later write `database is locked`
at once: a run's history was lost so in 13 of 48 runs on one shared
cache dir, X-105); a task's OUTPUT TREE was not — both runs cleaned and
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
`vx cache clean` in another shell, or one run for another
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
output, a name that now reads unsafe, X-115) is a miss the same way: `[vx] <id>: cache: corrupt artifact
for <hash>: …; dropped it — running it`. The entry is dropped, so the
task's save stores the key again; it failed the task as an internal
error on every run until `--force` before A-52. A cache the run may
only read keeps the entry (`…; left it (this cache is read-only)`).

## Storage layout

A directory this user cannot write into (another user's `.vx/cache`,
a cache baked read-only into a CI image) serves its hits: the run says
`[vx] cache directory <path> is not writable (EACCES: …) — serving hits
from it; this run saves nothing and records no history` once, before
any task, then restores what it holds and runs the rest without saving
it. An empty one has nothing to serve and fails the run before any task:
`cache directory <path> is not writable (EACCES: …)`, with
`--cache-dir <path>` as the way out. `vx cache clean` is refused the
same way (its `--dry-run` only reads, and reads). The readers (`vx show`, `why`,
`last`, `info`) open such a directory read-only and go on.
Where the directory cannot be created at all (a read-only checkout with
no cache yet) a run says `cannot create cache directory <path>
(EACCES: …)`, naming the workspace `cache.dir` field and `--cache-dir`;
the readers and `vx cache clean` find no cache and go on.
A full disk is the same kind of failure and is reported the same way,
never as a corrupt artifact and never as a stack: a save that runs out
of room is `[vx] cache save failed: ENOSPC …` (the task's work ran, the
footer counts it not saved rather than `↑`, and the next run misses), a restore that does is the task's failure line
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
take it out of inputs.files.` (A-50).

By default the entries and their artifacts live in a **shared store**
in `~/.vx/<id>/cache`, and each workspace keeps only its own index in
its `.vx/cache`: every checkout of the repository hits what another
saved (a second clone, a worktree), and none reads another's history.
Task timings are shared too: `task_durations`, what a duration forecast
reads, so a new worktree has one on its first run. So are plugins' own
entries (`plugin_blobs`, a plugin's `ctx.cache`).
The id is Nx 23's: 16 hex of a sha256 of the remote (`origin`, then
`upstream`, `base`, the first; `host/owner/repo` in lower case, so ssh
and https agree) and the workspace's path in the repository; with no
remote, the first commit. A repository with neither (no commit yet, a
shallow clone with no remote) shares nothing. Each level of `~/.vx` is
owner-only; vx closes one of yours that others can read (chmod 700), and one others can write, or owned by another user, is not used. Design: [`design/shared-store-2026-10.md`](./design/shared-store-2026-10.md).

```
~/.vx/<id>/cache/                           the shared store
├── store.db                                entries, entry_stdout, output_files,
│                                           entry_inputs, task_durations,
│                                           plugin_blobs, remote_hits, store_meta; artifacts
│                                           up to `cache.store.embeddings` (v33)
└── <hash>.tree/                            the larger artifacts, as plain files (below)

<workspaceRoot>/.vx/cache/                  this workspace's own index
└── cache.db                                run history, memos, output stamps;
                                            attaches store.db as `store`
```

The store's directory carries no version: every key is seeded with
`CACHE_VERSION`, which moves when hashing or the artifact layout does, so
two vx versions never read each other's artifacts. `store.db` is the
artifacts' inventory and records its schema (`store_meta.schema`): a vx
of another `SCHEMA_VERSION` drops its tables, prints nothing (the
cache is vx's to keep), and keeps every artifact, each indexed again
when its task next hits. The check, drop, re-create and stamp are one
write transaction, so another version's open waits rather than landing
between them. A home this user cannot write keeps the store
in `<workspaceRoot>/.vx/cache/` instead, silently. Name a
cache directory (`cache.dir` in .vx/workspace.ts, `--cache-dir`, or
`VX_CACHE_DIR`, in that order of precedence, relative to the workspace
root) and it holds everything, shared with no other workspace:

```
<cacheDir>/                                 (default .vx/cache when one is named)
├── .gitignore                              `*` — written when the dir is created, or into an
│                                           existing dir that lacks one, so the cache is
│                                           never committed and never enumerated as an
│                                           input (a user's own file is left alone)
├── cache.db                                SQLite metadata + run history, and the
│                                           artifacts of at most 32 KiB compressed,
│                                           the same bytes as a file below (v33)
├── cache.db-wal                            write-ahead log
├── cache.db-shm                            shared memory
├── failures/<runId>.json                   a failed run's task output and the files it
│                                           names (`vx last --format json`, getFailures);
│                                           the newest 50 kept
└── <hash>.tree/                             one artifact per cache entry, the larger ones (v47):
    ├── outputs/<rel>                       declared output files, project-relative (when any),
    │                                       each with its saved mode and mtime
    ├── workspace-outputs/<rel>             declared outputs.workspaceFiles,
    │                                       WORKSPACE-ROOT-relative (when any)
    ├── .vx-meta.json                       per-output [mode, mtimeMs], the key it was
    │                                       packed under (v35), the miss's CPU and RSS,
    │                                       the empty output directories (v44),
    │                                       the output symlinks (v45)
    └── .vx-sum                             CRC-32 of the archive this tree packs to (v36)
```

The stdout of a tree entry is its `entry_stdout` row. With
`cache.store.decompress: false` an artifact is instead one `<hash>.tar.zst`
holding `stdout`, `outputs/`, `workspace-outputs/`, `.vx-meta.json` and
`.vx-sum`: the bytes a remote stores. The tree form is that archive
unpacked once at save (or at ingest of a remote hit, decoded once straight
into the tree), so a restore copies
each file out (`copy_file_range`, a clone on a filesystem that has one;
never a hard link: a later write to a restored output must not reach the
store). A restore into outputs already on disk, a workspace output or a
symlink takes the archive extractor, fed the tree packed back into its
tar. An upload packs the tree into the tar.zst in the upload queue, off
the save. A hit trusts the tree and checks none of its files: the store
is vx's own, and a check could not stop a write to it. A tree no row names
is an orphan the sweep reaps; only the archive form is adopted back
after a `SCHEMA_VERSION` reset, as a tree's stdout lives in its row.

`failures/` sits outside `cache.db` so the index layout, and every
shared store under it, stays as it was. Each file is
`{ runId, tasks: [{ taskId, project, task, exitCode, timedOut?, output, locations }] }`,
written at run end (temp file + rename) only when a task failed with
output; `output` is plain text (ANSI stripped, secrets masked, the first
8 KiB and last 56 KiB). A refused write (`EACCES`, `ENOSPC`) costs only
that output, never the run's verdict.

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
every regular entry is written to the workspace's `.vx/tmp/<pid>-0/`
(vx's own, ignored by git, never an output folder), inside a copy of
the topmost missing folder on its way when one is missing, and renamed
over its target (that copy renamed in whole) only after the whole archive has ended cleanly and
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
`.vx-meta.json` — `{ version, key, files: { <entry>: [mode, mtimeMs] }, dirs?, exec? }` —
into the archive. Restore applies both, the mode minus the process
umask as tar gives a non-root user (under `umask 077` a 0644 output comes
back 0600; until 2026-10-16 it came back 0644, readable by every user,
`tests/restore-umask.test.ts`), and a tree a restore left that way still
reads as current. Both apply at their edges too: a mode of
000, an mtime of 0 (`SOURCE_DATE_EPOCH=0`), one before 1970, whose
tar header carries 0 since ustar's field holds no sign, and one past
March 2242, whose header carries the field's 11-digit maximum (X-114:
the save failed `value … does not fit a 12-byte field`). Until 2026-09-27
(A-4) the first two were skipped, so the file came back 0644 and
stamped now and every later hit restored it again, and the third wrote
a header the reader refused, so its task never saved. `exec` (`{ cpuMs?, peakRssBytes? }`,
2026-09-12) is what the PRODUCING execution used: it rides the artifact
so a machine that never ran the task — a fresh runner on a remote hit —
still learns what the task needs (`@vzn/vx-history` packs on
it), every wire ships the bytes verbatim, and an artifact without it
reads as before. The ingest side takes the numbers only as plain
non-negative numbers; anything else in a foreign sidecar is dropped.
`dirs` (v44) names the empty directories the output globs matched at
save (`outputs/dist/empty`): a tar of regular files cannot hold them, and
a hit makes each one, so the tree a hit leaves is the one the miss left.
Each name is held to a file entry's rules and to the declared outputs,
and is reached only through directories that stay in the project. Its
index row is the path with a trailing slash (`dist/empty/`); the
skip-restore check asks only that a directory stands there, and a stale
file found in it goes while the directory stays. `links` (v45) maps each
symlink under the outputs to its target as written (`outputs/dist/latest`
→ `v2.txt`). A hit makes the link apart from its place and renames it
over the target like a file, and only if the target is relative and
stays inside the workspace; any other fails the whole restore. Its index
row carries the link type in its mode and the target's length and CRC-32
where a file has its size and mtime, so the skip-restore check compares
the target and never follows the link. Tar entries that are not regular
files (symlinks, hardlinks, devices) are never materialised — the
reader reports them only to be skipped — so a
poisoned artifact cannot smuggle one onto disk. Nor can it name a file
the task did not declare: a remote artifact is ingested only when every
file it carries matches the task's `cache.outputs` (the lookup passes
them, `CacheGetContext.outputs`), and never when it holds one path as a
file and a directory at once. Either used to reach the tree, an input
overwritten or a `.git/hooks` file planted under a green
`cache-hit-remote`, or a restore that failed every later run from the
local copy (item 942); now the read is a miss and the task runs. Every
restore asks the same of the local copy, whatever route it reached the
store by: an entry outside the declared outputs, one a `!` entry takes
back, one under the project root's `.git` or `.vx` or its `vx.lock.json`, or one under a
`node_modules` no output glob names fails the whole restore before
anything is written; the entry is dropped and the task runs. Remote
execution (`@vzn/vx-reapi`) writes a remote action's outputs through the
same gate (`restorableOutput`). On the save side a
**symlinked output** is stored as the link, as Turbo and Nx keep it: a
link to a file, to a directory or to nothing comes back as that link,
and no byte of its target is read, so a link a sandboxed task planted to
a file it could not read packs nothing of it (L-23). An absolute link, or
one leading out of the workspace, fails the save by name, as the config
spells the path (`workspaceFiles output gen/latest`). The clean before exec and restore removes every
file AND symlink the output globs cover (a link is unlinked, never
followed). An output directory that is a symlink (`dist -> real-out`) is
followed by the clean as by the save and restore, so its target is the
output and an entry holds only what its run wrote (X-88); one that
resolves outside the project refuses the task, naming the link, and
nothing is deleted through it (X-5). The clean prunes the directories it emptied (before a miss it keeps
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
puts a real directory there), or stop declaring outputs under it.`
The check runs before each rename and again once all have landed: a
directory swapped for such a link while the renames ran (another
process, a concurrent restore) fails the restore the same way, and the
entries that landed through it are removed from where they went. A
link that stays inside the project is written through, and so is one
whose target is gone: the restore creates the directory it names —
following a chain of links to its end — and writes through it, the
link kept. Whether a link stays inside is decided on where it resolves,
so a dangling link to `../elsewhere` or to an absolute path out of the
project is the same refusal, nothing created outside, and a cycle of
links is refused by name. Nor is a link written through into Git's
metadata: a path that resolves into a `.git` directory under the
project (or the workspace, for `outputs.workspaceFiles`), in any case,
is refused naming the link (`dist/g -> ../.git` carried
`dist/g/hooks/pre-commit` into `.git/hooks`), and an artifact's own link
into `.git` fails its restore (vercel/turborepo#14808). (A link the output globs themselves cover,
`dist/sub` under `dist/**`, is an output: the clean unlinks it.) Entry NAMES are
validated by vx before anything decides where to write, and a bad
entry anywhere, even the last, rejects the WHOLE archive: the temps
are unlinked and the empty directories the extraction created are
pruned (`tests/archive-security.test.ts`). A backslash in a name is a
name character (vx runs on Linux and macOS; Windows through WSL), so an
output like `dist/back\slash` caches and restores as written.

**Key properties:** one entry is one artifact — a row of `artifacts`
when small, else one file, so eviction is one delete in the rows'
transaction or a single unlink; no per-entry manifest, no separate
`logs/` tree; and local + remote layers transport the exact same
tar.zst bytes end-to-end, wherever the local copy lives.
The artifact is the record and the index its inventory
(2026-10-06): a lookup reads the row first, and a key with no row whose
`<hash>.tar.zst` is on disk (a `SCHEMA_VERSION` drop, a deleted
`cache.db` or `store.db`) has the artifact indexed again from its own
bytes, checked as a remote's are (its recorded key, its names against
the task's declared outputs), and hits; one that fails the check is a
miss, and the save that follows replaces it. An inline artifact with no
row is indexed the same way, from its bytes, in one transaction; a reset
keeps the `artifacts` table, but deleting `store.db` or `cache.db` by
hand takes the inline artifacts with it. A `.tmp-*` a crashed save
left is never a hit. `vx cache clean` sweeps row-less files. A
row-less artifact may be in use: two vx versions share one store, and
each open drops the other's rows. So the policy judges it as it judges a
row, its file time standing for `accessed_at`: past `olderThan` it goes,
and under `maxSize` it counts, oldest use first with the rows. A hit
renews a file time over an hour old, so the last use is read as the file
time plus an hour. An inline artifact with no row is judged the same
way, its `at` standing for the file time, and `vx info` counts it with
the files. A temp a crashed save left goes once it is an hour
old, and so does a file an inline artifact of its key shadows; nothing
younger than an hour is taken. Re-indexing touches the
artifact's mtime before it links its temp, so the sweep sees that one
fresh too.

A row's `accessed_at` is renewed the same way: a hit renews it only once
it is over an hour old (2026-10-08). Renewing every hit rewrote
2,180 rows at a warm 1,090-package run's close, ~30 ms. So the policy
reads a row's last use as `accessed_at` plus an hour too: an entry used
within `olderThan` is never pruned, and one may stay up to an hour past
it (`tests/cache.test.ts` › "an entry used within the age limit is never
pruned").
Captured stdout is stored twice on purpose: in the artifact (so it
survives the remote round-trip) and in the `entries` row (so a local
hit replays it with pure SQL, never decompressing the artifact).

### SQLite tables

`schema_meta.version` is the gate: an index written by any other
`SCHEMA_VERSION`, earlier or newer, is reset by the first run that opens
it (pre-alpha: no migrations; the index is an inventory,
2026-10-06): every table but `schema_meta` is dropped and recreated,
so each comes back in its current shape (A-54: `output_dirs` kept an
earlier vx's columns). The check, drop, re-create
and stamp are one write transaction, so another version's open waits
rather than landing between them; an index already current is opened
without the lock.
A reading verb (`vx why`, `vx last`, `vx info`) leaves it untouched and
says why (item 896; `vx cache clean --dry-run` previews the reset
instead, item 1083).
That open prints nothing (2026-10-06: the cache is vx's to
keep). The artifacts stay: each is indexed again from its own bytes
when its task next asks for its key (below).

```sql
-- src/cache/schema.ts (SCHEMA_VERSION = 'v49', in cache.ts)
-- With a shared store, entries, entry_stdout, output_files, entry_inputs,
-- store_meta, task_durations, task_outcomes, blob_sizes, plugin_blobs and remote_hits live in its store.db, attached as `store`; the rest is
-- the workspace's cache.db. A named cache dir holds all of them.

CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,  -- 'version', 'cache_version', 'store_dir'
  value TEXT NOT NULL
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
  accessed_at  INTEGER NOT NULL,  -- ms-epoch; a hit renews it once over an hour old (LRU)
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
  blocked_by          TEXT,             -- a skip's root blocker, or what a task ran behind (a task id)
  timed_out           INTEGER,          -- 1 when vx's own timeout killed it
  sandbox_violations  INTEGER,          -- the sandbox's violation count
  not_ready           TEXT,             -- 'timeout' | 'exited' | 'spawn' (persistent task)
  restored            INTEGER,          -- v31, on a hit: 1 = outputs restored, 0 = up to date
  remote_error        TEXT,             -- v40: each remote read or write of the key that failed
  peak_cores          REAL,             -- v43: most cores one 1 s sampling interval burned
  avg_rss_bytes       INTEGER,          -- v43: mean resident memory over the samples
  placement           TEXT,             -- v44: where an executor ran it; NULL = here
  placement_cores     INTEGER,          -- v44: that machine's cores
  placement_memory    INTEGER,          -- v44: that machine's memory, bytes
  keyless_by          TEXT,             -- v46: the task with no inputs its key folded
  def                 TEXT,             -- v48: the task's definition (command, env.define)
  cpu_share           REAL              -- v49: the share of a core its threads got there; NULL = 1
);

-- Two indexes, both append-only under a run's inserts: every row of a run
-- carries the same run_id and a started_at newer than everything before it.
-- There is deliberately NO (project, task) index — it scattered every run's
-- rows over one B-tree leaf per pair (a 1,000-hit warm run's record stage
-- went 57–79 ms → 14–19 ms without it) while its readers gained nothing;
-- the history reader bounds its scan by rowid instead (see history.md).
CREATE INDEX runs_started_at ON runs(started_at);
CREATE INDEX runs_run_id     ON runs(run_id);

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
-- the bytes unchanged. Machine-local; § Cache key derivation step 11.
-- A prune (`vx cache clean` with a bound) drops rows unwritten for
-- 30 days (a memo miss is the whole cost of a dropped row; item 1082).
CREATE TABLE file_hashes (
  path         TEXT PRIMARY KEY,
  mtime_ms     INTEGER NOT NULL,
  size_bytes   INTEGER NOT NULL,
  ctime_ms     INTEGER NOT NULL,
  ino          INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  seen_at      INTEGER NOT NULL
);

-- v42: each task's last key by a probe of the fold up to its files and
-- its files' git records, so a warm task's key is read back, not folded
-- again (src/cache/fold-memo.ts). A pure memo: rows unwritten for 30 days
-- go with a prune.
CREATE TABLE fold_memo (
  task_id TEXT PRIMARY KEY,
  probe   TEXT NOT NULL,
  key     TEXT NOT NULL,
  seen_at INTEGER NOT NULL
);

-- The size of each index blob the enumeration checked against the
-- worktree size git recorded (§ Cache key derivation, A-60): fixed for
-- its OID, so a warm run asks git for none. Swept with file_hashes by
-- seen_at, the time the row was written. v38: in the store, so a worktree
-- reads what another learned.
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
-- command, git/CI/host context, and run-level counts. Recorded
-- atomically alongside `runs` via recordRunBundle (one transaction).
CREATE TABLE invocations (
  run_id            TEXT PRIMARY KEY,         -- UUIDv7, == runs.run_id
  command           TEXT NOT NULL,            -- full argv, e.g. "vx run build --all"
  requested_tasks   TEXT NOT NULL,            -- JSON string[] of options.tasks
  cache_policy      TEXT NOT NULL,            -- the --cache-policy spec, e.g. "local:rw,remote:r"
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
  vx_version        TEXT NOT NULL
);
CREATE INDEX invocations_started ON invocations(started_at);
CREATE INDEX invocations_branch  ON invocations(branch);
CREATE INDEX invocations_ci      ON invocations(ci);

-- v22 (Tier 3): the input-fingerprint moat. One row per cache-key
-- component, keyed by the cache-ENTRY hash it belongs to (NOT a run
-- id). Written INSIDE the entry-save transaction — only on a cache
-- MISS, never on a hit — via INSERT OR IGNORE. A warm all-cache-hit
-- run writes nothing here. The "why did this re-run?" diff resolves a
-- run to its task hash (runs.hash), then joins two entries' components
-- over (kind, name), no recompute. v34: one row per entry, the
-- components one JSON array (a row per component cost a b-tree insert
-- each: ~0.5 ms a save at 50 input files). ON DELETE CASCADE sweeps the
-- row when a prune drops the entry.
CREATE TABLE entry_inputs (
  entry_hash TEXT PRIMARY KEY,       -- == entries.hash / runs.hash
  components TEXT NOT NULL,          -- JSON [[kind, name, hash], …] in (kind, name) code-unit order
  FOREIGN KEY (entry_hash) REFERENCES entries(hash) ON DELETE CASCADE
);
-- kind: file|env|runtime|ws-runtime|upstream|package|config|forward|workspace|plugin|format
-- name: file: workspace-rel path; env: var name; upstream: task id; …
-- hash: env|runtime|ws-runtime|forward|plugin: xxh3hex(salt + value); an unset env var: 'unset'

-- v32: what belongs to the entries, not to one workspace: 'value_salt',
-- the salt entry_inputs digests are taken under, so they compare with
-- another workspace's run.
CREATE TABLE store_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- v36: each executed success's duration, appended in the run's history
-- transaction, in the store so every worktree forecasts from it.
-- source: 'branch:<name>'; the forecast reads the newest five per task.
-- v37: 'remote' rows are a default-branch commit's timings a plugin
-- imported, one per (sha, task). A run on a crowded worker (runs.cpu_share
-- < 1) is kept as the time it would take alone: its CPU's wait for a core,
-- cpu/share - cpu, spread over the cores it kept busy (at least one), off
-- its wall time.
CREATE TABLE task_durations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project     TEXT NOT NULL,
  task        TEXT NOT NULL,
  source      TEXT NOT NULL,
  sha         TEXT,
  duration_ms INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  -- v45: a 'remote' row's measured need; NULL on the rest.
  cpu_parallelism        REAL,
  peak_rss_bytes         INTEGER,
  saturated_cores        INTEGER,
  saturated_memory_bytes INTEGER,
  -- v48: the task's definition the row is of (`taskDefinition`)
  def                    TEXT
);
CREATE INDEX task_durations_task ON task_durations(project, task, source, id);
CREATE UNIQUE INDEX task_durations_remote
  ON task_durations(sha, project, task) WHERE source = 'remote';

-- v38: the flaky record (failure-mode.ts), in the store so a key that
-- passed in one worktree and failed in another is flaky in both. Every
-- executed success or failure that names its key (keyed, cached, not run
-- behind a failure), and a key's first hit: a later hit replays a pass on
-- record, so a warm run on passed keys writes no row (one index probe,
-- ~1 ms per 1,000 hits). Pruned by age with the run history.
CREATE TABLE task_outcomes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project     TEXT NOT NULL,
  task        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  status      TEXT NOT NULL,
  attempts    INTEGER,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX task_outcomes_hash ON task_outcomes(hash, status);

-- v37: a plugin's own entries (`ctx.cache`), by core's key for its
-- name; written once, pruned by age with the run history.
CREATE TABLE plugin_blobs (
  key   TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  at    INTEGER NOT NULL
);

-- v47: what a remote's hasMany said it holds, hits only: a key with no
-- row is a miss. A whole hasMany answer rewrites the rows it asked, a GET
-- every remote answers with nothing drops one; pruned by seen_at with the
-- run history.
CREATE TABLE remote_hits (
  hash        TEXT PRIMARY KEY,
  size        INTEGER,
  duration_ms INTEGER,
  seen_at     INTEGER NOT NULL
);

-- v33: an artifact of at most 32 KiB compressed, its exact <hash>.tar.zst
-- bytes, written in the transaction that writes its entry rows. In the
-- store (or a named cache dir's cache.db), and outside every drop a
-- SCHEMA_VERSION reset makes: the artifact is the record.
CREATE TABLE artifacts (
  hash  TEXT PRIMARY KEY,
  at    INTEGER NOT NULL,              -- last use (ms): a row-less sweep's file time
  bytes BLOB NOT NULL
);                                     -- rowid: a hash probe never reads a blob

-- 'layout' = 'a2': the artifacts table's own version; another value
-- drops the table, silently. Nothing else drops it. Read only where
-- the schema was not this vx's, so a layout change bumps the schema.
CREATE TABLE artifacts_meta (
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

## Performance characteristics

- **Hashing cost** on a clean tree is near-zero per file: git index
  OIDs come from the bulk enumeration spawn, so key derivation does no
  file reads. Dirty/untracked files — and any path whose OID is not
  trustworthy (see "Clean filters") — hash in-process (whole-file
  read, behind a `(mtime, size, ctime, ino)` memo). Narrow
  `inputs.files` still helps on heavily dirty trees.
- **Cache read** is three indexed `SELECT`s (the `entries` row, which
  joins whether the artifact is inline, its `output_files` and its
  `output_dirs`), plus a `stat` of the artifact when it is a file.
  Restore is a tar.zst extract, skipped entirely when the on-disk
  tree already matches. `accessed_at` bumps (only rows over an hour
  old) are batched into one UPDATE at flush time.
- **Cache write** is one in-process tar.zst pack + one SQLite
  transaction, which holds a small artifact's bytes itself; a large one
  adds a temp write and an atomic rename. Hashing dominates the run; storage itself
  is cheap. The remote upload (if any) is backgrounded.
- **Claimed root files** (a lockfile plugin's lockfile and settings)
  are read once per `vx run` invocation; after a task that may rewrite
  one ran, one `stat` per file re-checks it (item 750). With no plugin
  claiming one, nothing is read.

## What's NOT in the key (and why)

- **`exec.env.passThrough` _values_.** Would force cache misses across
  machines with different CI flags, regions, or shell prompts. The
  _names_ are in the config hash (step 3) so adding/removing a
  passthrough still bumps the key for affected tasks.
- **Files outside the project directory that aren't declared.**
  Workspace-root configs (`tsconfig.base.json`, etc.) are not
  auto-included — declare them via `inputs.workspaceFiles`
  (root-anchored globs).
- **Gitignored files no entry names.** Vite and Next load `.env.local`
  on their own; a broad glob skips it, so editing it replays the old
  build. Name it: `files: ['src/**', '.env.local']`. Its bytes are
  hashed, never stored, and a missing file is simply not an input.
  Machines with different files compute different keys, so they miss
  each other's shared entries. `--affected` ignores it (only what git
  sees selects a task), and `vx watch` re-runs on its edit. A probe
  (`runtime: ['cat .env.local 2>/dev/null | cksum']`) still works where
  a command, not a path, decides what to read.
- **Node / Bun / OS / build-tool versions — unless you declare them.**
  The canonical mechanism is `inputs.runtime` /
  `workspaceRuntime` (e.g. `workspaceRuntime: ['node -v']`): the
  command output is resolved live at hash time, so it stays correct
  under the lock. Avoid baking versions via
  `define: { X: execSync(...) }` — that value freezes into the config
  object at lock time and goes stale.
- **`.vx/projects.lock.json`** — globally excluded (v24); also filtered out of
  `--affected` change sets. So are the files `vx lock` and `vx init`
  write beside it: each project's `vx.lock.json` review copy,
  `.vx/.gitattributes` and `.vx/.gitignore`.
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
misses once and re-saves, with nothing printed (2026-10-06: the
cache is vx's to keep). The index survives, so the old entries stay
until they age out under `vx cache clean --older-than`; no key derives to them again.

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
- A key part leaves the chain: every key moves, so no unchanged key
  holds wrong bytes (`v43` stayed when core stopped folding the
  `workspace:` and `pkg:` parts, 2026-10-14).

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
`private/vx-docs/src/content/docs/guides/upgrading.md` (the bump's
breaking footer).

### History

- **v47 → v48**: stored bytes wrong under a key the change does not move
  (2026-10-18). A task glob is a standard glob again: `[...]` is a
  character class and `\[id\]` names a route directory, which reverts
  v28. An output glob folds as its text, so `outputs: ['app/[id]/page.js']`
  keeps its key while what it selects changes; a v47 entry under it holds
  the literal route and would restore it.
- **v46 → v47**: the container changes. A file-backed entry is a
  `<hash>.tree/` of plain files (`cache.store`); the tar.zst is packed
  only to upload. A v46 store holds archives a v47 read would not look for.
- **v43 kept** (2026-10-14): core stopped folding the project's
  `package.json` and the root fingerprint files; every key moved, so
  nothing replays wrong bytes and no bump was needed.
- **v44 → v45**: the container changes. The sidecar lists the symlinks
  under the outputs (`links`) and a hit makes them; a v44 artifact holds
  a link to a file as a copy of its target, and a link to a directory
  never cached (keep links, as Turbo and Nx do).
- **v43 → v44**: the container changes. The sidecar lists the empty
  directories under the outputs (`dirs`) and a hit makes them; a v43
  artifact lists none, and its hit left `dist/empty/` out where the miss
  had made it (Growth's parity run: Turbo and Nx restore it).
- **v42 → v43**: stored bytes wrong under an unchanged key (Security
  F4, 2026-10-14). A scoped run stored its local entries under the
  default key, so a later default run on the same disk replayed a PR's
  bytes. A scoped run now stores under the scope's key locally as it
  does remotely; the fix cannot reach an entry already saved that way.
- **v41 → v42**: the stored output became both streams in the order
  the run printed them (`orchestrator/output-log.ts`), so a hit replays
  stderr too. A v41 entry holds stdout alone.
- **v40 → v41**: stored bytes wrong under an unchanged key (X-88). An
  output directory linked inside its project was never cleaned, so an
  entry could hold files a run of another key left there. The fix
  cannot reach an entry already saved that way.
- **v39 → v40**: stored bytes wrong under an unchanged key (X-32, X-33,
  X-34). An additive task's entry a hit replayed over a file the task
  had removed, one that missed a same-size rewrite, and a runtime probe
  answered before its upstream wrote.
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
  concurrent `vx cache clean`); the tar reader rejects an entry whose
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
  git/CI/host context, and run-level counts, recorded with `runs`
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
- **v23 → v24**: exclude `.vx/projects.lock.json` from the input file set
  globally (`ALWAYS_IGNORE` in `cache/inputs.ts`). The lockfile is
  committed, so git enumerates it, but it's vx's own frozen-config
  metadata — never a task input. Without this, a `vx lock` re-write
  busts every key on a project that globs the root lockfile (a broad
  `**/*` on the root project). Tasks whose `inputs.files` never
  matched it derive byte-identical keys. No SCHEMA bump — only the
  hashed file set changed, not the key layout or on-disk format.

- **v22 → v23**: fold `inputs.runtime` / `workspaceRuntime`
  command output into the key (two namespaced sections after
  env-values). The command _strings_ stay in the config hash (step 3);
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
  `logs/<hash>.{stdout,stderr}`. Adds run history for `vx info`.
  Removes the per-entry manifest.
- **v10 → v11** (PR #19): analytics columns added to the `runs`
  table: `run_id` (UUIDv7), `cpu_ms`, `peak_rss_bytes`,
  `wallclock_start_ns` / `wallclock_end_ns`, `cache_hit`. All
  nullable; directly queryable via `sqlite3 cache.db`. The on-disk
  `<hash>/` layout itself was unchanged.
- **v11 → v12** (PR #42): project's `package.json` bytes folded into
  every task's cache key implicitly. Matches Turbo / Nx "implicit
  dependencies" behavior — a `package.json` dep change invalidates
  the project's tasks even when `inputs.files` is narrow and
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
  so the filtered-upstream-hash set (step 8) shrinks for any task
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
