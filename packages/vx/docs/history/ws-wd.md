# Workstream WD — watch, dev servers, persistent tasks (2026-10-07)

- **WD-2.** The workspace-wide watcher read a literal `inputs.workspaceFiles` entry (`shared`, `conf/`) as one path, so no edit under that directory ran a cycle while the key read the tree. The root event filter now compiles entries through `asTrees`, the key's rule. Row: `tests/watch-rules.test.ts` › "a directory literal in workspaceFiles is its tree, as the key reads it (WD-2)".
