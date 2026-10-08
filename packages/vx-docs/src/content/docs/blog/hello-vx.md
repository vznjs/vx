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
per task and schedules the work. Small synthetic fully cached runs
have answered in tens of milliseconds; cold wall time also depends on
ready-task order, not just time in your tools. Everything distributed —
remote caches, remote execution,
telemetry, AI agents — is a plugin on a documented seam, never a
feature inside.

Where to look next:

- [Quickstart](../../quickstart/) — a workspace running under vx in a few
  minutes, or [add vx to an existing repo](../../quickstart/#an-existing-repo)
  one package at a time.
- [Benchmarks](../../benchmarks/) — retained native-config measurements
  on a synthetic 3,270-node layered graph, one repetition per runner/state,
  and a separate [scheduling counterexample](../../benchmarks/#synthetic-scheduling-counterexample)
  with its retained preliminary case; neither is a universal speed ranking.
- [Architecture](../../architecture/) — the pipeline, its seams, and why
  the cache can be trusted.

Release write-ups will follow here as they ship.
