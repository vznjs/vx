---
title: Built for the agents that run your builds
description: vx is AI-first. An agent asks what to run, runs it, and learns why it failed, all as typed JSON. People get the same answers as text.
---

More and more builds start from a coding agent, not a person at a
terminal. vx is designed for that: an agent can ask what to run, run
it, and learn why it failed without scraping terminal output. People
get the same answers, formatted for reading.

## Teach the agent the CLI

vx ships an agent skill that teaches any coding agent the CLI it already
has: `npx skills add vznjs/vx/packages/vx/skills/vx`. Every question has a command:

| Question                                      | Command                                              |
| --------------------------------------------- | ---------------------------------------------------- |
| What can I run here?                          | `vx show --format json`                              |
| What would run, and why?                      | `vx run test --dry=json`                             |
| Run these tasks and tell me how it went.      | `vx run test --format json`                          |
| Why did the run fail, at which file and line? | `vx last --failed --format json`                     |
| What did a task print?                        | `vx last --log app#test`                             |
| Why did this task run again?                  | `vx why app#test --format json`                      |
| What does a task declare?                     | `vx show app#test --format json`                     |
| What is this workspace?                       | `vx info --format json`                              |
| What ran, how fast, what flaked?              | `vx last --stats --format json`                      |
| Is the lock current? What would `vx init` do? | `vx lock --check --format json`, `vx init --dry --format json` |
| Free cache space.                             | `vx cache prune --max-size 1G --dry-run`             |

The agent runs with your permissions, as you would; nothing sits between
it and the shell.

## JSON with a contract

`vx show`, `vx info`, `vx why`, `vx last` and `vx cache prune` take
`--format json`. Each prints one document whose shape is a JSON Schema
shipped in the package, and every object closes its key set, so a new
field is a schema change, never a surprise. `vx run --format json`
prints the run's result; `vx run --dry=json` prints the plan before
anything runs. See [Machine-readable output](../../cli/#machine-readable-output).

## Errors you can branch on

Asked for JSON, a refusal is one line on stdout with a stable code,
such as `VX_E_UNKNOWN_TASK` or `VX_E_CYCLE`. The code stays; the
message may change. See [Error codes](../../cli/#error-codes).

```text
$ vx run nope --all --format json
{"ok":false,"error":{"code":"VX_E_UNKNOWN_TASK","message":"vx run: no projects declare task(s): nope. Tasks: build.","docs":"https://vznjs.github.io/vx/cli/#vx_e_unknown_task"}}
```

The exit code is 1, and `docs` links the fix.

## Clean streams

A verb whose output is a product writes only that product to stdout.
Notices and warnings go to stderr, so `vx info --format json` pipes
straight into a parser.

## Answers, not guesses

`vx why app#test` walks the cause chain: which input changed, in which
upstream task. An agent fixes the cause instead of re-running to find
it. With `--format json`, each changed part of the key is one entry:

```text
{"kind":"file","name":"packages/app/src/a.ts","change":"changed","before":"a853d874…","after":"d14600f9…"}
```

A mistyped flag gets the right one back: `--concurency` hints
`--concurrency`, and `--json` hints `--format json`.

## Docs an agent can read

[llms.txt](https://vznjs.github.io/vx/llms.txt) indexes every page as
markdown, and `vx docs <query>` searches the reference that ships
inside vx, offline.

## Still built for people

The same facts print as plain text. Run `vx run build --all`, and when
something re-runs, `vx why` tells you why. Setup steps for each agent
are in the [AI agents guide](../../guides/agents/).
