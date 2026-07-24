// Trunk-vs-branch axis for the scheduling baseline (owner 2026-07-14: "I can be
// experimenting on a branch increasing task time for all later on… take into
// account PRs, and don't count their times into main"). A run whose `branch`
// equals `default_branch` is a TRUNK run; every PR / feature-branch run has a
// head branch that differs, so filtering the duration-hint baseline to
// `branch = default_branch` keeps a transient experiment's slow timings out of
// the shared LPT hint that main (and every other dev's distributed run) relies
// on. Nullable + additive: the client sends null when the default branch is
// undetectable (a detached checkout, a non-repo local run), and the hint query
// falls back to counting all runs, so an old client / unknown default never
// regresses. ADD COLUMN on the partitioned parent cascades to every partition.

export const sql = `
ALTER TABLE invocations ADD COLUMN default_branch text;
`
