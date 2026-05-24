# @vzn/vx

Pre-alpha. One module: `src/project/`.

```ts
import { defineProject, loadProject } from '@vzn/vx'

// In vx.config.ts:
export default defineProject({})

// Anywhere else:
const project = await loadProject('/abs/path/to/vx.config.ts')
```

That's the whole API. No file discovery, no extension iteration, no schema, no validation. Caller picks the path; the module loads it. `defineProject` is identity at runtime — it exists for type inference inside config files.

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
