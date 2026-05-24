# @vzn/vx

Pre-alpha. Currently exports one thing: `loadConfigs` from `src/config/`.

## What's here

```ts
import { loadConfigs } from '@vzn/vx'

const loaded = await loadConfigs([
  { name: 'pkg-a', dir: '/abs/path/packages/a' },
  { name: 'pkg-b', dir: '/abs/path/packages/b' },
])

// loaded: Array<{ source: { name, dir }, config: unknown }>
```

`loadConfigs` finds `vx.config.{ts,mts,js,mjs}` in each source directory, imports it, and returns whatever the file `export default`-ed. No validation; no schema.

See [`src/config/README.md`](src/config/README.md) for the full contract.

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
