# Workstream CC: cache and remote cache

- **CC-5.** A scoped (PR) remote read whose scope-key `get`/`has` threw
  never asked the trusted key, so a trusted hit was lost to a miss.
  `ScopedRemote` now falls through to the trusted key on that error and
  rethrows (warns) only when the trusted key fails or misses too. Rows:
  `cache-scope.test.ts` "a failed scope lookup falls through to the
  trusted key", "a failed scope lookup still warns when the trusted key
  misses too".
- **CC-1.** A refused restore left an empty directory behind when a later
  entry had created a deeper one (`dist/` then `dist/sub/`): abort pruned in
  staging order and tried `dist/` while `dist/sub/` still held it. Abort now
  prunes newest first. Row (`archive-security.test.ts`):
  `abort prunes a created chain whose deeper directory a later entry created`.
