// What the plugin packages' tests import from core's helpers, as
// `@vzn/vx/testing` through their node_modules: a project never reads
// another by path (M, 2026-11-25). Never published: build-npm ships only
// the exports whose target it ships. `@vzn/vx#testing` keys these files.
export { lock, planRun, run } from './orchestrator.js'
export { silentLogger } from './orchestrator-fixture.js'
export { PLUGIN_IMPORT, pluginSource } from './plugin.js'
export { planned, vx } from './parity.js'
export { git, gitInit } from './workspace.js'
// Core internals the dependants' tests drive directly.
export { indexDb } from '../../src/cache/index.js'
export { computeReverseDepCount, runGraph } from '../../src/graph/index.js'
export { mergePriorities } from '../../src/graph/priorities.js'
export { LocalHistoryProvider } from '../../src/history/index.js'
