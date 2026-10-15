---
title: 'A refusal an agent can read'
date: 2026-10-09T05:10:00Z
authors:
  - vzn
tags:
  - ai
  - dx
excerpt: 'Under --format json, a refusal is a JSON line with a stable code and a link to its fix. An agent branches on VX_E_UNKNOWN_TASK, not on the wording of a sentence, and vx docs <code> prints the fix offline.'
---

An agent that runs `vx run build --dry=json` reads stdout. When vx
refused the run, stdout used to be empty, and the reason sat on stderr
as prose. Now the refusal is on stdout too, as one JSON line:

```sh frame="terminal"
$ vx run biuld --all --dry=json
{"ok":false,"error":{"code":"VX_E_UNKNOWN_TASK","message":"vx run: no projects declare task(s): biuld. Did you mean build?","docs":"https://vznjs.github.io/vx/cli/#vx_e_unknown_task"}}
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

## Each code says the fix

`docs` links that code's section. No network? The same section ships
inside vx:

```sh frame="terminal"
$ vx docs VX_E_UNKNOWN_TASK
── cli.md § VX_E_UNKNOWN_TASK · https://vznjs.github.io/vx/cli/#vx_e_unknown_task

#### `VX_E_UNKNOWN_TASK`

No project in scope declares a requested task. The message lists the
tasks it found; `vx show --format json` lists each project's. …
```

| Code              | The fix says                            |
| ----------------- | --------------------------------------- |
| `VX_E_USAGE`      | the flag it refused; `vx <verb> --help` |
| `VX_E_CONFIG`     | the file and field; `vx docs <field>`   |
| `VX_E_CYCLE`      | the loop; drop one `dependsOn` edge     |
| `VX_E_NO_HISTORY` | run the task once first                 |
| `VX_E_FDS`        | `ulimit -n 4096`, or fewer tasks at once |

Every core code has its section, and a test holds the list to the codes
the source can throw. Over MCP, a refused tool call carries the same
`docs` link. (Since vx 0.0.637, `@vzn/vx-mcp` is retired; `--format
json` carries the link for an agent.) See the
[Agents guide](../../guides/agents/).
