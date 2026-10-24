---
title: 'The small things'
date: 2026-10-09T05:10:00Z
authors:
  - vzn
tags:
  - dx
excerpt: 'A typo gets the right spelling. A task typed as a command gets the command. No task opens a picker. Tab completes every verb and flag. The parts of a tool you meet a hundred times a day.'
---

The small things are what you meet a hundred times a day. Every answer
below is real output from a demo workspace, vx at `69617eb`,
2026-10-23.

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

  fix  vx run build

$ vx biuld
✗ vx  unknown command: biuld, a typo of the task `build`

  fix  vx run build
```

## No task, a picker

In a terminal, `vx run` with no task lists the tasks of the project you
are in, to pick one. Off a terminal, for a script or an
agent, it never waits on a prompt. It names the tasks instead:

```sh frame="terminal"
$ vx run < /dev/null
✗ vx run  missing task name (stdin is not a TTY, so no picker; tasks here: build, check, e2e, flip, notes, plain, slow, test)

  see vx run --help
```

## Tab completes it all

`vx completions` prints a script for bash, zsh or fish. It completes
every verb, the plugin verbs your workspace adds, and every flag:

```sh frame="terminal"
eval "$(vx completions bash)"                          # this shell
vx completions zsh > ~/.zfunc/_vx                      # zsh, with ~/.zfunc on $fpath
vx completions fish > ~/.config/fish/completions/vx.fish
```

Reference: [the CLI](../../cli/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
