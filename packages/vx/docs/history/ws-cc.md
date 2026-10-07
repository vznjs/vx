# Workstream CC: cache and remote cache

- **CC-10.** `nxCache()`: a GET answered 403 warned "a read-only token cannot write" — that branch only ever sees a GET, so the cause was always false. It now says the token may not read. Row: `nx-cache-sweep.test.ts` "a GET answering 403 says a read was refused, not a write".
- **CC-1.** A refused restore left an empty directory behind when a later
  entry had created a deeper one (`dist/` then `dist/sub/`): abort pruned in
  staging order and tried `dist/` while `dist/sub/` still held it. Abort now
  prunes newest first. Row (`archive-security.test.ts`):
  `abort prunes a created chain whose deeper directory a later entry created`.
