# @vzn/vx

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

The Vite of task orchestration: a Bun-native task runner and
content-addressed build cache for JavaScript monorepos, built as a
pipeline with a plugin hook at every stage.

```sh
bunx @vzn/vx init       # installs vx; .vx/workspace.ts and a vx.config.ts (per package in a Turbo or Nx repo)
bunx @vzn/vx lock            # after editing a vx.config: runs read the lock
bunx @vzn/vx run build --all # a local install's vx is not on PATH: bunx (or npx) runs it
```

- Documentation: <https://vznjs.github.io/vx/>
- Source, benchmarks and the plugin packages: <https://github.com/vznjs/vx>

Core applies no plugin by default and ships none: with no plugin a run
still runs tasks here and caches them on this machine (entries in
`~/.vx/<id>/cache`, shared by every checkout of the repo). The
workspace needs a `.vx/workspace.ts` (`vx init` writes one); it marks
the root. Scheduling by learned critical path:
`@vzn/vx-history`. One run spread over your own CI's workers:
`@vzn/vx-dte`. Remote caching and execution over Bazel's
REAPI: `@vzn/vx-reapi`. Telemetry: `@vzn/vx-otel`, `@vzn/vx-ci`. AI agents:
the skill in `skills/vx/` (`bunx skills add vznjs/vx`).
