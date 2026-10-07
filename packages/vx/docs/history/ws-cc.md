# Workstream CC: cache and remote cache

- **CC-11.** A config file whose remotes all failed to parse (a `gh:` url an `insteadOf` elsewhere rewrites), or whose remote lives in `config.worktree`, got the first-commit id or none, while Nx asks `git remote -v`. `repoIdOf` now asks git in those two cases only; a remote-less config still spawns no `git remote`. Rows: `repoIdOf > asks git when no remote url in the config file parses`, `> asks git when config.worktree may hold the remote`, `> a remote-less config spawns no \`git remote\``.
