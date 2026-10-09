---
title: 'The reference, offline'
date: 2026-10-09T12:30:00Z
authors:
  - vzn
tags:
  - ai
  - dx
excerpt: 'vx docs <query> searches the CLI, config and cache reference that ships inside vx. No network, no site: the sections that match print whole, with their URL.'
---

An agent in a sandbox often cannot reach the docs site. Now the
reference travels with vx: `vx docs <query>` searches it on disk.

```sh frame="terminal"
$ vx docs frozen lock --limit 1
── cli.md § vx lock · https://vznjs.github.io/vx/cli/#vx-lock
…
```

It reads seven pages that ship in the npm package and the compiled
binary: `cli`, `schema`, `caching`, `execution`, `patterns`, `security`
and `features`. A section matches when it holds every word of the
query, and a word in its heading ranks it first. The best three print
whole; `--limit` changes how many.

| You ask                     | You get                               |
| --------------------------- | ------------------------------------- |
| `vx docs cache inputs`      | how a task's inputs are declared      |
| `vx docs exit codes`        | each verb's exit codes                |
| `vx docs sandbox allow`     | what a sandboxed task may touch       |
| `vx docs ... --format json` | `{query, hits: [{page, heading, url, text}]}` |

The JSON shape is `schemas/docs.json`. The guides stay on the site;
[llms.txt](https://vznjs.github.io/vx/llms.txt) indexes them. See the
[CLI reference](../../cli/#vx-docs).
