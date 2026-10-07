# Workstream CC: cache and remote cache

- **CC-6.** A workspace reached through a symlink got another repo id (or none, so no shared store): `repoIdOf` walked the logical path. It now walks the realpath, as git does. Row: `repoIdOf` "is one id for every path that reaches the workspace through a symlink".
- **CC-1.** A refused restore left an empty directory behind when a later
  entry had created a deeper one (`dist/` then `dist/sub/`): abort pruned in
  staging order and tried `dist/` while `dist/sub/` still held it. Abort now
  prunes newest first. Row (`archive-security.test.ts`):
  `abort prunes a created chain whose deeper directory a later entry created`.
