---
title: 'Built for the agent at the keyboard'
date: 2026-10-09T05:40:00Z
authors:
  - vzn
tags:
  - dx
  - agents
excerpt: 'Most vx runs are started by coding agents now. So every verb speaks JSON with a shipped schema, a failure keeps its log and the files it names, the run history is a SQLite file, and the docs and a skill come as plain markdown.'
---

A coding agent cannot read a progress bar. It reads stdout, parses it and
decides what to do next. If the answer is buried in a frame meant for
human eyes, the agent guesses. vx is built so it never has to.

## The result on stdout, the logs on stderr

`vx run` prints the run for people: a live region on a terminal, plain
rows on a pipe. Once it ends, `vx last --format json` reads the same
run back from run history as one JSON document on stdout, a row per
task. Notices go to stderr, so a pipe sees only the result.

```sh frame="terminal"
$ vx run bundle typecheck --all
$ vx last --format json | jq '.invocation | {runId, command, taskCount, failedCount, hitCount, exitOk}'
{
  "runId": "01a16b0f-dbf0-75fc-aaaa-7ce32e7c3a57",
  "command": "vx run bundle typecheck --all",
  "taskCount": 2,
  "failedCount": 1,
  "hitCount": 0,
  "exitOk": false
}
$ vx last --format json | jq '.tasks[0] | {project, task, status, exitCode, durationMs, hash}'
{
  "project": "packages/api",
  "task": "bundle",
  "status": "success",
  "exitCode": 0,
  "durationMs": 5,
  "hash": "f2bf5dd5f2d36920"
}
```

`vx show`, `vx info`, `vx why` and `vx cache clean` take the same
`--format json`, and `vx run --dry=json` prints the plan before a run.

## Every shape has a schema

Each JSON document has a checked-in JSON Schema, shipped in the package
at `node_modules/@vzn/vx/schemas/`: `plan.json`,
`show.json`, `info.json`, `why.json`, `last.json` and `cache.json`.
Every object closes its key set, so a new field is a schema change, never
a surprise. A test holds each verb's output to its schema, so stdout
always parses. A refusal under `--format json` is a JSON line too, with
a stable code an agent can branch on: see
[A refusal an agent can read](../error-codes/).

## A failure keeps its log and its files

When a task fails, an agent wants two things: what it printed and which
files it blames. vx saves both, so the agent does not have to scroll a
terminal it never saw.

```sh frame="terminal"
$ vx last --failed --format json | jq '.tasks[] | select(.status == "failed") | {status, exitCode, output, locations}'
{
  "status": "failed",
  "exitCode": 1,
  "output": "src/index.ts:3:7 - error TS2322: Type string is not assignable to type number\n",
  "locations": [
    {
      "file": "/work/demo/packages/api/src/index.ts",
      "line": 3,
      "col": 7
    }
  ]
}
```

`locations` lists only files that exist, with absolute paths. Secrets are
masked in the saved output. vx keeps the newest 50 failed runs.

## The history is a SQLite file

Every task of every run goes into `cache.db`: time, CPU, peak memory,
status and cache result. No export step, no API. The file is the API.

```sh frame="terminal"
$ sqlite3 .vx/cache/cache.db "
  SELECT project, task, status, duration_ms FROM runs
  WHERE run_id = (SELECT run_id FROM runs ORDER BY id DESC LIMIT 1)
  ORDER BY duration_ms DESC;"
packages/api|typecheck|failed|6
packages/api|bundle|success|5
```

## Docs and a skill, as markdown

[llms.txt](https://vznjs.github.io/vx/llms.txt) indexes every docs page
as markdown, and
[llms-full.txt](https://vznjs.github.io/vx/llms-full.txt) is the whole
site in one file. `@vzn/vx` also ships an agent skill, one `SKILL.md`
that teaches an agent to run, debug and query vx:

```sh frame="terminal"
$ mkdir -p .claude/skills/vx
$ cp node_modules/@vzn/vx/skills/vx/SKILL.md .claude/skills/vx/
```

`bunx skills add vznjs/vx` installs the same skill. The
[agents guide](../../docs/agents/) and
[machine-readable output](../../cli/#machine-readable-output) have the
details. Outputs above: a one-project workspace, vx at `dbe4033`,
2026-10-23. More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
