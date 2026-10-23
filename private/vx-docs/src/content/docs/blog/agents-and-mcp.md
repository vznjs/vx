---
title: "Give your coding agent the build's memory"
date: 2026-09-10T23:37:00Z
authors:
  - vzn
tags:
  - plugins
  - agents
excerpt: "An AI agent working in a monorepo asks the same questions you do: what can I run here, why did that re-run, which tasks flake. vx answers them as JSON from the CLI, read from the cache database it already keeps, and a skill teaches the agent which command to ask."
---

An agent asks why a task re-ran. vx answers in one JSON line:

```sh frame="terminal"
$ vx why packages/a#build --format json | jq -c '.diff.entries[0]'
{"kind":"file","name":"packages/a/src/index.ts","change":"changed","before":"d64be65d2e8131eabf0e284282b457be62aebe14","after":"e9de63a046c5c557ab363dd935aa4cf14a3db016"}
```

No reading configs, no re-running to see what is cached. The runner
already knows, so it says.

On this repository, `vx show --format json` lists all 13 projects and
201 tasks in 5,807 bytes, in 106 ms (min of 7). The 12 `vx.config.ts`
files it read are 71,915 bytes. Linux x64, vx at `69617eb`, 2026-10-23.

Install the skill that tells the agent which command answers which
question:

```sh frame="terminal"
$ bunx skills add vznjs/vx
```

To match the vx a workspace has installed, copy it from the package
instead:

```sh frame="terminal"
$ mkdir -p .claude/skills/vx
$ cp node_modules/@vzn/vx/skills/vx/SKILL.md .claude/skills/vx/
```

Every verb finds the workspace and its cache from the current
directory, as `vx run` does.

## What it answers

| The question                                          | The command                                     |
| ----------------------------------------------------- | ----------------------------------------------- |
| What can I run here?                                  | `vx show --format json`                         |
| What does this task declare?                          | `vx show app#build --format json`               |
| What would run, and why?                              | `vx run test --affected=origin/main --dry=json` |
| What did the last run do?                             | `vx last --format json`                         |
| Why did the last run fail?                            | `vx last --failed --format json`                |
| What did this task print?                             | `vx last --log app#build`                       |
| Why did `app#build` re-execute instead of hitting?    | `vx why app#build --format json`                |
| How fast is each task, and which ones flake?          | `vx last --stats --format json`                 |
| What is this workspace, and what is in its cache?     | `vx info --format json`                         |
| Is the config lock current?                           | `vx lock --check --format json`                 |
| What would adopting vx write here?                    | `vx init --dry --format json`                   |
| Where is this documented?                             | `vx docs <words> --format json`                 |

- **stdout always parses.** One JSON document; every notice goes to
  stderr. Each shape ships as a JSON Schema under
  `node_modules/@vzn/vx/schemas/`.
- **Same answers a person gets.** History reads the local `cache.db`
  that `vx why`, `vx last` and `vx info` read.
- **Flaky means flaky.** `vx last --stats` flags a task only on a
  within-run retry or one key that both failed and succeeded, not on
  failures across changing inputs.
- **A refusal is data.** Under `--format json` it is one line with a
  stable code and a link to the fix:
  [A refusal an agent can read](../error-codes/).

## Why the CLI and not a server

Nothing to install beside vx, no process to keep alive, no port. The
agent already runs shell commands, and it calls the same CLI a person
does: same selection, same refusals, same sandbox. Core knows nothing
about agents.

## The other half

JSON is how an agent *reads* the build. Letting it *run* the build
safely is the rest of vx: explicit inputs, [strict
outputs](../strict-output-ownership/), a [sandbox](../the-sandbox/) that
denies undeclared reads and unlisted domains, and a
[teardown](../ctrl-c/) that leaves nothing running when the session is
cancelled. An agent that can run only declared commands on declared
paths is one you can leave alone with the repository.

Guide: [AI agents](../../guides/agents/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
