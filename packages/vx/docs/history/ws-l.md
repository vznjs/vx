# Workstream L — security findings (plan 2026-09-27): the record

## Audit

1. Tar reader and restore. Traversal (`..`, absolute, backslash, drive,
   NUL, long names), links in the tree (lexical + realpath walk, dangling
   links resolved, rename over a planted link) and zstd bombs (declared
   size, multi-frame, running count) were already held. Found: an
   extended header is read whole with no bound (L-1).
2. Remote inputs. Core's ingest holds (names, links, bombs, key check).
   vx-reapi's materialise wrote a server's ActionResult anywhere (L-2).
3. Sandbox. A task's socket grant lifted the block for the whole run
   (L-6). The shared `/tmp/claude` is a proven cross-task read (lead for
   B). Env is the isolated set; the default mode's `/proc` is its own.
4. Spawns. Git refs pass `--end-of-options`; a workspace path full of
   shell syntax ran sandboxed with no injection (probed). vx-reapi's
   remote `cd` was unquoted (L-7). The config purity gate is not a
   security boundary (a config is the user's code); its `Worker` gap is
   a staleness lead for D.
5. Secrets. vx's own records hold no plaintext value, but the digests
   `vx why` prints were unkeyed (L-4), and a value a task printed or a
   config inlined reached the terminal, the cached stdout, telemetry and
   `vx show` (L-11). vx-reapi puts env values in the uploaded Command on
   the execute path, by design.
6. `vx upgrade`: SHA-256 verified before a byte is written, the rename
   last; provenance is out of its reach and says so (item 1096). No bug.
   `vx mcp`'s tools are read-only and take no paths. No bug.

7. `vx mcp` inputs (coordinator backlog 1): every tool validates its
   arguments' shape, SQL is parameterized, a project name is matched by
   name (never a glob or a path), and no tool takes a path. The stdin
   line buffer is unbounded, but its only writer is the agent that spawned
   the server. No bug.
8. Lockfile parsers against hostile input (backlog 4): entries are held in
   Maps; a dependency cycle folds through core's `reachDigests` (a 20,000
   package npm lock with a cycle digests in 164 ms); yarn classic's
   `fields` ignores a `__proto__` string. A top-level `__proto__` field is
   dropped from bun's and pnpm's global material, but no package manager
   writes or reads one, so no install can differ. No bug.
9. Tokens and what leaves the machine. Bun's fetch drops `Authorization`
   on a cross-origin redirect (probed, GET and PUT), so `turboCache()` /
   `nxCache()` never hand their token to the host a server redirects to.
   vx-github posts the run summary, never task output. The config-eval
   cache stores only configs that read no `process`, so no env value is
   at rest there. A hit's replayed stdout is as trusted as its outputs.
   No bug.
10. What a remote or a peer can reach. vx-reapi's TLS follows the
    endpoint's scheme (`grpcs://`/`https://`) or `tls`, Bazel's convention:
    a token over `grpc://` is the config's choice. The host side of a port
    bridge binds 127.0.0.1, as the unsandboxed server would. Git's input
    enumeration is `-z` with `--` before every pathspec. No bug.
11. Writers and local state. The migration writer takes each project's
    directory from the repo it migrates, whose Nx graph already runs that
    repo's plugins: no boundary to cross. Rendered task names go through
    `quoteTsLiteral` (`__proto__` included), reasons into line comments.
    `vx watch` turns file events into reruns only; vx-schedule-history
    reads core's own run history. No bug.
12. Self-update and launch. `vx upgrade` takes the asset URL the release
    API names unchecked, but refuses the bytes unless they match the
    SHA-256 the same API publishes, before any rename. The npm launcher's
    source fallback runs `vxSourceEntry` from its own package.json. No bug.
13. What reaches GitHub. vx-github never prints its token and refuses one
    no header can carry; the check-run posts the summary only, and the
    invocation line it and telemetry carry counts what follows `--`
    instead of quoting it (item 1057; the CLI passes no line of its own).
    No bug.
