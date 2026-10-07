# Workstream CC: cache and remote cache

- **CC-3.** An input glob whose brace alternative ended in `**`
  (`{src/**,lib/**}`) matched only one level below: `Bun.Glob`'s match
  reads that `**` as one name, so `src/deep/a.ts` stayed out of the key
  and an edit to it was a stale hit. `taskGlob` and `anyTaskGlob` now
  expand every brace and match its alternatives. Rows:
  `brace-inputs.test.ts` "a brace alternative ending in \*\* folds files
  below its first directory", `util-paths.test.ts` "a brace alternative
  ending in \*\* matches below its first directory".
