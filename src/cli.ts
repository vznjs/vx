// Top-level CLI dispatcher. Each subcommand handler lives in
// `src/cli/<name>.ts`. Re-exports below are for the test suite,
// which asserts on the pure parsers and formatters directly.

import { VERSION } from './index.js'
import { runCmd } from './cli/run.js'
import { cacheCmd } from './cli/cache.js'
import { printHelp } from './cli/help.js'

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
    case 'cache':
      return await cacheCmd(rest)
    default:
      process.stderr.write(`vx: unknown command: ${command}\n`)
      printHelp()
      return 1
  }
}

// Re-exports for tests + programmatic embedders.
export { parseRunArgs, type RunArgs } from './cli/run.js'
export { parsePruneArgs, parseDuration, parseSize } from './cli/cache.js'
export { formatBytes } from './cli/format.js'
