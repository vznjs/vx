---
title: 'Architecture: a pipeline with seams'
description: The stages from config to telemetry, the local floor under every plugin, and why core names no plugin.
---

:::note
Status: planned (roadmap W5).
:::

This page will teach vx's architecture as a pipeline with seams: the stages
from `config` to `telemetry`, the local executor and cache that sit under
every plugin, why core names no plugin by default, and what a seam is for.
Its widget will be a pipeline explorer: select a stage to see the hook it
exposes, the first-party plugin that fills it, and a ten-line plugin for
it. After reading it you should know which stage a plugin you want to
write fills, the first step to writing one.
