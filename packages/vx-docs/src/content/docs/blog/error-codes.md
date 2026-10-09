---
title: 'A refusal an agent can read'
date: 2026-10-09T05:10:00Z
authors:
  - vzn
tags:
  - ai
  - dx
excerpt: 'Under --format json, a refusal is now a JSON line with a stable code. An agent branches on VX_E_UNKNOWN_TASK, not on the wording of a sentence.'
---

An agent that runs `vx run build --format json` reads stdout. When vx
refused the run, stdout used to be empty, and the reason sat on stderr
as prose. Now the refusal is on stdout too, as one JSON line:

```sh frame="terminal"
$ vx run biuld --all --format json
{"ok":false,"error":{"code":"VX_E_UNKNOWN_TASK","message":"vx run: no projects declare task(s): biuld. Did you mean build?"}}
```

The exit code is still 1 and stderr still says it in words. The code
is the contract; the message may change.

| Code                | Means                                        |
| ------------------- | -------------------------------------------- |
| `VX_E_USAGE`        | A flag or argument vx does not take          |
| `VX_E_UNKNOWN_TASK` | No project declares the task                 |
| `VX_E_CONFIG`       | A config that does not load                  |
| `VX_E_CYCLE`        | The task graph has a cycle                   |
| `VX_E_NO_WORKSPACE` | No workspace above the working directory     |
| `VX_E_REFUSED`      | Any other refusal                            |
| `VX_E_INTERNAL`     | A bug in vx                                  |

`schemas/error.json` describes the line, and the full table is in the
[CLI reference](../../cli/#error-codes).
