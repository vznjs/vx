// The plugin packages the standalone binary carries compiled in
// (scripts/compile.ts; why in src/cli/core-alias.ts), as directories
// beside core. Not vx-reapi or vx-migrate: each reads files beside its
// own source at run time (protos, nx-exec.cjs, its mapping sources),
// which a baked copy does not have.
export const BAKED_PLUGINS = [
  'vx-github',
  'vx-lockfile',
  'vx-mcp',
  'vx-otel',
  'vx-schedule-history',
] as const
