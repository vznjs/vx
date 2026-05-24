# cli

Argv parser + subcommand dispatcher. Each subcommand is a thin function that:

1. Resolves a workspace root from `cwd` (via `workspace.findWorkspaceRoot`).
2. Composes pipeline modules (`workspace` → `config` → `graph` → …).
3. Writes to injected `write` / `writeErr` callbacks (not `process.stdout` directly) so tests can capture output.

## Commands shipped

| Command | Purpose                                                    |
| ------- | ---------------------------------------------------------- |
| `graph` | Print the task graph that would run for the given task(s). |

## Roadmap (each becomes its own subcommand file)

| Command | Purpose                       | Module      |
| ------- | ----------------------------- | ----------- |
| `run`   | Execute tasks via the runner. | `runner`    |
| `ls`    | List discovered projects.     | `workspace` |
| `watch` | Re-run tasks on FS change.    | `watcher`   |

## Replacing the CLI

`runCli(argv, opts)` is pure-ish (only side effect is the injected callbacks). Embed it inside another process, a TUI, a server — the surface stays small.
