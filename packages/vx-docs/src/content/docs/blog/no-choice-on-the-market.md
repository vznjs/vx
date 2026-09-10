---
title: 'There was no choice on the market'
date: 2026-09-10
authors:
  - vzn
tags:
  - comparison
  - design
excerpt: "Turborepo is fast and stops at the edge of a laptop. Nx scales and is a product with a runner attached. Between a tool that will not grow and a platform that will not get out of the way, the thing a large JavaScript monorepo actually needs did not exist. That is why vx does."
---

vx exists because of a gap, and the gap is easiest to describe by what
sits on either side of it.

## Turborepo: fast, and it stops

Turborepo got the important thing right. One `turbo.json`, a
content-addressed cache, `dependsOn` micro-syntax that reads the way
you think, a `--filter` DSL borrowed from pnpm. It is quick on a warm
cache and it stays out of the way.

It also stops. Everything beyond "run it here and cache it in Vercel's
remote cache" is either absent or marked experimental. There is no
remote execution and no seam to add one. There is no way to change
where a task runs. The config is JSON, so a shared input list is a
`globalDependencies` array you keep in sync by hand, and nothing
computed can participate in a key. Inputs default to every file in the
package, which turns a README edit into a rebuild and makes the
per-task overhead visible in the [solidjs/solid
benchmark](../honest-benchmarks/). Outputs are restored additively, so
a deleted file survives a cache hit. And the parts that would have
grown into a platform are being deprecated rather than finished: the
daemon, `--parallel`, `--no-cache`, `--remote-only` are all deprecated
in 2.10, and the flag surface is the largest of any tool in this space.

Turborepo is the right tool until the repository is large enough or
the team needs something it cannot do, and then there is no next step
inside it.

## Nx: scales, and it is a product

Nx got the other important thing right. It has a project graph that
scales, `affected` that works, and a plugin model that reaches into
Rust, .NET, Java and Gradle. The company behind it is serious about
large repositories.

It is also a product, and the runner is the part of the product that
gets you to the rest. The features that make a large monorepo bearable,
distributed task execution, remote cache, flaky-test detection, the
graph visualiser, the analytics, are Nx Cloud, paid and walled. The
open-source runner carries a daemon that is on by default, a heavy
schema (`project.json`, `nx.json`, `namedInputs`, `targetDefaults`,
executors wrapping every tool behind a JSON options object), and a
cold-run cost that is not in the same league: on the same 3,270-task
workspace, Nx's cold build burns 114 minutes of CPU where Turborepo
burns 73 seconds and vx 35. A fully cached run takes 3.59 s against
Turborepo's 0.76 s, with the daemon running.

Nx is the right tool if you want the platform. If you want the runner,
you pay for the platform's weight and are steered toward its price.

## The gap

Between them is the thing a large JavaScript monorepo actually needs:

- a runner as small and as fast as Turborepo's, on the warm path and
  the cold one;
- a key that is correct in the cases Turbo's is not: computed config,
  strict outputs, no spurious miss at a commit;
- seams for the things Nx sells, remote execution, remote cache, task
  scheduling, telemetry, so that they can be built by anyone, on any
  wire, without the runner having an opinion about who provides them;
- no daemon, no account, no cloud, no dashboard, nothing that needs a
  business model to keep working.

Nobody was building that, for a reason that is not technical: the
seams are where the money is. A runner whose remote execution is a
plugin on a public API is a runner nobody can sell a cloud for. vx is
built that way on purpose and ships nothing distributed in its own
repository. `@vzn/vx-reapi`, which does remote cache and remote
execution against any Bazel Remote Execution API server, exists to
prove the seams are wide enough for someone else to build the
platform, and to make sure no one has to.

## The bar

vx has to clear the same bar as both of them, and the way to know is
to run their tests. The parity suite in the repository takes the
behaviours a Turborepo or Nx user would reach for, spells each one in
vx, and pins it with a test that runs the real CLI. Where vx diverges
on purpose (bare task names never widen an anchored `pkg#task`'s
scope; there is no `--parallel` because `dependsOn` is explicit) the
divergence is documented as such. The matrix is
[Compared to Turborepo, Nx, vite-task](../../comparison/), and every
claim in it cites a file in the upstream repository so it can be
re-verified as they change.

That is what "no choice on the market" meant: not that the others are
bad, but that they are each half of the tool, and the halves do not
combine. vx is the whole runner and nothing else.
