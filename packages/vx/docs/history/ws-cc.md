# Workstream CC: cache and remote cache

- **CC-11.** A config file whose remotes all failed to parse (a `gh:` url an `insteadOf` elsewhere rewrites), or whose remote lives in `config.worktree`, got the first-commit id or none, while Nx asks `git remote -v`. `repoIdOf` now asks git in those two cases only; a remote-less config still spawns no `git remote`. Rows: `repoIdOf > asks git when no remote url in the config file parses`, `> asks git when config.worktree may hold the remote`, `> a remote-less config spawns no \`git remote\``.
- **CC-1.** A refused restore left an empty directory behind when a later
  entry had created a deeper one (`dist/` then `dist/sub/`): abort pruned in
  staging order and tried `dist/` while `dist/sub/` still held it. Abort now
  prunes newest first. Row (`archive-security.test.ts`):
  `abort prunes a created chain whose deeper directory a later entry created`.
