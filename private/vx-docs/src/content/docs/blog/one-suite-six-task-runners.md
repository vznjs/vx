---
title: 'One test suite, six task runners, the same 993 cases'
date: 2026-11-07T22:00:00Z
authors:
  - vzn
tags:
  - correctness
  - comparison
excerpt: '993 task-runner cases, compiled from the test suites of Nx, Turborepo, Vite Task, moon, Nix and vx, run sandboxed against all six. Every result is on one page.'
---

Each case is a small workspace and the outcome a user would see. All six
tools run the same 993 cases, each in a sandbox.

```mermaid
xychart-beta
  title "Cases passed, of 993"
  x-axis [vx, Nx, Turborepo, moon, "Vite Task", Nix]
  y-axis "cases" 0 --> 993
  bar [991, 646, 630, 581, 502, 479]
```

<small>vx 8cbc907 · Turborepo 2.11.10 · Nx 24.0.2 · Vite Task 1.4.0 · moon 2.6.5 · Nix 2.34.6 · 2026-11-11 · [every case](../../conformance/)</small>

## The cases come from every tool's own tests

The cases are compiled from the test suites of Nx, Turborepo, Vite
Task, moon, Nix and vx. A case names no tool's config. It says which
projects exist, what each task runs, and what must hold afterwards.

```mermaid
flowchart LR
  W[small workspace] --> S[steps: edit, commit, run]
  S --> A1[which commands ran]
  S --> A2[files left on disk]
  S --> A3[exit code]
  S --> A4[what the tool reports]
```

A thin adapter turns the case into each tool's own config. The harness
marks each command as it starts and ends, so "ran" means it ran.

## Where the scores split

| Group    | Cases | vx  | Nx  | Turborepo | moon | Vite Task | Nix |
| -------- | ----: | --: | --: | --------: | ---: | --------: | --: |
| graph    |   150 | 150 | 114 |        92 |   85 |        86 |  58 |
| inputs   |   305 | 305 | 187 |       187 |  193 |       178 | 177 |
| outputs  |   225 | 225 | 158 |       161 |  122 |       140 | 159 |
| affected |    97 |  97 |  57 |        68 |   69 |         0 |   0 |
| watch    |    31 |  31 |  27 |        28 |    0 |         0 |   0 |
| sandbox  |    18 |  18 |   0 |         1 |    0 |         1 |  15 |

A case a tool cannot express counts as not passed. Its users cannot get
that behaviour either.

## Each case says why it matters

```ansi
[1mArgs forwarded to a server reach it as typed, never expanded by a shell[0m
[2mvx[0m        [38;2;34;197;94mpass[0m
[2mmoon[0m      [38;2;34;197;94mpass[0m
[2mNx[0m        [38;2;239;68;68mfail[0m  seen.txt is "<0><0>…", expected "<$(id -u)><`id -u`>…"
```

Every case carries three or four sentences on what goes wrong without
it. Here a second shell ran `$(id -u)`, a command nobody typed.

vx misses 2 cases. Both need programs a dependency puts on PATH, which
vx left to the tools you already have.

All cases, filters and each tool's detail: [Conformance](../../conformance/).
More at [vznjs.github.io/vx](https://vznjs.github.io/vx/).
