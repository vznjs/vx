# @vzn/vx

Website: <https://vznjs.github.io/vx/> · source: <https://github.com/vznjs/vx>

The Vite of task orchestration: a Bun-native task runner and
content-addressed build cache for JavaScript monorepos, built as a
pipeline with a plugin hook at every stage.

```sh
bun add -d @vzn/vx      # or npm / pnpm / yarn
vx init                 # .vx/workspace.ts + a vx.config.ts per package (via @vzn/vx-migrate)
vx run build --all
```

- Documentation: <https://vznjs.github.io/vx/>
- Source, benchmarks and the plugin packages: <https://github.com/vznjs/vx>

Core applies no plugin by default and ships none; running here and
caching on this machine (entries in `~/.vx/<id>/cache`, shared by every
checkout of the repo) are its floor, so a workspace with no
`.vx/workspace.ts` runs. Scheduling by learned critical path:
`@vzn/vx-history`. One run spread over your own CI's workers:
`@vzn/vx-dte` (not on npm yet). Remote caching and execution over Bazel's
REAPI: `@vzn/vx-reapi`. Telemetry: `@vzn/vx-otel`, `@vzn/vx-ci`. AI agents:
the skill in `skills/vx/` (`bunx skills add vznjs/vx`).
