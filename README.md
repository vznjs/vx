# @vzn/vx

Pre-alpha. One module: `src/project/`.

```ts
import { defineProject, loadProject } from '@vzn/vx'

// In vx.config.ts:
export default defineProject({})

// Anywhere else:
const project = await loadProject('/abs/path/to/project-dir')
```

`loadProject(dir)` finds `vx.config.{ts,mts,js,mjs}` in the given directory (first match wins, in that order), imports it, and parses the default export through `ProjectSchema` (zod, currently strict + empty). `defineProject` is identity at runtime — it exists for type inference inside config files.

See [`src/project/README.md`](src/project/README.md).

## Develop

```bash
bun install
bun test
bun x oxfmt --check .
bun x oxlint --type-aware --type-check
bun bench/project/load.bench.ts
```

## License

[MIT](LICENSE).
