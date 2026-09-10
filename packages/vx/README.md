# @vzn/vx

The Vite of task orchestration: a Bun-native task runner and
content-addressed build cache for JavaScript monorepos, built as a
pipeline with a plugin hook at every stage.

```sh
bun add -d @vzn/vx      # or npm / pnpm / yarn
vx init                 # scaffold vx.workspace.ts + a vx.config.ts per package
vx run build --all
```

- Documentation: <https://vznjs.github.io/vx/>
- Source, benchmarks and the plugin packages: <https://github.com/vznjs/vx>

Core applies no plugin by default and ships none; running here and
caching in `.vx/cache` are its floor, so a workspace with no
`vx.workspace.ts` runs. Scheduling by learned critical path:
`@vzn/vx-schedule-history`. Remote caching and execution:
`@vzn/vx-reapi`. Telemetry: `@vzn/vx-otel`, `@vzn/vx-github`. AI agents:
`@vzn/vx-mcp`.
