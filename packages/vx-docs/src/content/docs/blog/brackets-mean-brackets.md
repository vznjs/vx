---
title: 'We took back a glob shortcut'
date: 2026-10-20T18:20:00Z
authors:
  - vzn
tags:
  - design
  - config
excerpt: 'vx once read [...] in a task glob literally, so a Next.js route like app/[id] needed no escape. It also meant src/*.[jt]s matched nothing, unlike Turbo, Nx and most glob tools. Why vx now reads brackets the standard way, and why that changed every cache key.'
---

A Next.js app keeps its routes in directories named like `app/[id]`. In
almost every glob tool, `[id]` is a character class: one character, `i`
or `d`. So a glob written for that route matches nothing until you
escape it as `app/\[id\]`.

vx once took a shortcut: a `[...]` in a task glob was literal. A route
directory needed no escape. It looked friendly, and it was a mistake.

## A glob should mean the same thing everywhere

The shortcut broke the other half. `src/*.[jt]s` is an ordinary way to
say "the `.js` and `.ts` files", and in vx it matched nothing. A glob
copied from `turbo.json`, an Nx project or a shell meant something else
once it reached a `vx.config.ts`. A config you cannot read the same way
in two tools is a config you have to test twice.

So brackets are a character class again, everywhere a task glob is read:

```ts
inputs: { files: ['src/**/*.[jt]s', 'app/\\[id\\]/**'] }
```

`src/**/*.[jt]s` matches `.js` and `.ts`. A literal route directory is
escaped, as it is in Turbo, Nx and most glob tools (the double backslash
is the TypeScript string's escape). `@vzn/vx-migrate` passes Turbo's and
Nx's classes through unchanged, and escapes the brackets in any path it
writes.

## Why every key changed

A glob is part of what a task's key folds in. After the change, the
same glob string can select different files: `app/[id]/**` used to mean
the route and now means `app/i/**` or `app/d/**`. A key that stayed the
same over different inputs could replay outputs built from the wrong
files. That is the one failure a cache must never have, so 0.0.644
moved the cache version to `vx-cache-v48`, and every cached task misses
once after the upgrade.

vx is pre-1.0, and a breaking change ships as one: no alias, no setting
to keep the old reading. The glob rules are in
[Caching](../../caching/). More on vx at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
