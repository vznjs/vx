---
title: 'Hello, vx'
date: 2026-09-10
authors:
  - vzn
tags:
  - announcement
excerpt: 'Announcements, design notes and release write-ups for vx land here. The first one is short: what vx is, and where to look next.'
---

Announcements, design notes and release write-ups for vx land here.
The first one is short.

**vx runs and caches a task graph, correctly, and stops there.** It
discovers the projects in a JavaScript monorepo, evaluates each
`vx.config.ts`, builds one task graph, derives a content-addressed key
per task and schedules the work. A fully cached run answers in tens of
milliseconds; a cold run spends its time in your tools, not in the
runner. Everything distributed — remote caches, remote execution,
telemetry, AI agents — is a plugin on a documented seam, never a
feature inside.

Where to look next:

- [Quickstart](../../quickstart/) — a workspace running under vx in a few
  minutes, or [add vx to an existing repo](../../add-to-existing-repo/)
  without rewriting a config (a Turbo repo runs as it is).
- [Benchmarks](../../benchmarks/) — synthetic workspaces up to 3,270 tasks,
  and a real Turbo monorepo measured against Turbo itself.
- [Architecture](../../architecture/) — the pipeline, its seams, and why
  the cache can be trusted.

Release write-ups will follow here as they ship.
