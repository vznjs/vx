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

The site shows the newest docs. The vx you run may be older. `vx docs
<query>` searches the reference as your version wrote it, so an agent
gets the flags and fields your vx takes.

```sh frame="terminal"
$ vx docs frozen lock --limit 1
── cli.md § vx lock · https://vznjs.github.io/vx/cli/#vx-lock
…
```

It reads every page of `packages/vx/docs` at your release tag
(`v<version>`) on GitHub, each time it runs: nothing ships inside vx. A
section matches when it holds every word of the query, and a word in its
heading ranks it first. The best three print whole; `--limit` changes how
many.

| You ask                     | You get                               |
| --------------------------- | ------------------------------------- |
| `vx docs cache inputs`      | how a task's inputs are declared      |
| `vx docs exit codes`        | each verb's exit codes                |
| `vx docs sandbox allow`     | what a sandboxed task may touch       |
| `vx docs ... --format json` | `{query, hits: [{page, heading, url, text}]}` |

With no network it refuses with `VX_E_NETWORK` and names the site. The
JSON shape is `schemas/docs.json`. The guides stay on the site;
[llms.txt](https://vznjs.github.io/vx/llms.txt) indexes them. See the
[CLI reference](../../cli/#vx-docs).
