---
title: 'Try the planner in your browser'
date: 2026-10-09T05:00:00Z
authors:
  - vzn
tags:
  - dx
excerpt: 'The playground runs vx’s own planner in the page, on four small packages. Edit a file, an env var or a config, press Run, and see which tasks would run and why.'
---

The fastest way to learn how a cache decides is to poke it. The
playground is vx's real planner, the same code the CLI runs, bundled for
the browser. Nothing to install.

![The playground: four packages, a Run button and the plan.](../../../assets/features/playground.png)

## What you can do

- Edit a source file, and see the tasks whose inputs it touches turn into
  misses, plus every task downstream.
- Change an env var a task declares, and see its key move.
- Change a config, and see the resolved task change with it.

```mermaid
flowchart LR
  EDIT["edit a file, env or config"] --> PLAN["vx's planner (in the page)"]
  PLAN --> OUT["which tasks run, and why"]
  style PLAN stroke:#c6f84e,stroke-width:2px
```

The planner plans: it runs no command and writes no file. A test holds
the page's planner to the CLI's, so what you see there is what
`vx` would say.

## The same plan at home

On your own repository the page's answer is one command:

```sh frame="terminal"
vx run build test --all --dry
```

and `--dry=json` gives the plan as data.

[Open the playground →](../../playground/)

Learn more: [The playground](https://vznjs.github.io/vx/features/playground/).
