# @vzn/vx

vx is a task orchestrator. It runs your tasks in the right order, many
at once, and never does the same work twice. JavaScript support comes
from plugins, and any other system can hook in the same way.

```sh
bunx @vzn/vx init       # installs vx and writes .vx/workspace.ts
vx lock                 # after each vx.config.ts change: runs read the lock
vx run build --all      # every project's build, dependencies first
```

- Docs: <https://vznjs.github.io/vx/>, starting with the [Quickstart](https://vznjs.github.io/vx/quickstart/)
- Source, plugins and benchmarks: <https://github.com/vznjs/vx>

Core needs no plugin: without one, vx runs and caches on your machine.
Plugins add a remote cache, Distributed task execution, telemetry and
more: see [Plugins](https://vznjs.github.io/vx/docs/plugins/).

For AI agents, `bunx skills add vznjs/vx` adds the vx skill.
