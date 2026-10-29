---
title: 'The small things'
date: 2026-10-09T05:10:00Z
authors:
  - vzn
tags:
  - dx
excerpt: 'Mistype a flag or a task and vx prints the fix. Forget the task and you get a picker. Tab completes the rest.'
---

Mistype a flag or a task and vx tells you the fix. These are the
answers you see a hundred times a day.

<small>Real output · demo workspace · vx 69617eb · 2026-10-23</small>

## A typo gets the right spelling

```sh frame="terminal"
$ vx run build --concurency 4
✗ vx run  unknown flag: --concurency

  see vx run --help

  fix  --concurrency

$ vx run tset --all
✗ vx run  no projects declare task(s): tset

  fix  test
```

## A task typed as a command gets the command

```sh frame="terminal"
$ vx build --all
✗ vx  `build` is a task here, not a command

  fix  vx run build --all

$ vx biuld
✗ vx  unknown command: biuld, a typo of the task `build`

  fix  vx run build
```

## No task? You get a picker

In a terminal, `vx run` with no task lets you pick one from the project
you are in. In a script or an agent it never waits on a prompt. It
lists the tasks instead:

```sh frame="terminal"
$ vx run < /dev/null
✗ vx run  missing task name (stdin is not a TTY, so no picker; tasks here: build, check, e2e, flip, notes, plain, slow, test)

  see vx run --help
```

## Tab completes every verb and flag

`vx completions` prints a script for bash, zsh or fish. It includes the
verbs your plugins add.

```sh frame="terminal"
eval "$(vx completions bash)"                          # this shell
vx completions zsh > ~/.zfunc/_vx                      # zsh, with ~/.zfunc on $fpath
vx completions fish > ~/.config/fish/completions/vx.fish
```

Reference: [the CLI](../../cli/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
