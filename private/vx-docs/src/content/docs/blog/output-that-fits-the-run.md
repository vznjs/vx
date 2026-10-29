---
title: 'Output that fits the run'
date: 2026-10-09T06:20:00Z
authors:
  - vzn
tags:
  - dx
  - ci
excerpt: 'One task shows all its output. Many tasks show one line each for what ran. CI shows everything. You can always pick.'
---

vx prints as much as the run needs. Ten tasks, one edit, and you see
three lines:

```sh frame="terminal"
$ vx run build test --all
 ⏺︎    14ms success no-cache packages/e#codegen
 ⏺︎     9ms success miss     packages/b#build
 ⏺︎    15ms success miss     packages/b#test

─ vx 0.0.0 ───────────────────────────────────────────────────
  projects  5 affected · 6 total
  tasks     10 success · 10 total
  cache     local 3✓ 1∅ 4↓ 2↑
  time      61ms · max 15ms · avg 13ms · min 9ms
```

The seven cache hits print nothing.

<small>Demo workspace · vx 69617eb · 2026-10-23</small>

| You ask         | vx prints                                          |
| --------------- | -------------------------------------------------- |
| one task        | its full output, live, like running it directly   |
| many tasks      | one line per task that ran; failures replay in full above the summary |
| `CI` is truthy  | every frame                                        |

## Pick a mode yourself

`--output-logs` sets it: `full`, `errors-only`, `hash-only` or `none`.
`hash-only` gives a script each task's cache key:

```sh frame="terminal"
$ vx run build --all --force --output-logs=hash-only
success packages/e#codegen 7e5a9912933413c4
success packages/a#build 6802a43d515f6017
success packages/d#build 9f1cef08a2fd4006
success packages/b#build e8c0e9d5b1f5d0c9
…
```

The glyph at the start of a line says where the result came from:

| Glyph | Result |
| ----- | ------ |
| `⏺` | ran (cache miss) |
| `►` | up to date, nothing to restore |
| `⇢` | restored from the local cache |
| `⇣` | restored from the remote cache |
| `◼` | failed |
| `⊘` | skipped, with the failure that blocked it |
| `▸` | persistent, like a dev server |

## A report for the pull request

Add `github()` from [@vzn/vx-ci](../results-on-github/) to
`.vx/workspace.ts`. Each run on GitHub Actions then writes a job summary
and a check on the commit.

## The run as a timeline

`--profile` writes the run as a Chrome trace. Open it in
[Perfetto](https://ui.perfetto.dev) to see which task held up the rest.

```sh frame="terminal"
$ vx run build --all --force --profile=prof.json
```

```sh frame="terminal"
$ jq -c '.traceEvents[0]' prof.json
{"name":"packages/e#codegen","cat":"success","ph":"X","ts":10028,"dur":10853,"pid":1,"tid":1,"args":{"exitCode":0,"hash":"7e5a9912933413c4","cpuMs":2.543}}
```

Every flag is in the [CLI reference](../../cli/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
