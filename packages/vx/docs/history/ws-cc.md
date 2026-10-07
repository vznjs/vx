# Workstream CC: cache and remote cache

- **CC-7.** `turboCache()` took only 200 and 202 as a stored upload; a
  Turbo-compatible server answering 201 or 204 stored the artifact while vx
  warned and counted a failed upload. Any 2xx now succeeds, as Turbo's own
  client (`error_for_status`) reads it. Row: turbo-cache-sweep "any 2xx is
  stored, as for turbo; a 3xx or 4xx is not".
- **CC-1.** A refused restore left an empty directory behind when a later
  entry had created a deeper one (`dist/` then `dist/sub/`): abort pruned in
  staging order and tried `dist/` while `dist/sub/` still held it. Abort now
  prunes newest first. Row (`archive-security.test.ts`):
  `abort prunes a created chain whose deeper directory a later entry created`.
