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

A coding agent dropped into a large monorepo spends a surprising share
of its tokens working out how the build works: reading `turbo.json` or
a hundred `project.json` files, guessing which task to run, re-running
things to see whether they are cached. The runner already knows all of
that. vx hands it over as JSON, and the vx skill tells the agent which
command answers which question.

```sh frame="terminal"
$ npx skills add vznjs/vx
```

The skill is one `SKILL.md`. To match the vx a workspace has installed,
copy it from the package instead:

```sh frame="terminal"
$ mkdir -p .claude/skills/vx
$ cp node_modules/@vzn/vx/skills/vx/SKILL.md .claude/skills/vx/
```

Run the agent from inside the workspace and every verb finds the
workspace and its cache from the current directory, exactly as
`vx run` does.

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

Each prints one JSON document to stdout, and every notice goes to
stderr, so stdout always parses. Each shape is a JSON Schema shipped in
the package, under `node_modules/@vzn/vx/schemas/`.

The history answers read the same local `cache.db` tables that a person
reads with `vx why`, `vx last` and `vx info`. `vx last --stats` calls a
task flaky only on a real nondeterminism signal, a within-run retry or
one key that both failed and succeeded, so an agent does not learn to
shrug at repeated failures on changing inputs.

A refusal is data too. Under `--format json` it is one line on stdout
with a stable code and a link to what to do, so the agent can read it
and correct its call instead of guessing:
[A refusal an agent can read](../error-codes/).

## Why the CLI and not a server

There is nothing to install beside vx, no process to keep alive and no
port to open. The agent already runs shell commands, and the CLI it
calls is the one a person calls, so the selection, the refusals and the
sandbox are the same for both. Core knows nothing about agents.

## The other half

The JSON is how an agent *reads* the build. The other half of
working with agents is letting one *run* the build safely, and that is
what the rest of vx already is: explicit inputs, [strict
outputs](../strict-output-ownership/), a [sandbox](../the-sandbox/) that
denies undeclared reads and any domain no task of the run lists, and a
[teardown](../ctrl-c/) that leaves nothing running when the agent's
session is cancelled. An agent that can only run declared commands
against declared paths is an agent you can leave alone with the
repository.

The guide is [AI agents](../../guides/agents/).
