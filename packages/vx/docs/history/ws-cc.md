# Workstream CC: cache and remote cache

- **CC-6.** A workspace reached through a symlink got another repo id (or none, so no shared store): `repoIdOf` walked the logical path. It now walks the realpath, as git does. Row: `repoIdOf` "is one id for every path that reaches the workspace through a symlink".
