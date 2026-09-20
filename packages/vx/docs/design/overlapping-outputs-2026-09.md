# Two cached tasks, one output path (2026-09-20)

**Status: design only. The implementation stays gated on Next 16's own
condition — a THIRD repository showing the addition shape — and the
rewrite-in-place shape stays refused. What this note adds to the sketch
in STATUS Next 16 is the part that decides whether it is buildable: the
two places vx would have to change, and the one invariant the sketch as
written would break.**

## The shape

Two cached tasks, B depends on A, and both declare the same directory as
their output. Nx caches both; vx leaves the dependent one uncached, and
`@vzn/vx-migrate` resolves the overlap at migration time (item 146).

Two of the five real Nx repositories have it:

- **strapi** — `build` fills `dist`, `build:types` runs `tsc` into the
  same `dist`. B **adds** files A never wrote.
- **refine** — `build` is `tsup && node ../shared/generate-declarations.js`
  and `types` is that second half again, so B **rewrites** A's `.d.ts`
  files with identical bytes and new mtimes.

Only the first is in scope. The second is why the scope line exists, and
§ Why the rewrite stays refused says what it would cost to admit it.

## What blocks it today

`execute-task.ts` removes a task's declared outputs before it runs and
before it restores. That is not incidental: a restore that merged into a
dirty tree would replay a mixture of two runs, which is the stale-hit
class — the worst failure class this repository has. So B's clean would
delete the `dist` A just filled, and B's artifact would carry A's files
as if they were B's.

## The design

When B's declared outputs overlap a transitive upstream A's, and B
depends on A:

1. **B's own output set is what its run ADDED or CHANGED.** Snapshot the
   overlap before B runs, diff it after. The proof is size + mtime — the
   same proof the hit path already trusts for a current tree
   (`docs/caching.md` § A current tree), so no new trust is introduced.
2. **B's clean removes only that set**, leaving A's files where they are.
3. **B's artifact holds only that set**, so restoring B into a tree A has
   already filled reproduces exactly what B's run produced.
4. **The restore order follows the edge**: B is restored only after A is
   on disk.

Cost: one stat walk of the overlap per B miss, none on a hit.

## The invariant the sketch would break

Point 4 is not free, and the sketch does not say what it costs. A
confirmed stable-key local hit is **restore-tier**
(`src/graph/scheduler.ts`): it becomes ready immediately, because "a
stable hit's restore needs none of its deps' output". An
overlap-narrowed artifact breaks that premise by construction — it is
exactly an artifact that needs its dep's output already on disk.

So the design needs a second stability axis. Today's gate
(`src/orchestrator/stable-keys.ts`, `dependsOnSiblingOutputs`) asks
whether an upstream writes where this task READS. The overlap case is
about where this task WRITES. The two do not coincide:

- **Same project** (strapi, refine): already covered by accident of the
  conservative gate — `upstreamOutputProjects.has(node.projectName)`
  makes any same-project dependent of an output-declaring task unstable,
  so B is not restore-tier and not prefetched. The shape the design
  targets is safe today for the reason the gate exists, not for this one.
- **Cross project**: B's project-relative outputs land in B's own
  directory, so an overlap requires root-anchored (`workspaceFiles`)
  outputs on one side. A `workspaceFiles` producer upstream already
  forces instability. A `workspaceFiles` WRITER — B writing into A's
  directory — does not: B's key is unaffected by its own outputs, so B
  can be stable, restore-tier, and restored before A has run. **That is
  the case the implementation must exclude explicitly**, in the same
  function, or an overlap-narrowed artifact will be restored into a tree
  that has nothing to merge with.

A pin for that exclusion belongs in `tests/local-shortcircuit*.test.ts`
beside the existing stability rows, and it should fail without the
exclusion — a cross-project `workspaceFiles` writer whose narrowed
artifact restores early is a partial tree under a green run.

## Why the rewrite stays refused

refine's `types` ADDS nothing: it rewrites A's `.d.ts` files with the
same bytes and new mtimes. Under the design above B's own set is empty
(same size, same content), but the proof is size + mtime, so the next
run finds A's outputs moved and restores them — a restore where there
was nothing to restore, every run.

Admitting it needs one of:

- **Content comparison for files a downstream task touched** — a hash per
  overlapped file, which is the cost the mtime proof exists to avoid.
  Bounded by the overlap rather than the tree, so it is not obviously
  unaffordable; it would need a measurement before anyone believes it.
- **Or the status quo**: only additions are admitted, a rewrite-in-place
  keeps the dependent uncached, and the migrator keeps saying so.

The second is what ships until a repository makes the first worth
paying for.

## What would have to be true to build it

1. A third repository shows the ADDITION shape (Next 16's own gate; the
   two known repositories are one of each, which is not a pattern yet).
2. The exclusion above lands first, with its failing-without-it pin —
   a narrowed artifact is only safe once it cannot be restored early.
3. The snapshot/diff lands in `execute-task.ts`'s clean + save path,
   where `cleanOutputs` already returns the paths it removed and already
   marks them in the git files cache; the narrowed set flows to the same
   two places.
4. A stale-hit test proves the composed case: A hit + B miss, A miss + B
   hit, both hit, both miss, and a B whose run adds nothing — each
   leaving a tree byte-identical to a cold run of both.

Until (1), this note is the record of what the sketch costs, so the next
reader does not have to re-derive the restore-tier conflict.
