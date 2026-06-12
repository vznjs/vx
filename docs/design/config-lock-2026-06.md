# Config lock — `vx lock` / `vx.lock` (2026-06)

Status: **shipped**.

## Problem

vx configs are programs (`vx.config.ts` is evaluated, not parsed).
That is the source of vx's "resolved-config hashing" power — imports
and computed values participate in cache keys — but it has two costs:

1. **Eval time.** Evaluating ~1000 configs costs ~200 ms, the dominant
   fixed cost of small runs (scoped loading already trims this to the
   dep closure; the lock removes it entirely for locked projects).
2. **Eval-time nondeterminism.** A config that reads `process.env.X`
   resolves to different objects in different environments. File
   hashes are blind to this: the bytes on disk never changed.

`vx lock` makes the resolved configs explicit, reviewable state: a
single JSON file freezing "what this workspace's tasks ARE".

## Relation to the rejected eval cache

A resolved-config **eval cache** (transparently cache pure-literal
configs on content hash) was designed and REJECTED in June 2026: its
static purity gate was correctness-critical heuristic machinery. The
lock is the sound dependency story that rejection asked for:

- **Explicit, user-invoked.** Nothing is cached behind the user's
  back; `vx lock` is a deliberate act, like `pnpm install` writing a
  lockfile. No purity heuristics — the user asserts "this resolution
  is the truth" and owns when to refresh it.
- **Hash-pinned + hard-fail.** A changed config file is a loud error,
  never a silent stale replay.
- **Auditable.** `vx lock --check` re-derives the truth from scratch
  and diffs it.

## Format

`vx.lock` at the workspace root:

```json
{
  "version": 1,
  "projects": {
    "<package-name>": {
      "configPath": "packages/app/vx.config.ts",
      "configHash": "<xxh3 hex of file bytes>",
      "config": { "tasks": { ... } }
    }
  }
}
```

- `config` is the **resolved** (post-evaluation) `ProjectConfig`,
  JSON-normalized (a `JSON.stringify` round-trip drops `undefined`
  fields, so the stored form equals what a later read produces).
- Entries are sorted by project name (stable diffs).
- Only project configs are covered. `vx.workspace.ts` is not locked:
  it holds `concurrency` / `cacheDir` only, neither of which
  participates in cache keys or task semantics.

Implementation: `src/workspace/lockfile.ts` (format, read/write,
run-time verification), `src/cli/lock.ts` (subcommand), one hook in
`src/orchestrator/prepare.ts` (run-time load path).

## Semantics

### `vx lock` (write)

Discovers the workspace, **freshly evaluates** every config-bearing
project's config in the current environment (a per-invocation cache
bust bypasses Bun's module cache, which would otherwise replay an
evaluation made under earlier env values in the same process), and
writes the lock. Exit 0.

### Runs (`vx run`, `vx watch`, `--dry` / `--graph`) — TRUST

When `vx.lock` exists, `prepareRun` loads each in-scope project's
config **from the lock** after a content-hash check of the config
file. **No evaluation happens** — frozen-env semantics: a config that
read `process.env.X` at lock time keeps the locked value no matter
what `X` is at run time.

Hash-only verification, hard failures (`UserError`, exit 1):

| condition                                         | outcome                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| file hash matches lock entry                      | frozen config used, eval-free                                    |
| config file changed since lock                    | `vx.lock is stale: <path> changed since \`vx lock\` (<project>)` |
| project has a config but no lock entry (or moved) | `vx.lock has no entry for "<project>"`                           |

There is deliberately **no silent fallback to evaluation**: the lock's
contract is "what runs is what was locked". Falling back would
reintroduce exactly the env-dependence the user locked against. The
frozen config is still shape-validated on load — `vx.lock` is a
hand-editable file, i.e. a system boundary.

Cache-key interaction: keys hash the resolved config object (principle
"resolved-config hashing"), so frozen configs simply pin the hashed
object. Key derivation is untouched — **no CACHE_VERSION bump**.

### `vx lock --check` — AUDIT

`--check` is strictly stronger than run-time verification. Per
config-bearing project:

1. **The run-time hash check** (file bytes vs `configHash`); a
   mismatch reports `config file changed since lock (<project>)`.
2. **Full re-evaluation in the current environment** (fresh, module
   cache bypassed), JSON-normalized, then `Bun.deepEquals(fresh,
stored, /* strict */ true)`. A mismatch reports:

   ```
   lock differs from fresh evaluation in this environment (<project>) —
   env-dependent config? run 'vx lock' here or remove env reads from config
   ```

Plus set-level drift: projects missing from the lock, and locked
projects that no longer exist in the workspace. Any failure → every
mismatched project is listed on stderr, exit 1. Clean → exit 0.

## The asymmetry, explicitly

**Runs trust the lock; `--check` audits it.**

- **Run-time verification is hash-only — fast and eval-free.** That is
  the entire point of the lock on the hot path: zero config evaluation
  per run, and _frozen-env semantics_ — the run's behavior cannot
  drift with the environment because the environment is never
  consulted. Re-evaluating on every run to "verify" would (a) pay the
  eval cost the lock exists to remove, and (b) be self-defeating: in
  an environment where evaluation resolves differently, the frozen
  value is the _intended_ one, not an error.
- **`--check` re-evaluates and deep-compares.** It answers a different
  question — not "is the lock internally consistent with the files?"
  (hashes answer that) but "would locking _here, now_ produce the same
  truth?" Only evaluation can answer it, because eval-time env-var
  drift leaves file bytes — and therefore every hash — unchanged.

Intended workflow: run `vx lock --check` where environments are
supposed to agree (CI gate, post-checkout hook). A failure means the
lock was produced under assumptions this environment violates — either
re-lock here on purpose, or remove the env read from the config (move
it to `exec.env` / `cache.inputs.env`, which are run-time surfaces the
cache key tracks properly).

## Known limits

- `vx watch` with a lock: editing a config mid-watch fails the next
  cycle with the stale-lock error until the user re-locks (or deletes
  the lock). Consistent with "no silent fallback"; the error message
  says exactly what to do.
- The lock does not cover `vx.workspace.ts` (see Format).
- `--check`'s re-evaluation runs config code; like any vx invocation
  it assumes configs are trusted code in the repo.

## Tests

`tests/lock.test.ts` (e2e, real CLI subprocesses — env drift is
cross-invocation by nature):

1. The mandated drift scenario: config reads `process.env.X`; lock
   under `X=a`; `--check` under `X=a` → 0; `--check` under `X=b` → 1
   naming the project; `vx run` under `X=b` → 0 with the frozen
   `flavor-a` output.
2. Stale file: edit config after lock → `--check` exits 1
   (file-changed), `vx run` hard-fails with the stale-lock error,
   re-lock heals both.
3. `--check` with no lock present → exit 1, points at `vx lock`.
