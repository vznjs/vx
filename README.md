# @vzn/vx

Pre-alpha. Currently exports one thing: `loadConfig` from `src/config/`.

```ts
import { loadConfig } from '@vzn/vx'

const config = await loadConfig('/abs/path/to/vx.config.ts')
// config: whatever the file `export default`-ed, typed as ProjectConfig ({})
```

That's the whole API. No file discovery, no extension iteration, no schema, no validation. The caller picks the path; this module loads it.

See [`src/config/README.md`](src/config/README.md).

## Develop

```bash
bun install
bun test
bun x oxfmt --check .
bun x oxlint --type-aware --type-check
bun bench/config/load.bench.ts
```

## License

[MIT](LICENSE).
