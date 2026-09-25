# Persisted stable keys — design

> **Decision (owner, 2026-09-25, item 756): DEFERRED.** The design below
> holds, and its prototype saved 13–21 ms at min of a 476-package warm run.
> It is not built now: the saving exists only on an exact-repeat run (a run
> after any edit pays today's cost plus about 1 ms), part of it reappears
> in `run graph` (the unstable keys lose their warm memos), and a digest
> that misses an input is a stale hit on every run rather than a rare one,
> the worst failure class this project has, on a path where vx already
> leads the warm column. Every future key input would also have to extend
> the coverage law. Revisit when the warm no-op is the gap that matters
> (a measured loss to another runner, or an agent loop whose repeat runs
> dominate), and then land it only through the gate in the Verdict.

> **Status:** proposal (2026-09-25). Verdict: **ship-limited**, and only if the
> landing gate in the Verdict section holds. The code read is main at `7ee7fa27`. Paths are relative to
> `packages/vx/`.

## What we're solving

On a warm no-op run (476 packages, 952 tasks, all hits) `deriveStableKeys`
(`src/orchestrator/stable-keys.ts:49`, called from `local-shortcircuit.ts:104`)
re-derives every task's key from scratch before the schedule starts. It shows as
a 36 ms `stable keys` span (source run, `VX_TIMING=1`). STATUS Next 21 proposed
persisting last run's `{taskId → key}` under one digest of everything the keys
read, estimating 25 ms saved. The job is to show it can be made correct and to
measure what it really saves.

## Access pattern

- One call per run, JIT-cold, serial, before `runGraph` (`run.ts:605-617`), and
  only when `shouldShortCircuit` passes (`run.ts:159`: no remote layer, local reads on).
- Output: `StableKey[]` for the stable, cacheable tasks. `execute-task.ts:450-453`
  reuses `preProbed.hash` **as is**, and a hit restores with no re-check
  (`:518-527`). A wrong memoised key is therefore restored on a green run.
  743's re-check (`:906-917`) runs only on a miss.
- In the bench shape, `test` depends on its own project's `build`, which
  declares outputs, so all 476 `test` tasks are **unstable**. They are keyed
  again lazily at execute (476 `cache.get`s in the span table). The memo cannot
  cover them, because their keys are preliminary.

## Every input the stable keys and the classification read

"Digest" says how the memo captures each input. **All inputs but three are
values the run already holds before the short-circuit.**

| #   | Input                                                                                                                        | Enters at                                                                              | Digest capture                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Graph shape: `node.id`, `projectName`, `projectDir`, `deps` (order), group-ness                                              | `stable-keys.ts:112-195`, `upstream.ts:19`, `task-hash.ts:254-272`                     | fold per node, in `nodes` Map order                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | Resolved task config (key: `hashableConfig`; gate: `cache.*`, `exec.sandbox.allow.write`, `exec.persistent`, `inputs.tasks`) | `task-hash.ts:286,329-364`; `stable-keys.ts:96,131-149,304-333`                        | `xxh3(JSON.stringify(node.config))`, the **full** config (a superset of `hashableConfig`). Configs are JSON data (item 701). This also seeds `hashCache.taskConfig` when `exec.remote` is unset                                                                                                                                                                                                                                                 |
| 3   | `node.requested` + `forwardArgs`                                                                                             | `task-hash.ts:294`                                                                     | fold both                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | Plugin `key` parts                                                                                                           | `prepare.ts:408-410` → `plugin-host.ts:170`; `task-hash.ts:311`                        | fold `node.keyParts`, already computed. Plugin code runs live each run                                                                                                                                                                                                                                                                                                                                                                          |
| 5   | Workspace fingerprint (the unclaimed lockfile digest)                                                                        | `prepare.ts:229-234`; `key-fold.ts:114`                                                | fold the string                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6   | Env values of `cache.inputs.env` names                                                                                       | `inputs.ts:202,337` (`process.env`)                                                    | fold the sorted union of names across nodes as `name\0value`, with unset distinct from `''`                                                                                                                                                                                                                                                                                                                                                     |
| 7   | `HOME` (via `expandHome` in a write grant)                                                                                   | `sandbox-request.ts:497,517`                                                           | fold `HOME`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 8   | `inputs.runtime` / `workspaceRuntime` output                                                                                 | `inputs.ts:186-199,354` (a spawn)                                                      | **compute and fold** through `hashCache.runtime`, the same memo the run uses. It is asked once per run, as today. A failure bypasses the memo                                                                                                                                                                                                                                                                                                   |
| 9   | Nested project dirs (boundary globs)                                                                                         | `prepare.ts:279-281`; `inputs.ts:830,1025`                                             | fold `nestedDirsByProject`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 10  | `workspaceRoot` (`relOf`, `dirByProject`, reach tests)                                                                       | `key-fold.ts:224`; `stable-keys.ts:105-110`                                            | fold it. A `--cache-dir` may be shared across clones                                                                                                                                                                                                                                                                                                                                                                                            |
| 11  | Index OIDs + tracked/untracked set + skip-worktree flags                                                                     | `git-inputs.ts:752` (`ls-files -s -v`), `:753` (`status -uall`), `:819-830`            | `xxh3` of the two raw stdouts, the pathspecs and the git prefix (`:802`). Measured 0.02 ms for 118 KB                                                                                                                                                                                                                                                                                                                                           |
| 12  | **Content of every enumerated path without a trusted OID** (untracked, dirty, deleted, skip-worktree, clean-filter-dropped)  | `inputs.ts:915` (`isInputOnDisk`), `key-fold.ts:221` (`hashFile`, `file-hashes.ts:67`) | **the set U = all − trusted.** Fold `(path, lstat kind, hashFile)` for each path in U through the batched `hashFiles` (one `IN` query). `git status` names a dirty file but does not carry its bytes, so this input is the trap in #11. The facts come from the same memo as the key, so the trust is the same                                                                                                                                  |
| 13  | Clean-filter gate: `var -l`, attribute files outside the tree, `info/attributes`, `.gitattributes` above, `check-attr`       | `git-inputs.ts:423-477` (these are **disk** `existsSync`s, not git output)             | captured through #12, because every OID the gate drops moves its path into U. A new `~/.config/git/attributes` changes U                                                                                                                                                                                                                                                                                                                        |
| 14  | Project `package.json` digest (a trusted OID, or `exists` + `hashFile`)                                                      | `task-hash.ts:397-424`                                                                 | call `hashProjectPackageJson` per project into `hashCache` (a map hit when clean) and fold the result. This also covers a gitignored `package.json`, which #11 and #12 cannot see                                                                                                                                                                                                                                                               |
| 15  | Key derivation code: `CACHE_VERSION` (`key-fold.ts:90`), `ALWAYS_IGNORE`, glob semantics, the gate's rules                   | all of the above                                                                       | fold `KEY_MEMO_VERSION`, `CACHE_VERSION`, `VERSION`, `Bun.revision` and a **build identity**: a compiled binary gives the `lstat` of `process.execPath` (dev, ino, size, mtime, ctime). A source run gives the lstat identities of every file under core `src/` (137 files, about 0.4 ms). `VERSION` stays constant between releases, and a self-healing key fix bumps no `CACHE_VERSION`, so without this a dev box keeps serving pre-fix keys |
| 16  | The cache layer's `key()`                                                                                                    | `task-hash.ts:105`; `chained-cache.ts:41`, `layered-cache.ts:229`                      | **cannot be captured**: a plugin layer runs its own code. Bypass unless `cache === localCache`                                                                                                                                                                                                                                                                                                                                                  |

**Inputs the digest cannot capture without doing the work it is meant to skip:**

- **A.** A project with no git partition (a submodule, a nested repository;
  `git-inputs.ts:918`) makes `resolveFiles` spawn `git ls-files` in that project
  (`inputs.ts:859-874`). Bypass when any node's `projectDir` has no
  `gitFilesCache` entry.
- **B.** Unmatched literal inputs: `assertNoInvisibleLiteralInputs` lstats a
  gitignored path (`inputs.ts:749-765,904-906`). No git output sees it.
  Principle 9 and item 738 apply: a refusal is never decided from a memo. The
  deriving run records the literals it probed (a `hashCache.absentLiterals`
  collector filled at `inputs.ts:905` and `:298`) and persists them with the
  keys. A memo hit lstats each one, and **any that now exists bypasses the
  memo**, so the derivation raises the refusal as it does today. With a matched
  digest the enumeration is identical, so the probed set is identical too.
- **C.** Undecodable names (`inputs.ts:798-813`, readdir on disk): bypass when
  the enumeration has any (`git-inputs.ts:850`).
- **D.** `--exclude-dependencies` puts live keys on `node.excludedUpstream`
  (`prepare.ts:411-428`): bypass.
- **E.** A large U (a repo that does not ignore `dist/`) costs about 3 µs per
  path: bypass above `KEY_MEMO_MAX_UNTRUSTED = 1024`. With a failed `git
status`, every path is untrusted, so the run always bypasses.

None of A–E kills the idea. They are rare shapes, and each one falls back to
today's derivation.

## Which runs bypass the memo (they derive as today, and write nothing)

Any run without `shouldShortCircuit`: `--force`, `--cache=local:w` or
anything without local read, or any remote layer. The remote prefetch keeps
calling `deriveStableKeys` directly. Also bypassed: a `cache` other than the bare `localCache` (#16), inputs A–E,
a runtime-input failure, and a missing, unparsable or wrong-`v` memo row.
**These run the memo unchanged:** unstable tasks (never in the memo; they are
keyed lazily as today), persistent tasks (never keyed), plugins with `key`
hooks (#4 is a value), and the in-run-write edges of items 743 and 750.
Those edges act **after** the up-front keys. The watch (`fingerprint-watch.ts`),
`markOutputsChanged` / `markUnsaved`, `movedInput` and `RestoreDemoted` all
see exactly the `(key, stable)` set the derivation would have produced. The
"cached task may write undeclared" decision is about keys taken at run start,
which is what the memo reproduces.

## Invalidation argument (proof sketch)

1. `deriveStableKeys` is a deterministic function F of the values S it reads:
   rows 1–16 of the table, plus the disk facts of A–C. It reads no clock (the
   `Date.now` in `describeTaskInputs` is off this path) and no randomness.
   `hashFile`'s memo returns the same digest the derivation would compute at the
   same instant.
2. Let S' be S with the enumeration's raw bytes in place of its parsed maps.
   The trusted OID map is a function of rows 11 and 13, and every untrusted
   path's fold value is in row 12, so S' determines every file digest F folds.
   The code identity (row 15) fixes F itself.
3. The memo stores `(D(S'_A), F(S_A), probedLiterals_A)`, written by a run
   whose derivation succeeded.
4. At run B: if the gates hold, the literals are still absent, and
   `D(S'_B) = D(S'_A)`, then `S'_B = S'_A` barring an xxh3-64 collision
   (about 2^-64 per compare, the same order as the key itself). The disk facts
   of A–C are equal, being either bypassed or re-checked. So `F(S_B) = F(S_A)`,
   and every persisted key and every stable/unstable label is the one a fresh
   derivation would give.
5. Everything downstream consumes that set exactly as today.

**Failure mode if an input is missed.** The memo returns the key of an earlier
state. That key was a hit or a save in that state, so an entry exists under it,
and the stale hit is **guaranteed**, on every run until the digest moves. A
digest gap turns a rare race into a deterministic replay of wrong bytes. That
is why the coverage law and the verify oracle below are part of the design,
not optional extras.

## Concrete spec

- `src/cache/git-inputs.ts`: `GitEnumeration` gains `digest: string` (xxh3 of
  pathspecs, prefix, `ls` stdout, `status` stdout) and `untrusted: string[]`.
  `undecodable` is already there.
- `src/orchestrator/key-memo.ts` (new):
  `memoDigest(args): Promise<string | null>` (null means bypass) and
  `readStableKeys` / `recordStableKeys`. It keeps one table `COVERAGE` that
  names, for each `CacheKeyInput` field and each gate read, its digest component.
- `src/cache/cache.ts`: an additive `key_memo(digest TEXT PRIMARY KEY, payload
TEXT NOT NULL, used_at INTEGER NOT NULL)` created in its own `exec`, like
  `config_evals` (`:421`), plus an entry in the reset `DROP` list (`:407`).
  No `SCHEMA_VERSION` bump: older binaries ignore the table. Keep the newest 8
  rows, pruned on insert, so alternating commands do not thrash. Payload:
  `{"v":1,"keys":[[taskId,hash],…],"absentLiterals":[…]}`. `KEY_MEMO_VERSION`
  is folded into the digest and also checked against `v`.
- `local-shortcircuit.ts:104`: compute the digest. On a hit, map ids to nodes
  (a missing id throws, which is the existing catch → `EMPTY`). On a miss,
  derive, then write one row in one statement, after the derivation and
  off the hit path.
- `VX_KEY_MEMO_VERIFY=1` is a test oracle, not a feature flag. On a hit it
  also derives, and throws on any difference in ids, keys or labels. The gate's
  shards and CI set it, so **every fixture in the suite becomes a
  differential**.

## Measured budget (476 packages, bench generator, Linux, 4 cores, Bun 1.4.2)

| Item                                                                                                                                                         | Cost                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `deriveStableKeys`, first call in a fresh process                                                                                                            | 30–57 ms (35 typical); 15–20 ms once the JIT is warm, so much of the cost is first execution |
| Of that, file resolution (`resolveInputs` over 952 tasks)                                                                                                    | 10–12 ms                                                                                     |
| Digest parts, first call: configs JSON+xxh3 (1,428 nodes) 0.4–1.1; graph/keyParts fold 0.4–0.8; env 0.1–0.3; package.json 0.2–1.7; git stdout hash 0.02–0.05 | **about 2–4 ms total**                                                                       |
| Memo row read + parse (16.7 KB, 476 keys)                                                                                                                    | about 0.5 ms                                                                                 |
| Work that **moves** to the lazy path: 476 unstable keys lose the warm `projectFiles` / `taskConfig` memos and the JIT warm-up                                | +7–10 ms (measured in-process: lazy 6–10 → 14–20 ms)                                         |

**Wall, compiled binaries, interleaved, one pre-warmed workspace copy per arm**
(prototype: skip the derivation and read the keys from a file after computing
the digest parts). Base against memo, min/median in ms:
230.5/263.6 → 213.6/243.3 (N=21); 212.5/248.9 → 199.9/241.7 (N=21);
217.2/251.6 → 198.2/237.5 (N=31); 219.7/262.5 → 198.5/237.0 (N=30).
**The saving is about 13–21 ms at min and 7–25 at median, not 25–30.** Stage
view: `classify + probe` 42–53 → 15–17 ms, while `run graph` grows 51–59 → 77–113.
The saving survives, at about half the estimate, in this shape. In a
workspace whose tasks are all stable it approaches the full derivation.

At scale (1,000 projects, 3,270 tasks, 30k files), expect the digest to cost
about 4–5 ms: ls bytes about 0.3, configs about 2–3, the row about 1. That is
against a derivation item 750 measured at 27 ms median, memoised.

**Refuted alongside:** skipping the key computation for tasks already known
unstable inside the derivation. It is sound: no stable key folds an unstable
one, because instability is inherited. It moved no wall: 224.5/263.1 and
220.5/255.4 against base 233.7/262.6 and 219.7/262.5. The work only moves to
the lazy path.

## Test plan

1. **Differential rows.** Each changes one input alone. The run after the
   change must (a) miss the memo and (b) produce the keys and hit/miss outcome
   of a memo-off run. Each row must fail with that input's fold deleted.
   - A committed edit.
   - **Two successive dirty edits with identical `status` output.**
   - An untracked add, then **an untracked edit**.
   - A tracked file deleted.
   - A file replaced by a symlink; a symlink retargeted.
   - An edit to a skip-worktree file.
   - `* text` added in `.gitattributes` with a CRLF edit, and the same through
     `XDG_CONFIG_HOME/git/attributes`, which is outside the tree.
   - A gitignored `package.json` edited.
   - An env value changed, and unset against `''`.
   - `HOME` changed under a `~/` write grant, which flips the stable label, not
     the key.
   - `forwardArgs` changed; the requested set changed.
   - An impure config that reads env with unchanged bytes.
   - A plugin key part read from env.
   - A lockfile edit.
   - A runtime command's output changed.
   - A nested project added.
   - The workspace copied elsewhere with a shared `--cache-dir`.
   - A core source file touched (a source run); a binary swapped.
   - Bypass rows, each asserting that derivation ran:
     - partitionless project (edit inside a nested repository);
     - gitignored literal created (the run must refuse with `toBe` on the
       message, exactly as memo-off);
     - undecodable name;
     - a decorator cache layer;
     - `--exclude-dependencies`;
     - U of 1,025 files.
   - Controls: an exact repeat hits the memo (`VX_TIMING` shows no `stable keys` span), and a dirty-but-unchanged repeat hits too.
2. **Coverage law** (`tests/key-memo-coverage.test.ts`). Parse the fields of
   `CacheKeyInput` from `src/cache/layer.ts:9`, the source of truth, plus
   `resolveKeyInput`'s return object (`task-hash.ts:296-313`). Assert they
   equal `COVERAGE`'s keys in both directions, duplicates included. A new key
   input then cannot land without a digest component and a row.
3. **Oracle.** The whole core suite runs with `VX_KEY_MEMO_VERIFY=1` in the
   shards. Remove the oracle line and prove a planted digest gap reddens
   it.
4. **Mutation sweep** of `key-memo.ts` and the new enumeration fields, per
   `docs/design/mutation-sweeps-2026-09.md`. Neutralise each fold line and
   each bypass. Every one must be CAUGHT by a row from item 1.
5. **A/B** (principle 1). Build compiled binaries, with "before" from an
   immutable `git worktree`. Use one workspace copy per arm, pre-warmed by that
   arm, and interleave with N ≥ 21, reporting min and median. Shapes: 476
   (`vx-bench/generate.ts`), 1,000 projects, the 3,270-task bench, a
   dirty tree with 50 untracked files, and an **edited-one-file** run (a memo
   miss must cost at most 1 ms more than today, for the digest plus one INSERT).

## What's out of scope

- Memoising unstable tasks' keys: they fold upstream outputs.
- Per-project or incremental re-derivation (re-keying only what moved). That
  is a different and larger design.
- The remote-prefetch path, and plugin cache layers.
- Speeding up the derivation's JIT-cold first call.
- CI cold checkouts, which have no memo row unless the cache dir is restored.

## Open questions

- Is `Bun.revision` enough for glob and xxh3 behaviour, or should
  `Bun.version` be folded too? (Fold both; it costs nothing.)
- Should the 8-row cap be measured against `vx watch`'s cycle mix?

## Verdict: ship-limited

- **It can be made correct.** Everything the keys read is either a value
  already in hand (rows 1–10, 14), git output the run already holds (rows
  11 and 13), or the untrusted set U, which costs what the derivation pays
  for those files anyway (row 12). The rest is re-checked (B) or bypassed
  (A, C, D, E, row 16).
- **The saving is real but modest:** about 15–20 ms of about 200 ms wall (7–10%),
  only on **exact-repeat** runs (a no-op rerun, an agent loop, a watch cycle
  with nothing changed). A run after any edit pays today's cost plus about
  1 ms.
- **The cost is permanent.** A second path to the keys whose failure mode is
  a deterministic stale hit. That is justified only with the coverage law and
  the suite-wide oracle, and they are part of the scope, not follow-ups.
  Estimate 300–400 lines plus about 35 rows.
- **Landing gate:** the whole suite is green under `VX_KEY_MEMO_VERIFY=1`,
  every mutation is caught, and the compiled 476 A/B holds at least 10 ms
  at min-of-21. If the A/B comes in under 10 ms, **reject** and record it in
  STATUS: a stale-hit-critical path is not worth less than 5% of a no-op.
