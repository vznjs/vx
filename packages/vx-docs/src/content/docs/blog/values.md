---
title: 'Performance, modularity, extensibility. In that order.'
date: 2026-09-10T23:56:00Z
authors:
  - vzn
tags:
  - values
  - design
excerpt: "Every design decision in vx is settled by three drivers in a fixed order, and eight principles that follow from them. This is the list, with what each one has already cost and what it has bought."
---

Most projects have values in the sense of a paragraph on the README.
vx has them in the sense of a tie-breaker: when two designs are both
reasonable, the one that scores higher on the earlier driver wins, and
the decision is not reopened. The drivers, in order:

1. **Performance.** Measured, not asserted.
2. **Modularity.** Each module's `index.ts` is its contract; cross-module
   imports go through it and a test enforces that.
3. **Extensibility.** A seam for every stage; a plugin for everything
   distributed.

The order matters because it says what loses. A seam that costs a
millisecond on the warm path when no plugin fills it is not added; the
zero-cost gate is added first. A module boundary that would force a
copy of a hot loop is redrawn rather than crossed.

## The eight principles

**Perf first.** Measure before and after. A/B arms interleaved,
min-of-N, the "before" arm in an immutable git worktree, one workspace
copy per arm pre-warmed by that arm. A change to the warm path without
a number is not done. This has killed features that felt obviously
good: lookahead scheduling was measured against the plain critical-path
priority and lost, so it is on the rejected list.

**Explicit over magical.** Caching is opt-in; `cache.inputs.files` is
required; nothing is inferred. The sandbox is how a task proves what it
touches. [The argument](../explicit-over-magical/) is that an
under-declared input is the worst failure a cache can have, and
inference produces exactly that kind.

**One command per task; the shell is the API.** A plugin changes where
a command runs, never what it is. There are no JavaScript-function
tasks and no executors wrapping tools behind options objects. Your
tools stay yours and their documentation stays correct.

**Resolved-config hashing.** The key sees the evaluated config object,
so imports, presets and computed values participate. Named inputs and
global inputs are rejected because a TypeScript config composes without
them.

**Cascade through deps by folding upstream input keys, never outputs.**
Every key is knowable before anything runs, which is what `--dry`,
remote prefetch, the restore tier and remote execution all stand on.
[Early cutoff was tried and reverted](../cascade-through-inputs/).

**Project boundaries are hard.** A glob never crosses into another
project. What a project needs from another arrives through the graph.

**No defaults.** Core names no plugin. Only the local floor is
implicit. A capability a plugin must supply is declared in
`vx.workspace.ts` or it does not exist. This is the principle that
keeps vx from quietly becoming a product: there is no built-in remote
anything to grow a business model around.

**Seam over special case.** When core grows a branch for one consumer,
the seam is too narrow. `vx prune` and the history-based scheduler both
left core for their own packages once the seam they needed existed.

## The rejected list

Some things are written down so they are not re-proposed by the next
person with a good afternoon: named inputs and global env; auto-input
inference via tracing; folding `NODE_OPTIONS` into the key; lookahead
and idle-insertion scheduling; a first-party platform, dashboard, agents
or cloud; Turbo's remote-cache wire in core; HTTP/3. Each was either
measured and lost, or conflicts with a principle above. The list lives
in the repository's own memory file, next to the principles, where a
contributor reads it before writing code.

## Rules learned the hard way

The values above are the design. These are the scars, kept as rules:

- Repro before fix, and record what a probe refutes too.
- Every fix must fail without itself. A test that passes with the fix
  reverted is not a test of the fix.
- A skip is a silent pass. Gate on an env var CI sets.
- Assert the exact expected set, not the absence of one string.
- A comment claiming a guarantee the code lacks is a defect: de-claim
  or implement.
- A timed wait in a test is a claim about time; prove it with the
  shortest window that still fails without the fix.
- A feature is not done until its docs land in the same commit.

None of that is unusual advice. What is unusual is that it is enforced
in the repository the way a lint rule is, and that the tool's own test
suite is run by the tool, under its own sandbox, on every commit.
