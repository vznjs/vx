---
title: Internals (for contributors)
description: How vx is built inside, for the people who change it — the technical overview, the architecture, the module reference and the design notes.
---

These pages describe vx from the inside. You do not need them to use vx;
[the Guide](../guide/why/) teaches the ideas and [the Docs](../quickstart/)
show how to use them. They are here for contributors, and because the
repository's own tests and notes link them.

The pages in the first two lists are generated from `packages/vx/docs/` in
the repository, which stays their source of truth.

## The system

- [Technical overview](../overview/): the technical documentation's front
  page.
- [Architecture](../architecture/): the design map of `@vzn/vx`.
- [Optimizations](../optimizations/): every performance decision that
  shipped, in one place.
- [Shared patterns with Turbo / Nx](../patterns/): the companion to the
  comparison.
- [Execution flows](../flows/): the run, scenario by scenario, drawn.

## Reference for each part

- [Module reference](../modules/): one page per module under `src/`.
- [Design notes](../design/): proposals and the record of what was explored,
  and why.

## Writing the site

- [The diagram kit](diagrams/): the build-time SVG components the Guide
  draws with, each rendered.
