// Module contract for `cli`: the top-level dispatcher plus re-exports
// for the test suite, which asserts on the pure parsers and formatters
// directly. Each subcommand handler lives in a sibling `<name>.ts`.

import { VERSION } from '../version.js'
import { runCmd } from './run.js'
import { devCmd } from './dev.js'
import { serveCmd } from './serve.js'
import { watchCmd } from './watch.js'
import { cacheCmd } from './cache.js'
import { lockCmd } from './lock.js'
import { migrateCmd } from './migrate.js'
import { upgradeCmd } from './upgrade.js'
import { showCmd } from './show.js'
import { infoCmd } from './info.js'
import { mcpCmd } from './mcp.js'
import { coordinatorCmd } from './coordinator.js'
import { workerCmd } from './worker.js'
import { printHelp } from './help.js'

export async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv

  switch (command) {
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      printHelp()
      return 0
    case '--version':
    case 'version':
      process.stdout.write(`vx ${VERSION}\n`)
      return 0
    case 'run':
      return await runCmd(rest)
    case 'dev':
      return await devCmd(rest)
    case 'serve':
      return await serveCmd(rest)
    case 'watch':
      return await watchCmd(rest)
    case 'cache':
      return await cacheCmd(rest)
    case 'lock':
      return await lockCmd(rest)
    case 'migrate':
      return await migrateCmd(rest)
    case 'upgrade':
      return await upgradeCmd(rest)
    case 'show':
      return await showCmd(rest)
    case 'info':
    case 'stats': // deprecated alias — `vx info` absorbed `vx stats`
      return await infoCmd(rest)
    case 'mcp':
      return await mcpCmd(rest)
    case 'coordinator':
      return await coordinatorCmd(rest)
    case 'worker':
      return await workerCmd(rest)
    default:
      process.stderr.write(`vx: unknown command: ${command}\n`)
      printHelp()
      return 1
  }
}

// Re-exports for tests + programmatic embedders.
export { detectFlow, parseRunArgs, type RunArgs } from './run.js'
export { parsePruneArgs, parseDuration, parseSize } from './cache.js'
export { parseLockArgs, type LockArgs } from './lock.js'
export { parseMigrateArgs, type MigrateArgs } from './migrate.js'
export { parseShowArgs, type ShowArgs } from './show.js'
export { parseServeArgs } from './serve.js'
export { parseMcpArgs, type McpArgs } from './mcp.js'
export {
  handleMcpRequest,
  listMcpTools,
  setMcpContext,
  type McpContext,
  type McpToolDef,
} from './mcp-rpc.js'
export { parseCoordinatorArgs, type CoordinatorArgs } from './coordinator.js'
export { parseWorkerArgs, type WorkerArgs } from './worker.js'
export { formatBytes } from './format.js'
