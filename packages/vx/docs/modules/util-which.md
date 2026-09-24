# `src/util/which.ts` — a tool's absolute path, found once

## Purpose

A spawn of a bare name makes Bun walk PATH with a stat per entry. vx
spawned `sh` for every task and `git` for every git call, so a
200-task run on a 100-package workspace paid 2,800 stats for the same
`sh` (14 PATH entries) and 12 for each of five gits. Every spawn site
of a tool vx itself runs — the task shell (runner, sandbox), strace,
git — asks here and hands Bun the absolute path.

## Public surface

```ts
export function executablePath(name: string): string
```

- Resolved on vx's OWN `process.env.PATH`, never a task's. A task's
  PATH leads with its project's and the workspace's `node_modules/.bin`
  and `exec.env.define` may set it; the shell that parses the command
  and the git that enumerates the inputs are the machine's tools, so a
  dependency shipping a `sh` bin does not become the interpreter of
  every command in its project (it did: Bun resolved the bare `sh`
  against the task's PATH). The task's PATH still decides what the
  command resolves, inside that shell.
- Memoized per PATH VALUE: one walk per tool while PATH is unchanged
  (nothing in vx changes it mid-run), and a new walk when it does
  change, so an embedder or a test that sets PATH is answered for the
  PATH it has.
- A miss throws Bun's own shape for a spawn that could not run
  (`code: 'ENOENT'`, `Executable not found in $PATH: "<name>"`), so a
  call inside a spawn site's `try` reaches the same
  `isExecutableMissing` refusal ("vx requires git", "Install a POSIX
  sh") as before. A miss is not remembered: it ends the spawn that
  asked, and a long-lived process (`vx watch`) finds the tool once it
  is installed.
- The answer is absolute even for a relative PATH entry (`Bun.which`
  resolves one against this process's cwd).

## Not here

The `cache.inputs.runtime` probe (`cache/inputs.ts`) still spawns a
bare `sh`, against vx's ambient PATH.

## Tests

`tests/util-which.test.ts` (one walk per PATH, a PATH change heard, the
miss's shape and that it is not remembered); `tests/task-shell.test.ts`
(a `node_modules/.bin/sh` parses no task command; `$0` is still `sh`);
`tests/syscall-repeats.unsafe.test.ts` (the lookup stats of `sh` and
`git` do not grow with the number of spawns, counted by strace).
