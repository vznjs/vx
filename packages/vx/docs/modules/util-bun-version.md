# `src/util/bun-version.ts` — the runtime floor, read at run time

## Purpose

`package.json` states `"engines": { "bun": ">=1.4" }`. An install may print
that; a RUN never reads it. `bun src/bin.ts` on an older Bun starts fine and
then answers wrongly, which is this repo's worst failure class — a green exit
over a wrong answer.

```ts
export const MIN_BUN = [1, 4, 0] as const
isUnsupportedBun(version): boolean
unsupportedBunMessage(version): string
```

## What breaks below the floor

Measured on Bun 1.3.11 (2026-09-19, STATUS item 366), against the same tree
that is green on CI's pinned 1.4.2:

- A 2 MiB `--format json` answer reaches a pipe as **219 KB**. `bin.ts` ends
  stdout inside a callback precisely to prevent that; the fix does not hold
  below the floor.
- The runner reads no `peakRssBytes` at all, so `vx last` and `vx why` report
  nothing about what a task used.
- A config syntax error arrives as a `BuildMessage`, which the loader's
  classifier does not know, so it surfaces as an internal error instead of the
  `UserError` naming file, line and column.

Ten of that container's 23 failures were these three.

## Where the verdict is reported, and why there

`vx info`'s `bun` ROW, which already carried the version and not its meaning.
The typed field stays clean: `InfoFacts.bun` is the bare version a script
reads and `InfoFacts.bunSupported` is the verdict, because `--format json` is
a machine surface that a test holds to `Bun.version` exactly. The prose
appears only in the rendered row:

```
bun:              1.3.11 — unsupported, vx needs >= 1.4.0; answers may be wrong
```

Two designs were tried and measured against the repo before this one.

**A refusal**, mirroring `@vzn/vx-reapi`, which stops at its wire
(`wire.ts:assertBunSupportsChunking`). That is right for the plugin: its
failure mode is a **hang**, and a hang leaves the user nothing to read. Core's
failure mode is a wrong answer, and most of core works below the floor — 23 of
~2,000 tests failed there. "The tool does not start" is heavier than the
measurement supports.

**A warning on stderr from `bin.ts`**, before every verb. It cost 19 tests,
each asserting the same real property: a successful vx command writes NOTHING
to stderr. A diagnostic is not worth weakening that, and on a conforming
runtime the line never prints, so the relaxations would have been permanently
dead weight.

So the verdict goes where a reader already looks to ask whether the setup is
sane, beside the sandbox row and the config-error rows. The cost is stated: a
user who never runs `vx info` is not warned. That is proportionate to what was
measured — wrong answers on an unsupported runtime, not a broken tool.

A compiled binary carries its own Bun and the row never says it.

## Tests

`tests/bun-version.test.ts`:

- the comparison, major then minor then patch, over seven versions asserted as
  one set;
- a canary suffix judged by its release, junk treated as ancient;
- the doctor case, which asserts the row is flagged **exactly when this Bun is
  below the floor** — the same claim on a conforming runtime and on one below
  it, which is the only way a guard about the runtime can be tested on both;
- and the property the first draft broke: a clean invocation still writes
  nothing to stderr.
