# Workstream CC: cache and remote cache

- **CC-5.** A scoped (PR) remote read whose scope-key `get`/`has` threw
  never asked the trusted key, so a trusted hit was lost to a miss.
  `ScopedRemote` now falls through to the trusted key on that error and
  rethrows (warns) only when the trusted key fails or misses too. Rows:
  `cache-scope.test.ts` "a failed scope lookup falls through to the
  trusted key", "a failed scope lookup still warns when the trusted key
  misses too".
