---
title: 'Errors that say the fix'
date: 2026-10-09T14:00:00Z
authors:
  - vzn
tags:
  - ai
  - dx
excerpt: 'A refusal under --format json now links the fix for its code, and vx docs <code> prints the same fix offline.'
---

A stable code tells an agent what went wrong. Now it also says what to
do: the error line carries `docs`, a link to that code's fix.

```sh frame="terminal"
$ vx run biuld --all --format json
{"ok":false,"error":{"code":"VX_E_UNKNOWN_TASK","message":"vx run: no projects declare task(s): biuld. Did you mean build?","docs":"https://vznjs.github.io/vx/cli/#vx_e_unknown_task"}}
```

No network? The same section ships inside vx:

```sh frame="terminal"
$ vx docs VX_E_UNKNOWN_TASK
── cli.md § VX_E_UNKNOWN_TASK · https://vznjs.github.io/vx/cli/#vx_e_unknown_task

#### `VX_E_UNKNOWN_TASK`

No project in scope declares a requested task. The message lists the
tasks it found; `vx show --format json` lists each project's. …
```

| Code                 | The fix says                                      |
| -------------------- | ------------------------------------------------- |
| `VX_E_USAGE`         | the flag it refused; `vx <verb> --help`           |
| `VX_E_CONFIG`        | the file and field; `vx docs <field>`             |
| `VX_E_CYCLE`         | the loop; drop one `dependsOn` edge               |
| `VX_E_NO_HISTORY`    | run the task once first                           |
| `VX_E_FDS`           | `ulimit -n 4096`, or fewer tasks at once          |

Every core code has its section, and a test holds the list to the codes
the source can throw. Over MCP, a refused tool call carries the same
`docs` link.

[Error codes](../../cli/#error-codes) · [Agents guide](../../guides/agents/)
