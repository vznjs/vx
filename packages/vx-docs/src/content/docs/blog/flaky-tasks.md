---
title: 'Flaky is a claim only declared inputs can back'
date: 2026-09-10
authors:
  - vzn
tags:
  - dx
  - caching
excerpt: "vx names a task flaky only when its exact cache key has both passed and failed on record, or it needed a retry this run. A failure on inputs that never passed is a break, not a flake. No service, no upload: the local run history is enough."
---

Flaky-test detection is one of the features that usually lives behind
a cloud login. Nx sells it. It is also one of the easiest things to get
wrong, because "flaky" is used to mean "failed and I do not want to
look," and a tool that agrees with that use is teaching a team to
ignore red.

vx defines it narrowly, and the narrow definition is the feature.

## The definition

A task is **flaky** when one of two things is on record:

- its exact cache key has **both passed and failed**, this run
  included (a cache hit counts as a pass; it replayed one), or
- it needed a **retry** this run (`exec.retries` or `--retry`) and then
  passed.

A failure on a key that never passed is a **break**. The inputs
changed and the result is red, which is what a red run usually means,
and it is not listed. Only tasks with a `cache` block are judged at
all: "same inputs, different outcome" is a claim only declared inputs
can back. A task without them is keyed on its config alone, and two
runs of it are not the same inputs in any meaningful sense.

## What you see

After the footer, a run names the tasks it just proved nondeterministic:

```
  Flaky:    2 tasks with the same inputs both passing and failing on record
    ✗ app#test — failed on inputs that passed 3× before
    ✓ api#e2e — passed on inputs that failed 1× before · 2 attempts this run
```

The section is not printed when nothing was flaky. `vx info` keeps the
standing list across runs, `--summarize` carries it as typed data
(`flaky: { passes, failures, attempts }` on the task, so a consumer can
tell a break from a flake without parsing text), and the MCP
`getRunHistory` tool reports the same signal to an agent, so an agent
does not learn to shrug at a repeated failure on changing inputs.

## Why it is free

The information was already there. Every cache entry records its key,
its outcome and its run. Asking "has this key ever had the other
outcome" is one probe of the failed-row index on a green miss, and
nothing at all on a run that executed nothing. There is no upload
because there is nothing to upload to; the history is the local
`cache.db` that `vx why` and `vx last` already read.

That is also why it works on the first day. A service-side detector
needs a fleet of runs before it can say anything. vx's needs the second
run of the same key on your machine.

## What it is not

It is not a retry policy. `exec.retries` is separate and explicit, and
a task that passes on retry is *reported* as flaky rather than quietly
made green. It is not a quarantine: nothing is skipped, ever, because a
skip is a silent pass. It is a label on a fact, kept where you can act
on it, and the act is yours.
