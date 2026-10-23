---
title: 'The reference at your version'
date: 2026-10-09T12:30:00Z
authors:
  - vzn
tags:
  - ai
  - dx
excerpt: 'vx docs <query> searches the reference your vx version wrote, read from its release tag on GitHub: the sections that match print whole, with their URL.'
---

The site shows the newest docs. The vx you run may be older. `vx docs`
searches the reference your version wrote:

```sh frame="terminal"
$ vx docs exit codes --limit 1
── cli.md § Exit codes · https://vznjs.github.io/vx/cli/#exit-codes

### Exit codes
…
```

About one second per query (948 to 1,095 ms, two queries, Linux x64,
2026-10-23), most of it the fetch.

## How it works

- It reads every page of `packages/vx/docs` at your release tag
  (`v<version>`) on GitHub, each time. Nothing ships inside vx.
- A section matches when it holds every word of the query. A word in
  its heading ranks it first.
- The best three print whole. `--limit` changes how many.

| You ask                     | You get                               |
| --------------------------- | ------------------------------------- |
| `vx docs cache inputs`      | how a task's inputs are declared      |
| `vx docs exit codes`        | each verb's exit codes                |
| `vx docs sandbox allow`     | what a sandboxed task may touch       |
| `vx docs VX_E_UNKNOWN_TASK` | the fix for that [refusal](../error-codes/) |
| `vx docs ... --format json` | `{query, hits: [{page, heading, url, text}]}` |

With no network it refuses with `VX_E_NETWORK` and names the site. The
JSON shape is `schemas/docs.json`. Guides stay on the site;
[llms.txt](https://vznjs.github.io/vx/llms.txt) indexes them.

Reference: [`vx docs`](../../cli/#vx-docs). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
