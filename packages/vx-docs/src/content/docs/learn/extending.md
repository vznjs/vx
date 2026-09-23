---
title: Extending vx
description: Worked plugins for a remote cache, remote execution, a telemetry sink, a CLI verb, and adopting Turbo or Nx.
---

:::note
Status: planned (roadmap W6).
:::

This page will teach extending vx through worked examples: a remote cache
as a cache layer, remote execution through REAPI, a telemetry sink, a CLI
verb, and running a Turbo or Nx repo unchanged. Each example sits beside
the pipeline diagram with the stage it fills lit up, and each is a real
file the site's tests type-check, so it cannot go stale. After reading it
you should be able to write a plugin.
