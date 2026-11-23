---
title: Cache a task
description: Give a task its inputs, its outputs and cache true, and vx skips it when nothing changed.
---

To cache a task, tell vx three things: the files it reads, the files it
writes, and `cache: true`.

```ts title="packages/ui/vx.config.ts" mark={7-9}
import type { ProjectConfig } from '@vzn/vx/config'

export default {
  tasks: {
    build: {
      exec: { command: 'vite build' },
      inputs: { files: ['src/**', 'index.html', 'vite.config.ts'] },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
  },
} satisfies ProjectConfig
```

| Key | What it means |
| --- | --- |
| `inputs.files` | the files the command reads; change one and the task runs again |
| `outputs.files` | the files the command writes; vx saves them and puts them back on a hit |
| `cache: true` | turns caching on; without it the task runs every time |

Run `vx lock`, then run the task twice. The second run does no work and
ends `up-to-date`. Globs are relative to the project's folder.

---

## Every output must exist

Each pattern in `outputs.files` must match at least one file after the
command ends. If one matches nothing, the task **fails** and vx saves
nothing:

```sh
vx run @demo/ui#build
```

```ansi
[2m┌─[0m [1m[38;2;192;132;252m@demo/ui[0m[2m#[0m[1m[38;2;244;114;182mbuild[0m [2m>[0m $ mkdir -p dist && cp src/index.ts dist/index.js
[1m[38;2;234;179;8m[vx][0m[2m @demo/ui#build: outputs matched no files (dist/main.js) — the command exited 0 but never wrote it, so the task fails and nothing is cached: write it, or fix the pattern[0m
[2m└─[0m [1m[38;2;192;132;252m@demo/ui[0m[2m#[0m[1m[38;2;244;114;182mbuild[0m [2m──[0m [2m(8ms)[0m [1m[38;2;239;68;68mfailed (exited 0, no file matched dist/main.js)[0m
```

Here the command wrote `dist/index.js`, but the config says
`dist/main.js`. Fix the pattern, or make the command write that file.

---

## Find why a task ran again

`vx why` names the input that changed since the last run. See
[Find why a task missed the cache](../why-a-task-missed/).

See [Caching](../../../docs/caching/).
