# Workstream X — the improvement loop (2026-10-06)

The owner's ask: keep improving vx until they return, one small PR at a
time (bugs, correctness, simplification, the plugin seams).

- **X-1.** A `graph` hook's edit to a task's `config` was not checked:
  `config.exec = { comand: … }` ran an empty command that failed with
  exit 1 and no reason, while the design (rule 2) says core re-validates
  `graph` like `project`. Each node's config is now validated after
  each graph plugin, and the refusal names the plugin and the field.
  Row: `plugin-pipeline.test.ts` › "a task config a plugin breaks is
  refused, naming the plugin and the field".
- **X-2.** A command ending in a newline (a template literal's closing
  line) ran the args after `--` as a command of their own:
  `--watch: not found`, exit 127. They now go on the last line, after
  trailing blanks are dropped, unless an odd run of backslashes ends the
  command. Rows: `runner.test.ts` › `withForwardArgs`.