14. The local cache directory. `cacheDir` may name a shared directory
    (the orphan sweep's name rule says so), and whoever can write there is
    trusted as a remote is; the default is the workspace's `.vx`, made
    under the user's umask, and an artifact is as readable as the `dist/`
    it came from. No bug.
15. Every way an artifact enters. Restore (`extractArtifactStream`) and
    ingest (`scanArtifact`) are the only two, and both check the `.vx-sum`
    (L-19); vx-reapi writes outputs from CAS blobs it digest-checks (L-3).
    No bug.
16. Plugin and config loading. Discovery skips `node_modules` and dot
    directories, so no installed package is taken for a workspace
    project. A helper a config imports reached Bun's registry
    auto-install (L-22).
17. Other children that run user code. `nx()` runs the workspace's own
    `node_modules/.bin/nx`, never `npx`; `nx-exec.cjs` runs under Node,
    which never auto-installs; `turbo()` spawns nothing. The lage loader
    was fixed in L-22. No bug.
18. What vx reads on a task's behalf. The save packs outputs outside the
    sandbox and followed a symlinked output to any target (L-23).
19. What vx writes for a task. A link a task planted at another task's
    file write grant is refused before the bind (item 1003's check, probed
    with a target outside the workspace). The cache directory was walled
    only as `.vx` (L-24).
20. What a task sees of the host's temp dir. Each task's directory under
    `vx-tasks` is its own (probed: a sibling's is absent), and the rest of
    `/tmp` is readable, as documented; vx's own strace logs sat there
    (L-25).
21. Verbs that read or delete local state. `vx run` always evaluates
    configs live; `vx-lock.json` is an audit only, and `vx lock --check`
    refuses a malformed or tampered lock by name (probed four shapes).
    `vx cache prune` deletes only names the artifact pattern admits
    (item 968). The `weakerWhenNested` `/proc` lead stays unprobed: this
    box runs the full profile, so the weaker one never runs. No bug.
22. Telemetry. `vx-otel` exports task output as log records from the
    bus, whose chunks `maskedEmitter` masks on the one-shot and the
    persistent path alike; the command is masked in the task view
    (L-11, L-14). An executor's thrown message is printed unmasked, but a
    plugin executor is trusted code with a config's reach. No bug.
23. What vx-reapi uploads. A symlinked input is sent as a link node
    (`lstat`, its target string), never its target's bytes, and core's
    input glob does not descend into a symlinked directory
    (`followSymlinks: false`). No bug.
24. What `vx mcp` hands an agent. `listTasks` returned a task's command
    unmasked (L-26); the other tools read stored, masked rows.
25. What vx-github posts. The check run and job summary carry escaped
    task ids, statuses, durations and the invocation line with what
    follows `--` counted; no task output. No bug.
26. `vx watch`. A changed path only selects what reruns; no path reaches a
    shell or a command line. No bug.
27. The docs playground. The reader's config runs in a Worker made from a
    Blob URL, away from the page; no config comes from the URL; results
    reach the page as `textContent`. No bug.
28. `vx-schedule-history` reads only core's own run history. No bug.
29. A named pipe in an input glob or as an output. Input hashing skips it
    (a run with a FIFO under `src/**` finished at once), and the save
    refuses an output that is not a regular file. No bug.
30. A config that never finishes. The worker path terminates its thread at
    the budget, but the first, in-process load races the import against a
    timer, which a synchronous loop never lets fire: `while (true) {}` at a
    config's top level hung `vx run` silently (probed, 45 s). A config is
    trusted code, so a lead for D, not a security fix.
31. vx-reapi's token and TLS. gRPC follows no redirect; its headers go to
    the configured endpoint only, over TLS per the scheme or `tls`
    (audit 10). No bug.
32. Release caches. `release.yml` restores no cache (no `actions/cache`,
    no remote cache declared), so no PR run can seed what a release
    builds. No bug.
33. The npm launcher resolves its platform binary from its own
    `node_modules` (`require.resolve` beside itself), and its source
    fallback runs the user's `bun` from `PATH`. No bug.
34. Workflow injection. No `pull_request_target`; `auto-release` runs only
    on a successful CI `push` to main, never a fork's PR; event values
    reach shells through `env` in `auto-release` and `ci.yml` (the PR
    title included); `npm.yml` and `release.yml` pasted the release tag
    into scripts (L-28).
35. The runner and docs workflows. The runner action installs from
    Ubuntu's signed apt sources only; `docs.yml` deploys from `main` and
    a dispatch, each action pinned. `ci.yml` and `windows.yml` named no
    token permissions (L-29).
36. `npm.yml` and `release.yml` grant write scopes per job, only to the
    job that publishes or uploads.
37. Audit 9's redirect probe is now a test:
    `vx-migrate/tests/token-redirect.test.ts` (a same-origin control
    keeps the token).
38. Config-eval Worker resource limits. A config is trusted code
    (`security.md`), so memory or CPU in its Worker is no boundary;
    a wedge is audit 30's lead. No bug.
39. What a remote executor receives. vx-reapi's Command carries only
    `exec.env.define` and the `cache.inputs.env` values the local child
    gets (`commandEnvironment`), never `passThrough` or the host's env;
    those values rest unmasked in the remote CAS. By design (Bazel's
    `--action_env`); `security.md` now says so.

## Items

- L-1. `fix(cache)`: an extended header (`x`, `L`, `g`) is read whole, so
  its declared size was a claim on memory the stream never paid for: a
  1 GiB pax header (~32 KB as zstd) peaked at 2 GiB RSS where a 1 GiB
  regular entry streams in 32 MiB, under the 2 GiB ceiling. Now refused
  past 1 MiB before its body is read; a pax `size` that is not a whole
  number (`0.5` moved the reader to a fractional offset) is refused too.
  Rows in `tar-stream.test.ts`, red without the fix.
- L-2. `fix(vx-reapi)`: materialise joined a server's ActionResult paths
  and Tree names as given, so a hostile or broken server (a fresh result
  or a replayed record) wrote outside the workspace: `../..` or absolute
  paths, a Tree name `..`, a link it placed followed by a directory
  written through it, a file written through a link standing at its
  path, and setuid bits kept. Every path is now fenced to the workspace
  root (lexical, then the deepest existing ancestor's real path), a link
  whose target leaves the workspace is refused, an output file is
  written `O_NOFOLLOW` (a link there is replaced), and a mode keeps its
  permission bits only. Rows in `materialise-fence.test.ts`.
- L-3. `fix(vx-reapi)`: a CAS read was checked against its digest's size
  only once whole: a zstd batch entry or ByteStream reply was expanded to
  its frame's end (256 MiB from ~8 KB), and a body that never ends was
  collected until memory ran out. The size is now held as bytes arrive,
  zstd is decoded no further than the size, and a batch entry is held to
  the digest asked for (one not asked for is dropped). Rows in
  `read-bounds.test.ts`.
- L-4. `fix(cache)`: the value-bearing digests `entry_inputs` and
  `runs.forward_args` hold (env values, runtime outputs, `--` args, plugin
  parts) were an unkeyed 64-bit xxh3, and `vx why` prints them (text,
  JSON, MCP `whyDidThisRerun`): a public CI log let anyone confirm or
  brute-force a short secret. They are now xxh3 under 128 random bits
  each store draws once (`schema_meta.value_salt`); a diff still sees a
  change. Rows in `cache.test.ts`, `key-fold.test.ts`,
  `run-history-columns.test.ts`.
- L-5. `fix(cache)`: `ingest` wrote a remote body to its temp with no
  bound, so a body that never ends (turbo, nx or reapi remote) filled the
  disk before the decode's ceiling saw a byte. The compressed body is now
  held to the ceiling's zstd bound (length header, Blob size, running
  count on a stream). Cost: 4.4 ms per 64 MiB streamed (min of 7).
  Row in `artifact-ceiling.test.ts`.
- L-6. `fix(exec)`: SRT reads its `socket(AF_UNIX)` lift from the
  run-wide config, so one task's `unixSockets` or `localBinding` port list
  lifted it for every sandboxed task of the run: a task that declared no
  socket connected to a host unix socket (docker's, ssh-agent's) once a
  sibling did (probed: `socket(1, 1, 0): Operation not permitted` alone,
  the host socket reached beside a granted task). The lift is now set for
  each task's own wrap, wraps taken one at a time, and only in a run
  where some task asks. Row in `sandbox-runtime.unsafe.test.ts`.
- L-7. `fix(vx-reapi)`: a root-anchored remote command entered its
  project with `cd '<dir>'` unescaped, so a directory named `it's …`
  ended the quote and the rest ran as script on the worker (a syntax
  error at best). Quoted as the forwarded args are. Row in
  `executor-helpers-sweep.test.ts`, run by a real shell. A mutation pass
  over L-2's fence found two guards no row held: its `isAbsolute` refusal
  (the containment check already judges an absolute path) and the memo
  clear after a link (a checked directory is created real, and a link is
  never placed over one), both removed; its NUL refusal is kept, now held
  by a row (a NUL reached the file system as a raw
  `ERR_INVALID_ARG_VALUE`).
- L-8. `fix(vx-migrate)`: `turboCache()` with a signature key wrote the
  whole remote body to a temp before checking its tag, with no bound: a
  server that never ended one filled the temp's disk before core's
  ingest bound (L-5) saw a byte. The signed body is now held to core's
  ceiling at zstd's bound, by its length header or a running count. Row
  in `turbo-cache-sweep.test.ts`. The G lead it came from is closed.
- L-9. `fix(vx-migrate)`: `turboCache()`'s batch query read its JSON
  reply whole, with only the request's timeout for a bound: a reply that
  ran on took memory until it ended. It is now read no further than 4 KiB
  per hash asked plus 64 KiB; past that it is no answer, and each hash is
  asked on its own, as for any other non-answer. Row in
  `turbo-cache-sweep.test.ts`. The G lead it came from is closed.
- L-10. `fix(exec)`: SRT binds its whole temp dir (`/tmp/claude`)
  writable into every sandboxed task, where each task's `TMPDIR` and port
  bridge socket lived: a task listed and read a concurrent task's
  `TMPDIR` (probed: `L10-SECRET` read across projects) and could replace
  its bridge socket. vx's per-task state now lives under `vx-tasks/`,
  walled from every task, each granted its own directory. Coordinator
  go-ahead, outside L's slice. Row in `sandbox-runtime.unsafe.test.ts`;
  the bridge-socket rows follow the socket into the task's directory.
- L-11. `fix(orchestrator)`: the value of a secret-named variable (`TOKEN`,
  `SECRET`, `KEY`, `PASSWORD`, `PASSWD`, `CREDENTIAL`; vx's env or a
  task's `define`) reached the terminal, the cached stdout every hit
  replays, the `$ command` line, telemetry records and `vx show` as
  written. It is now masked `***` at each: task output by a streaming
  mask (a value split across chunks is still caught; a server's too),
  captured stdout
  whole, a replayed hit's stdout, the command where it is shown and in
  the cache entry (`vx why`, a remote cache). `vx why`'s env digests and
  `vx last` were probed clean. 9 µs
  per hit that prints (144 env vars), none for a silent hit. Rows in
  `secret-mask.test.ts`. Coordinator backlog 2.
- L-12. `ci(release)`: the release binaries carried no provenance:
  `vx upgrade`'s SHA-256 comes from the release API that serves the asset,
  so whoever could replace the asset replaced its digest too (item 1096).
  release.yml now attests every binary it uploads
  (`actions/attest-build-provenance`, pinned by commit; darwin after the
  re-sign), verifiable with `gh attestation verify`. The npm launcher
  downloads nothing (the binaries ride npm platform packages published
  with `--provenance`). Rows in `release-provenance.unsafe.test.ts`.
  Coordinator backlog 3.

- L-13. `fix(exec)`: `vx-tasks` and every task directory were made at the
  umask's mode (0755) in a temp dir any local user shares, and whoever
  made `vx-tasks` first owned it. Probed as a second uid: it renamed root's
  running task directory and planted its own under the name, the path the
  host bridge dials and the write grant is realpath'd from. Now 0700, and
  a `vx-tasks` that is a link, another user's, or in a parent others may
  rewrite without the sticky bit is refused. Rows in
  `sandbox-runtime.unsafe.test.ts`.
- L-14. `feat(config)`: L-11 masked a secret by its name alone, so a
  token named `GH_PAT` or `NPM_AUTH`, echoed by a task, was written to the
  entry's stdout and replayed by every hit, local and remote (probed: the
  miss, the stored row and the hit all held it). `exec.env.secret` lists
  names masked whatever they are called, in every place L-11 masks.
  Supervisor backlog 1. Rows in `secret-mask.test.ts` and
  `config-schema-refusals.test.ts`.
- L-15. `fix(vx-migrate)`: fuzzing turbo.json's shape found fifteen
  fields whose wrong type reached a mapper loop as a TypeError;
  `"dependsOn": true` printed `TypeError: true is not iterable` with its
  stack from `bunx @vzn/vx-migrate`. Every field the mapper reads is now
  checked at read and refused by file and name; the Nx graph's reader had
  eight of the same class, fixed the same way. moon, wireit and lage held
  (their readers guard each field; a non-object file is refused
  upstream), and the lockfile parsers threw only Errors, caught at the
  plugin with the file named, and never hung (500 truncations and
  mutations each). Supervisor backlog 2. Rows in `turbo-map-sweep.test.ts`
  and `nx-map-sweep.test.ts`.
- L-16. `fix(vx-lockfile)`: fuzzing the lockfile parsers found no hang
  and no stack, but a malformed bun.lock refused on the key path as a bare
  "JSONC Parse error": its patch files are read before the digest, outside
  the wrapper that names the file and the install that fixes it. Both
  reads go through one wrapper now. Row in `refusal-message.test.ts`.
- L-17. `fix(workspace)`: a config-eval row cut short (a crash
  mid-write, a bad disk) failed every later run with a `SyntaxError`
  stack from the loader until the cache was wiped (probed). A row that is
  not a JSON object is a miss now: evaluated again, the row replaced. The
  tar reader held under 3,000 mutations (TarFormatError only, no hang),
  and the cache wraps anything else a restore or ingest throws as a
  corrupt artifact. Supervisor backlog 2. Row in `config-cache.test.ts`.
- L-18. `test(ci)`: every third-party action already ran from a full
  commit SHA and every `npm publish` carried `--provenance`, but nothing
  held either: a tag ref or a dropped flag would have gone in unseen. A
  law in `supply-chain.unsafe.test.ts` now does, over every workflow and
  composite action, with the checker's own refusals pinned. There is no
  checksum file to attest: `vx upgrade` checks the digest the release API
  publishes, and each binary is attested (L-12). Supervisor backlog 2.
- L-19. `fix(cache)`: nothing checked an artifact entry's BODY. Tar sums
  headers only; neither zstd writer asks for a frame checksum; so a byte
  flipped in a raw zstd block (incompressible output) decoded clean, and
  a local or remote hit replayed wrong bytes: 1,141 of 1,141 flips in a
  random 8 KB body went unseen (probed). Each artifact now ends in a
  `.vx-sum` CRC-32 over the entries before it, checked on scan and
  restore before anything lands; `CACHE_VERSION` v36. A CRC is for
  damage, not forgery: an HTTP or Turbo/Nx wire store that writes what it
  likes is trusted as a writer (turboCache's signature is the one
  authenticated wire), and REAPI's CAS holds each blob to its digest
  (L-3). Supervisor backlog 1. Rows in `artifact-checksum.test.ts`.
- L-20. `docs`: SECURITY.md said how to report and what is in scope,
  but nothing said what vx trusts, what it checks on bytes it did not
  write, or what the sandbox does not stop. `docs/security.md` (on the
  site as Security model, linked from SECURITY.md) does, each claim
  drawn from the code and the items that hold it. Supervisor backlog 3.
- L-21. `test(vx-migrate)`: the tampering proxy of supervisor backlog 1,
  per wire. A Turbo or Nx cache server that hands back an artifact whose
  tar is intact but one output byte changed is now a miss that rebuilds
  (L-19's sum), held end to end through `turboCache()` and `nxCache()`;
  each row replays the altered bytes as a hit with the sum check
  disabled. REAPI's CAS already holds each blob to its digest (L-3).
- L-22. `fix(cli)`: a config's own bare imports were refused before
  evaluation when no `node_modules` provides them, but a local helper the
  config imports was not scanned, and Bun auto-installed its import from
  the registry and ran it (probed: `is-odd` and `is-number` fetched). The
  shebangs of `vx` and `vx-migrate` and the npm launcher's source
  fallback now run Bun with `--no-install` (the launcher also gained the
  missing `--no-env-file`), and so does vx-migrate's child that
  evaluates a `lage.config.js`; a compiled binary never auto-installed.
  Rows: a local registry sees no request, red without the flag.
- L-23. `fix(cache)`: vx packs a symlinked output as its target's bytes,
  reading it outside the task's sandbox, so a sandboxed task that linked
  `dist/x` to a file it could not read (another project's) had that file
  packed into its artifact and the remote (probed). The save now
  `lstat`s each output (no extra call for a file), resolves a link, and
  refuses one whose real target is outside the project; the body is read
  from the resolved path. Row: e2e, no artifact holds the target's bytes,
  red without the bound; the in-project `link` shape still caches.
- L-24. `fix(sandbox)`: `.vx` is walled from every sandboxed task, but a
  `cacheDir` configured inside a project was not: a task granted
  `.vxcache/` wrote a file into the store (probed), where it could plant
  artifacts and index rows. The run's cache directory now reaches the
  sandbox request and is a wall like `.vx` when it lies in the workspace.
  Rows: the request refuses the grant (control: without the cache dir it
  binds) and an e2e run fails the task with nothing planted, red without
  the plumbing from `run.ts`.
- L-25. `fix(sandbox)`: the Linux trace log was written to
  `os.tmpdir()/vx-strace-<tag>.log`, readable by every sandboxed task, so a
  concurrent task read the paths another opened (probed). It now sits in
  the task root beside the task directories, which every sandbox replaces
  with its own. Row: a concurrent task greps the shared temp dir while the
  other runs and finds nothing, red without the move; the rows that follow
  the log now look in the task root.
- L-26. `fix(vx-mcp)`: `vx show` masks a task's secret values in its
  command (L-14), but `listTasks` returned the command raw, so an agent,
  often a remote model, read the token a config inlined (probed). The
  façade exports `maskedCommand` and `listTasks` uses it. Row: a declared
  secret reads `***` and an undeclared value stays, red without the mask.
- L-27. `fix(cache)`: a local save stores the masked command (L-11), but a
  remote hit's ingest wrote the command the lookup carried, raw, so the
  token a config inlined sat in cache.db for `vx why` and `vx mcp`
  (probed). `getContext`, the one context the prefetch and the lookup
  share, masks it; the local short-circuit never runs with a remote.
  Row: a remote hit's entry row reads `***`, red without the mask.
- L-28. `ci`: `npm.yml` and `release.yml` pasted
  `github.event.inputs.version || github.event.release.tag_name` (and
  `inputs.tag`) into `run:` scripts, where GitHub expands it before the
  shell parses; a tag holding `$(…)` would run in the job that holds
  npm's OIDC token, and the unvalidated version was pasted into later
  steps too. The four sites take it through `env`, and npm's resolve
  step refuses anything but a version. Law: `supply-chain.unsafe.test.ts`
  rejects `github.event.*`, `inputs.*` or `github.head_ref` in a `run:`
  block (red on the four sites before), with a checker row.
- L-29. `ci`: `ci.yml` and `windows.yml` declared no `permissions:`, so
  the jobs that run a PR's code took the repository's default token,
  which may write. Both are now `contents: read` (checkout is all they
  need; vx-github writes the job summary, which takes no token). Law:
  every workflow declares a top-level `permissions:`, red on the two.
- L-30. `perf(vx-bench)` (owner: "in all our benches are we using vx
  lock? we should"): `compare.ts`, `run.ts`, `ab.ts`, `real/turbo-repo.sh`
  and `real/nx-repo.sh` run vx `--frozen` from a `vx lock` taken once per
  workspace before the timed reps; a failed lock ends the bench.
  compare's frozen arm is the headline `vx`, `vx (no lock)` beside it.
  No bench re-run: the committed 2026-09-03 run measured both, so its
  rows were relabelled (numbers unchanged; the site's cached run reads
  476 ms, was 510; benchmarks.md's stress table keeps a _vx, no lock_
  column, and the honest-benchmarks post's pins read that row, as the
  post predates the lock); real-repo rows are marked as run without a
  lock.
  `turbo()` and `nx()` lock and run frozen (their tasks, no vx.config,
  map live). A `--frozen` run does not fail on an edited config (owner
  2026-06-13: runs trust the lock, `vx lock --check` audits); it fails
  on a project the lock lacks. Rows: `turbo.test.ts` / `nx.test.ts` ›
  "… under vx lock and --frozen" (the turbo row red when the missing-
  entry refusal returns `{}`), `ab.test.ts` › `frozenArgs`.

- L-31. `fix(cli)`: `vx why` printed an input file's name raw, and a
  name is anyone's bytes: `x\x1b]0;owned\x07\ry.txt` retitled the
  terminal and its `\r` overwrote the row. The moved-input status line
  printed one too. Both now write C0/C1 controls and DEL as `\xNN`
  (`printable`, `util/paths.ts`); `--format json` keeps the name. Row:
  `why.test.ts` › "vx why prints a file name (L-31)", red without the
  fix. A task's own stdout and stderr are its bytes, replayed as they
  were, and stay so.

- L-32. `fix(vx-migrate)`: in a compiled vx, `loadLageConfig` spawned
  `process.execPath -e`, which is vx, so `lage()` failed with "unknown
  command: -e". The child now gets `BUN_BE_BUN=1` (a plain Bun ignores
  it). Row: `lage.test.ts` › "loads under a compiled runtime…", a
  compiled stand-in as `process.execPath`, red without the fix. The
  class: `shellArgv`'s Windows `[execPath, 'exec', …]` is the same
  shape, but there the variable would reach the task's own children (a
  `vx` a task runs would act as Bun), so it stays a lead.
- L-33. `fix(cache)`, J-69's lead: the `cache.inputs.runtime` probe ran
  `['sh', '-c', command]` on a PATH led by the project's
  `node_modules/.bin`, and `Bun.spawn` looks a bare name up on the
  child's PATH, so a dependency shipping an `sh` bin interpreted every
  probe and its output entered the key. The probe now takes
  `executablePath('sh')` (vx's own PATH), as task commands do. Row:
  `inputs.test.ts` › "runs its command through vx's own sh", a planted
  `sh` printing `planted`; red without the fix. The class, grepped: the
  `executor` plugin example (`vx init --plugin executor`) spawns a bare
  `sh` with the task's env; a lead for its owner, since it is regenerated
  from `vx-plugin-examples`.
- L-34. `fix(vx-migrate)`: `turboCache()` ignored `TURBO_CACHE` and
  `TURBO_REMOTE_CACHE_READ_ONLY`, and `nxCache()` ignored
  `NX_SKIP_REMOTE_CACHE` / `NX_DISABLE_REMOTE_CACHE`: the switches a CI
  sets so an untrusted pull request reads the shared cache at most, and
  never writes what `main` would restore. Under vx such a job wrote it.
  Each now narrows the run's `--cache` policy as the tool reads it (an
  omitted `TURBO_CACHE` source is off). Rows: `turbo-cache.test.ts` ›
  Turbo's TURBO_CACHE and TURBO_REMOTE_CACHE_READ_ONLY narrow the remote,
  `nx-cache.test.ts`'s resolve row; each red on its mutant.

- L-36. `fix(util)`: a multi-line secret (a PEM key in a secret-named
  variable) was masked only as a whole value, so a tool that indented or
  reflowed it (`… | sed 's/^/  /'`) printed every line of the key in the
  clear. Each line of six characters or more is now masked too, as GitHub
  Actions does. Rows: `secret-mask-multiline.test.ts`, red without the
  fix.

## Leads for other streams

- Cache owners: `src/cache/archive.ts` and `tar-stream.ts` changed under
  L-19 (a `.vx-sum` last entry, `CACHE_VERSION` v36). A test that builds
  an artifact by hand wraps it in `tests/helpers/artifact-sum.ts`.

- B (sandbox): `src/exec/sandbox-runtime.ts` changed under L-13
  (`ownTaskTmpRoot()` before a task directory is made).

- B (sandbox): `src/exec/sandbox-runtime.ts` changed under L-10 (task
  tmpdirs and bridge sockets moved under a walled `vx-tasks/`); the lead
  below is closed by it.
- B (sandbox), PROVEN by probe, CLOSED by L-10: every sandboxed task shares SRT's
  writable `/tmp/claude`, where the task tmpdirs (`vx-task-*`) and the
  port-bridge sockets (`vx-port-<tag>-<port>.sock`) live. Task b ran
  `cat /tmp/claude/*/secret` and printed what a concurrent task a wrote to
  its own `$TMPDIR`: a cross-project read, and b could as well replace a's
  bridge socket. A per-task `denyRead` of `/tmp/claude` plus the task's
  own dir as a write grant does not take: SRT's default write path
  re-binds it (tried, L review). Needs SRT driven differently (a private
  tmpfs per task, or SRT's tmp dir pointed per task).
- B (sandbox), from the L review, unproven by probe:
  - `weakerWhenNested` makes SRT bind the host's `/proc` (read in SRT's
    source). Probed on this box as root: the task saw only its own pid
    namespace (pids 1, 2, 6) and `environ` was denied, so no leak here;
    a box where the weaker profile is the one that runs is unprobed.
  - Strace logs (`os.tmpdir()/vx-strace-<tag>.log`) are readable by a
    concurrent task: every path another task opened. Probed and fixed
    (L-25).
  - A write grant's realpath is checked before bwrap mounts it; a
    concurrent task that can write the parent may swap in a link between.
- CLOSED (D). The purity gate lets `new Worker('./x.ts')` through: it
  no longer does, `Worker` is in `config-cache.ts`'s `IMPURE_RE`.
- CLOSED (not reproduced on main, 2026-09-30: three in-process `run()`
  calls on a config reading `process.env`, with and without the var in
  `cache.inputs.env` and a token-named var inlined in the command, hit on
  the second; D-76's env restore is the likely fix). D (config), from L-27's probe: two in-process `run()` calls on one
  config that reads `process.env` derived different keys (no hit, even
  without wiping `.vx`); the same config through the CLI hits. A literal
  config hits in-process. Unexplained; an embedder of `run()` would miss.
- D (config), from audit 30: the in-process first load's deadline
  (`project-loader.ts`, D-66) cannot fire on a synchronous loop, so
  `while (true) {}` in a config hangs `vx run` with no word; the worker
  path's `terminate` does not. Moving the first load off the main thread
  is a perf trade to measure.
- exec (Windows): a compiled vx runs a task as `[execPath, 'exec', script]`
  (`shellArgv`), which is vx, not Bun; `BUN_BE_BUN=1` there would reach
  the task's children (L-32).
