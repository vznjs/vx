---
title: Troubleshooting
description: What vx printed, what it means, and the fix.
---

The messages and surprises of a first run, each with its fix. Problems
specific to one guide stay there: [Sandboxing](../sandboxing/#common-problems),
[CI](../ci/#common-problems), [Migrate](../migrate/#common-problems).

## vx printed an error

| vx prints                                          | Fix                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| `not inside a project`                             | Run from a package directory, or pass `--all` or `--filter <pattern>`.  |
| `… has a vx config but no package.json — skipped` | Add a `package.json` with a `"name"` to that directory: vx names a project by it. |
| `vx requires git: … is not inside a git work tree` | Run `git init` at the workspace root.                                   |
| `vx requires git: failed to spawn 'git'`           | Install git.                                                            |
| `--affected has no base here`                      | Fetch the history (`fetch-depth: 0` in CI), or pass `--affected=<ref>`. |
| `… has unknown field "<key>"`                      | A typo, or a Turbo or Nx key: the message lists the fields vx allows.  |
| `Cycle detected in task graph`                     | Remove one `dependsOn` edge of the loop it prints.                      |
| `depends on … but no such project or task is declared` | Fix the name, or declare that task in that package.                 |
| `No projects declare task(s)`                      | A typo, or no config declares it: `vx show` lists every task.           |
| `unknown flag`                                     | `vx run --help` lists the flags.                                        |
| `filter "…" matched no projects`                   | A typo: the message suggests the closest name. `vx show` lists every project. |
| `waiting for another vx run (pid …)`               | One run per workspace at a time: it starts when that one ends. Stop it, or wait. |
| `vx: command not found`                            | A local install is not on PATH: run `npx vx` or `bunx vx`.              |

## vx did something unexpected

- **Only one package ran.** `vx run build` runs the package you are in
  and what it depends on. Add `--all`.
- **A task runs every time.** It has no `cache` block. `vx init` leaves
  a TODO with the block to add.
- **A task hit after you changed a file.** The file is not in
  `cache.inputs.files`. `vx why <project#task>` shows what the key saw;
  [`exec.sandbox`](../sandboxing/), with reads granted no wider than
  the inputs, refuses that read and names it.
- **`cache.inputs matched no files`.** The globs name nothing in the
  project, so the key ignores its source. Fix the paths; they are
  relative to the project directory.
- **`cache.outputs matched no files`.** The task wrote elsewhere, so a
  hit restores nothing. Point `outputs.files` at what the task writes;
  a sandboxed task also needs `exec.sandbox.allow.write` for it.
- **`not ready after …: waiting for a line matching`.** A persistent
  task's `readyWhen` has not matched its output yet. Fix the pattern,
  or set `exec.timeout` to bound the wait.
- **A task re-ran and you do not know why.** `vx why <project#task>`
  names the part of the key that changed.
- **A variable is empty inside the command.** Past a small essential
  allowlist (`PATH`, `HOME`, `CI` and a few more), vx passes only what
  you list: add it to `exec.env.passThrough`
  ([Environment variables](../configure/#environment-variables)).
- **`dist/` is empty after `tsc -b`.** tsc's build info sits outside
  `dist/`; add `tsconfig.tsbuildinfo` to `outputs.files`
  ([Quickstart](../../quickstart/#common-problems)).

## Platforms

- **Windows:** use WSL.
- **Alpine:** not supported; vx's Linux binary needs glibc.
- **From source:** Bun 1.4 or later. The binary needs neither Bun nor Node.
