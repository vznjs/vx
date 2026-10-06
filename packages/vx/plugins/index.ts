// `@vzn/vx/plugins`: the first-party plugins vx ships with. The compiled
// binary serves its own compiled-in copy of this module
// (src/cli/core-alias.ts), so a workspace installs nothing for them; from
// source each resolves as its package, which the published @vzn/vx
// depends on (scripts/build-npm.ts). The list is scripts/baked-plugins.ts.
export * from '@vzn/vx-github'
export * from '@vzn/vx-lockfile'
export * from '@vzn/vx-mcp'
export * from '@vzn/vx-otel'
export * from '@vzn/vx-schedule-history'
