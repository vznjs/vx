# Lessons learned the hard way

Moved out of CLAUDE.md on 2026-10-12 (owner: trim CLAUDE.md, lessons to
docs). Read it before a probe, a mutation sweep, a perf A/B, a platform
claim or a timed test. Add a lesson here, not to CLAUDE.md.

- Repro before fix; record what a probe refutes too.
- Every fix must fail without itself (differential). Keep controls that
  pass both ways. A surviving mutation means the test is wrong at least as
  often as the claim — and suspect a second copy of the rule first.
- A skip is a silent pass. Gate on an env var CI sets.
- Assert the exact expected set, not the absence of one string.
- A test that expects a failure passes on any failure. The credential-store
  test in `dte-sandbox.unsafe.test.ts` expected exit 1, and its config was
  refused (`local: 0`, an option `dte()` does not take) before any worker
  joined (2026-10-26). Also assert where the failure came from.
- A test that reads the constant it guards is a tautology, and a
  GENERATED table makes it a silent one. The cache-layer gate's
  fixture built its expected message by mapping over
  `CACHE_LAYER_METHODS`, so it agreed with any list; my replacement
  generated one row per member FROM the same constant and shrank with
  it — caught only because the differential run scored 44 pass and no
  failure (item 536). Generate from the SOURCE OF TRUTH instead (the
  `CacheLayer` interface, `config-schema.ts`'s own call sites in 533)
  and assert the constant against it in both directions, duplicates
  included. And remember `toThrow(string)` matches a SUBSTRING:
  `missing key(), key()` satisfies a probe for `missing key()`, so a
  message a row is pinning is compared with `toBe` (2026-09-21).
- A comment claiming a guarantee the code lacks is a defect: de-claim or
  implement.
- When a fix covers a class, grep the class in the same commit.
- A red main is not always your diff: read the failing test name and the
  actual error. `git checkout <file>` never undoes a mutation — use the
  reverse edit.
- A timed wait in a test is a claim about time: prove it with the
  shortest window that still fails without the fix. A kill grace is
  `VX_TEST_KILL_GRACE` (a duration, `200ms`); "the child is dead" is `tests/helpers/alive.ts`
  (a zombie counts); "the task has started" is a marker file, never a
  sleep.
- Use the session scratchpad, never bare `/tmp`.
- The gate here runs LINUX ONLY; macOS is a CI job you cannot run. So a
  row that compares PATHS is a platform claim, and the platform that
  breaks it is the one you never see: macOS's `/var/folders` temp dir is
  a symlink to `/private/var`, so a fixture root from `mkdtemp` is
  NON-CANONICAL there and any code that realpaths one side of a
  comparison and not the other behaves differently (item 537's
  link-dedup control, green on both Linux jobs, red on darwin). Simulate
  the shape rather than guessing at it — a root reached through a
  symlink (`/tmp/link -> /tmp/real`) reproduces it on Linux in three
  lines — and give a path fixture a canonical root unless the
  non-canonical one IS the subject (2026-09-21).
- Format-check by directory scan (`cd packages/vx && bunx oxfmt --check .`,
  what CI runs), never by naming the file: `oxfmt --check <file>` passed a
  STATUS.md that the scan rejected (a code span wrapped across an indented
  line; proven both ways, 2026-09-10). And read the scan's exit or its
  `Format issues found` line, never its last line: the verdict prints
  BEFORE `Finished in …`, so `| tail -1` reads clean on a failure (the
  gate caught what that tail passed, 2026-09-15). And a chain that
  greps the verdict swallows the exit — piping the scan into a grep of
  its verdict line exits 0 either way, so `&& commit` went through on
  a failure twice in one day (2026-09-16). Capture the exit (`rc=$?`
  before the grep) and gate the chain on it.
- A numbered entry in STATUS's Next list goes at the END of the list:
  the formatter renumbers the list sequentially, so one inserted above
  its neighbours moved every number below it (three times by
  2026-09-16). Same for a code span: never let one wrap across an
  indented continuation line — the formatter un-indents the line and
  the list item breaks.
- Correct wrong entries in place; never write a plausible cause you have
  not proven.
- `pkill -f` / `pgrep -f` match the shell running them when the pattern
  appears in its own command line: the pkill killed its caller (exit 144) and a `while pgrep` wait never ended (three times, 2026-09-12).
  Match on a marker the target alone carries, or hold the child's pid.
- Bun drops what a pipe has not yet taken when `process.exit` follows a
  large stdout write (2 MiB written, 1.1 MiB read, 2026-09-15). `bin.ts`
  ends stdout and exits in its callback; a verb never calls
  `process.exit` itself, and a pin's reader starts late on purpose.
  And `bin.ts` alone listens for `error` on stdout and stderr: a reader
  that leaves (`| head -1`, EPIPE) is an `error` event, and an unheard
  one killed a green run with a stack and exit 1 (2026-09-16).
- A platform unit (bytes vs kilobytes, ms vs µs) is measured, never
  asserted: pin it by producing a known quantity and reading it back
  within a bounded factor. A pure-function test of the conversion only
  restates the assumption (Linux peak RSS ran 1024× too big under one,
  2026-09-12).
- `bun --bun` links `node` to itself under `/tmp/bun-node-<build>/`,
  mode 0700, owned by whoever ran it first; a second user gets no shim
  and no word of it, and `bun --bun astro build` ran the PATH's Node 20
  (2026-09-16). On a shared box remove that directory before a run as
  another user. A file-system refusal (`EACCES`, `ENOSPC`) reaching the
  user as an "internal error" or a stack is a defect: `isFsRefusal`.
- astro prerenders in a CHILD process it spawns as `node`, and
  `bun --bun` redirects that child only through a shim it writes under
  `/tmp/bun-node-*`; a sandboxed task cannot write it, so on CI the
  prerender ran under Node while the parent ran Bun, and a box whose shim
  already existed saw Bun everywhere (items 700, 708). "Runs under Bun"
  is a claim about every process a task spawns: probe it without the
  host's shim (`typeof Bun` printed from the code in question).
- A complexity guard (a size and a time bound) times CPU, not wall
  (`tests/helpers/cpu-clock.ts`): a crowded worker adds wall, not CPU. A
  planRun bound redded at 6.6 s of wall on a CI worker booked 3.7 of 4
  cores, and took 1.6-1.9 s of CPU idle or beside 24 busy loops
  (2026-10-23). A deadline the code itself enforces stays on the wall.
- Bun's per-test timeout is a wall budget too. A test that spawns vx and
  git (457 ms idle, 1.3 s under strace) passed 5 s on a packed DTE worker
  (#4198), so the core shards run `--timeout=30000` (`vx.config.ts`) as a
  hang guard; speed is a CPU-time assertion, never the timeout.
- Two measured quantities that are equal by construction sit on jitter:
  a light child's `ru_maxrss` IS the parent's mark, and the kernel's RSS
  counters lag by pages, so an exact `>` between them flipped on one CI
  run in twelve (2026-09-16). Compare with a slack above any accounting
  jitter and below what the number decides (4 MiB against 64 MB steps),
  or measure a difference that exists.

- A manual `su probe -c 'bun test …'` needs `PATH=/opt/probe-bin:$PATH`
  or a sandboxed task that runs `bun` fails with "command not found"
  and the port-bridge tests go red for the invocation, not the code
  (the gate's step sets it; 2026-09-16, item 250).
- `Bun.Glob` does not expand a brace whose alternatives hold a slash:
  `{*,*/*}/package.json` matches nothing; two scans (2026-09-16).
- A dead `HTTPS_PROXY` does not stand in for "no network" — Bun's
  fetch reached the release regardless. Use `unshare -n` or
  `bwrap --unshare-net` (2026-09-16, item 247).
- The `VX_TIMING` accumulated span table sums WALL per call across
  concurrent workers: 2 ms per `save: pack` under four workers is
  overlap, not cost (an isolated one-file save is 0.82 ms). Measure a
  suspected per-call cost in isolation before chasing it (item 254).
- A `TMPDIR` under a workspace under the runner's temp directory puts
  the sandbox runtime's socket past `sun_path` on macOS (104 bytes):
  a temp-directory pin uses a short path directly under `os.tmpdir()`.
- An edit script that writes files before its last assertion leaves a
  half-done tree when that assertion fails, and a chain gated on the
  scan and the tests committed it (the STATUS trim, 2026-09-16). Gate
  the chain on the script's own exit; make every write idempotent.
- A list item inserted at the blank line after item N lands BEFORE
  any item that follows N, so a cut "from N to the next item" misses
  the one just written. Count what a cut holds before writing it out.
- A type-checker pointed at a directory that holds a symlinked
  `node_modules` walks it until the kernel kills it
  (`oxlint --type-check .`, 2026-09-16). Name the files.
- A probe's negative case is checked before its result is read: a
  flag set to "broken" still matched a `grep -q ok` ("broken" holds
  "ok"), and the cycle that was to fail passed (2026-09-16).
- The mutation-sweep method — worktree, pinned Bun, per-file summary,
  CAUGHT / SURVIVED / INCONCLUSIVE, and the twenty-six rules it taught
  (a crash, a skip, a non-compiling or no-op mutation is a silent
  pass; the file list is the fixture; type-check per mutation for a
  declaration-heavy file) — is `docs/design/mutation-sweeps-2026-09.md`.
  Read it before sweeping; nothing below repeats it.
- A mutation's replacement text is code: `void (…,)` does not compile
  and reddened 164 unrelated rows, and a replacement line that opens
  with `(` is a call on the line above (`disabled.add(sink)(…)`).
  Neutralise a call as `;((_: unknown) => {})(…)` (item 654).
- Two guards can mask each other: each alone survives and only the
  pair is held. When a guard survives, ask what ELSE would have to
  fail for the observable to change, and mutate that too (item 563).
- A negative `existsSync` proves nothing without the positive first,
  in the same row; and a control held by a coarse gate holds nothing
  about the fine ones — put each control PAST the coarse gate (564).
- When several oddities share a container, suspect the container:
  three "flappers", a 1-in-8 SIGILL and three inert tripwires were
  one fact, Bun 1.3.11 below `engines.bun` (566, 572). `bun --version`
  against the floor and CI's pin comes before any story about load;
  the gate refuses below it since item 575.
- `Bun.file(<dir>).exists()` is false. Stat when the question is "is
  there something here" (565 → 576; `tests/bun-file-exists-sites.test.ts`
  holds the file-path sites).
- The platform answer may already be in the file you are testing:
  grep the module for the symptom before writing a row that leans on
  an FS or syscall behaviour, and prefer the claim that holds
  everywhere (564).
- A new timing `mark('x')` is pinned in SOURCE order (prepare.ts, then
  run.ts, first occurrence) by `module-shape-drift.test.ts`, in
  `timing.md`'s mark list AND `benchmarks.md`'s sentence, and the list
  item must be a bare `` - `x` `` line — a note after the name hides
  it from the pin (item 601: `planRun` follows `run`, so `plan` sits
  after `close`).
- An `nx:run-commands` target runs from the WORKSPACE ROOT, and the
  mapper's `cd` preserves that: a probe that looks for the command's
  relative output under the package dir finds nothing (item 599).
- A bin a package.json declares must be 100755 in the INDEX, not only
  on disk (`git update-index --chmod=+x`); `tests/bins-executable.unsafe.test.ts`
  holds the law (item 604).
- A stage's SQLite cost is its statement COUNT before its sync mode:
  `synchronous = NORMAL` makes a commit a WAL append, and 3,000
  autocommit writes still cost the cold `load configs` stage 300 ms
  (item 615; 1,000 inserts: 180–240 ms autocommit, 2.5 in one
  transaction). Tally with a `bun --preload` that wraps `bun:sqlite`'s
  statements (`private/vx-bench/sqlite-tally.ts`), and wrap each statement
  object ONCE — `db.query()` returns a cached statement, and a wrapper
  that re-wrapped it per call counted 500,501 executions of one query
  (a WeakSet fixed it).
- A summed span is not a cost: `save: scan` summed 700 ms per 1,000
  saves and removing it bought 60 (item 616) — the span waited on I/O
  the other workers overlapped. A/B the wall, then decide.
- A copied workspace is not the one it was copied from: `cp -a` keeps
  mtimes but not inodes or ctimes, so git's index no longer vouches for
  any file and `git status` re-reads all of them (5k projects: 1.2 s
  against 0.3, 2026-10-17). Run `git update-index -q --refresh` in each
  arm's copy before its first timed rep. And give each arm its own
  `HOME`: the shared store lives in `~/.vx/<repo id>/`, so two copies of
  one repo share it, and arms on different schemas reset it.
- A sandboxed shard has no git: a pin that asks `git ls-files` there
  reads an empty set and its floor fails on darwin CI (item 615). A
  law that reads the tree walks it; git is for the unsafe suite.
- A negative grep is a claim about every spelling: `retry` missed
  `retries`, and a documented upload retry that exists was struck
  from a guide as gone (item 304, corrected in 311). Before calling a
  behaviour absent, grep the word's forms and the constant's name.
- A sweep's fixtures live under `/tmp/vx-*`: the wipe that precedes a
  local row (`rm -rf /tmp/bun-node-* /tmp/vx-*`) raced a running
  sweep's fixture and errored mid-sweep (item 647). Wipe only on an
  idle box. And a row that `skipIf(skipAsRoot(...))` is not driven by
  a root-run sweep: a survivor there is re-driven as `probe` before it
  is called one (647).
- A row titled for several sites drives each of them, or its title
  is a claim the suite lacks: "pending until a read, a prune, a stat
  or close" drove the read, and the sibling flush's three sites had
  one held (items 628, 629). Delete each site's line in turn; a run
  that reaches only one of them (close) makes that one the product.
- A shard run outside the sandbox is not the gate: under vx's sandbox
  `/proc` belongs to another pid namespace (the task is pid 2,
  `/proc/self` names 7), and eight process-lifecycle fixes green on
  bare shards were red in the gate (item 740). Code that reads
  `/proc/<pid>` asks `procfsIsOwn()` first; an agent's bare shard run
  is re-gated sandboxed before it ships.
- Measure what a platform primitive CONSUMES, not only what it
  returns: `Bun.hash.xxHash3(input, seed)` reads 32 bits of its 64-bit
  seed, so a chain that fed each digest in as the next seed carried 32
  bits of state, and two states sharing a low half collided for good
  (item 682). Before chaining through a parameter, prove every bit of
  it moves the output.
- A check-then-remove by PATH is a race: the thing judged can be gone
  and another in its place before the remove lands. Remove by a name
  only the judged thing carries — the run lock unlinks its holder's own
  entry, `h-<pid>-<start>-<n>` (item 759) — and a stress row meant to
  catch the race makes the judged state common (every third taking
  there dies holding), not one per process spawn.
- A test that can reach a self-replacing or host-mutating path runs
  against a COPY of the runtime, never the host's own binary: the
  source-mode `vx upgrade` row spawned `process.execPath`, and a mutant
  of its one guard (`isCompiledBinary()`) downloaded the vx release and
  renamed it over the container's Bun (2026-09-25, item 779). The row
  now copies the runtime into its temp dir, spawns the copy, and
  asserts the copy's digest unchanged, so a broken guard replaces only
  the copy and fails the row.
  The same holds for a DELETE: a sweep mutant of the plugin helper's
  dead-root check removed every entry of the host's `/tmp` (item 846).
  A mutant runs under its own scratch `TMPDIR`
  (`docs/design/mutation-sweeps-2026-09.md`, method 8).

- `Bun.spawn` without `env` hands the child the process's STARTUP
  environment, not `process.env` as a test file has since written it
  (probed on Bun 1.4.2): `signal-handling.test.ts` set
  `VX_KILL_GRACE_MS` at the top and every vx it spawned ran on the 2 s
  default, and one row passed only by a race (item 849). A test that
  sets an env var for a child passes `env: { ...process.env, … }`.
- Two signals sent back to back can land as one: a "second signal"
  row that sent two SIGINTs in a row ran the first-signal path, and
  three mutants of the exit hook it named survived (items 862, 863).
  Send the second once the task has proved it heard the first (its
  `trap … INT` writes a marker).
- An exit hook's list drops an entry only after the cleanup it stands
  for has landed: a release that unlisted the run lock before its async
  unlink and rmdir left the directory to a signal exit in between
  (item 867, macOS CI), and the same shape sat in two more places
  (868). Drive such a window with the async call held pending (a
  mocked `node:fs/promises`), never with a count of microtasks, which
  missed it (868).
- A ready marker a task writes to a declared write path exists before
  the task runs: vx creates a missing write file empty so the sandbox
  can mount it. A probe that waited for such a file to EXIST fetched
  before the server had started, and a bridge "gap" was filed on it
  (item 876). Wait on the marker's content.
- Await a gRPC call's refusal with `.then(ok, err)`, never
  `expect(…).rejects`: under `bun test` the latter held a call that
  needed more I/O until its 30 s deadline, and the same call settled in
  2 ms through `.then` (item 827). The row reads as a client hang.
- A `SCHEMA_VERSION` bump is a contract break (`stored-format.json`):
  title the PR `type(scope)!:` before CI starts. CI reads the title from
  the event that started the run, so a title fixed later needs a new push;
  a re-run reads the old one (#3724).
- A change to a `tests/contract/plugin-api/*.txt` record (an option
  turned required, a method's arguments) is a break too: mark the commit
  `type(scope)!:` with a `BREAKING CHANGE:` footer, and run
  `api-break.unsafe.test.ts` before merging. #4026 and #4029 were not,
  and main went red until a later commit said so. The footer also goes
  into guides/upgrading.md (scripts/upgrading.ts) in the same commit.
- In a `--minify` compiled binary `import.meta.dir` and `import.meta.path`
  are the build machine's source paths, not `/$bunfs/…`: detect the
  binary with `Bun.main`. The run key memo walked a `src/` an installed
  binary does not have, threw, and every warm run lost its short
  circuit; a test only sees it with the source tree gone (#3915 follow-up).
- A task you add or whose inputs you change needs `vx lock` in the same
  commit: CI's `vx lock --check` refuses the run otherwise (#4097 → #4098).
- A task must never remove the root of its own write grant: the Linux
  sandbox mounts that path, so `rm -rf` of it fails with EROFS. Empty it
  in place. A box with no bwrap cannot show this; CI does (#4097 → #4099).
- An A/B of a planner speed-up covers the shapes real runs have, not
  only the shape that found the bug: #4388 proved plans equal and fast
  on tasks of four needs, and with history every task has its own
  (unrounded CPU), where it ran 25x slower than before (#4389,
  2026-10-25).
- A `!` PR's squash message copies the breaking commit's
  `BREAKING CHANGE:` footer word for word: guides/upgrading.md is
  generated from the branch commit and `site-upgrading.unsafe.test.ts`
  holds it to main's squash. #4570's squash reworded it and main went
  red until #4571 regenerated the guide (2026-10-28).
