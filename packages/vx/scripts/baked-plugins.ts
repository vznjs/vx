// The plugin packages `@vzn/vx/plugins` (plugins/index.ts) re-exports and
// the compiled binary carries, as directories beside core: the published
// @vzn/vx depends on them (build-npm.ts), and the compile tasks read and
// key them (vx.config.ts). Not vx-reapi or vx-migrate: each reads files
// beside its own source at run time, which a bundle does not have.
// tests/baked-plugins.test.ts holds plugins/index.ts to this list.
export const BAKED_PLUGINS = [
  'vx-github',
  'vx-lockfile',
  'vx-mcp',
  'vx-otel',
  'vx-schedule-history',
] as const
