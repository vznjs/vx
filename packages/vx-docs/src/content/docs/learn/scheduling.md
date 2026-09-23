---
title: Scheduling
description: Parallelism, the critical path, the worker pool, and why the order tasks start in matters.
---

:::note
Status: planned (roadmap W4).
:::

This page will teach how a scheduler turns a task graph into a run:
parallelism, the critical path, the worker pool, why the order tasks start
in matters, and why restoring from the cache and executing are separate
tiers. Its widget will be vx's own scheduling simulator running in the
browser, drawn as a Gantt chart, with the workers, the durations and the
ordering policy under your control. After reading it you should be able to
read a task graph and say which chain of tasks bounds the run.
