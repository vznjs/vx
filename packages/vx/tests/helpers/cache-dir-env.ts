// The gate's test tasks set VX_CACHE_DIR=.vx/cache (vx.config.ts), so each
// fixture keeps its whole cache in its own directory instead of sharing
// entries through the user's store. A bare `bun test` gets the same here
// for every run in this process and every child spawned with
// `env: { ...process.env }`; a child spawned with no `env` reads the
// process's startup environment, which a preload cannot reach.
process.env['VX_CACHE_DIR'] ??= '.vx/cache'
