// Module contract for `cli`: the top-level dispatcher plus re-exports
// for the test suite, which asserts on the pure parsers and formatters
// directly. Each subcommand handler lives in a sibling `<name>.ts`.

import { VERSION } from '../version.js'
import { runCmd } from './run.js'
import { printHelp } from './help.js'
import { pluginCommandHelp, resolvePluginCommand } from './plugin-commands.js'
import { UserError } from '../util/index.js'

// Every verb but `run` is imported when invoked. `vx run` is the hot path
// and nearly every invocation; the other verbs' modules are code that
// process never calls. Measured 2026-09-03: `--version` is 25 ms either
// way (module loading is not where start-up goes), so this is hygiene, not
// a speed-up. The specifiers are string literals, so `bun build --compile`
// still embeds them.

export async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv

  switch (command) {
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      printHelp(await pluginCommandHelp())
      return 0
    case '--version':
    case 'version':
      process.stdout.write(`vx ${VERSION}\n`)
      return 0
    case 'run':
      return await runCmd(rest)
    case 'watch':
      return await (await import('./watch.js')).watchCmd(rest)
    case 'cache':
      return await (await import('./cache.js')).cacheCmd(rest)
    case 'lock':
      return await (await import('./lock.js')).lockCmd(rest)
    case 'migrate':
      return await (await import('./migrate.js')).migrateCmd(rest)
    case 'init':
      // A workspace from nowhere: package.json scripts are the source.
      return await (
        await import('./migrate.js')
      ).migrateCmd(['--from', 'scripts', ...rest], { init: true })
    case 'upgrade':
      return await (await import('./upgrade.js')).upgradeCmd(rest)
    case 'show':
      return await (await import('./show.js')).showCmd(rest)
    case 'info':
    case 'stats': // deprecated alias — `vx info` absorbed `vx stats`
      return await (await import('./info.js')).infoCmd(rest)
    case 'why':
      return await (await import('./why.js')).whyCmd(rest)
    case 'last':
      return await (await import('./last.js')).lastCmd(rest)
    case 'prune':
      return await (await import('./prune.js')).pruneWorkspaceCmd(rest)
    default: {
      // Not a core verb: a plugin declared in the workspace around the cwd
      // may own it (`VxPlugin.commands`). Core verbs were matched above, so
      // nothing here can shadow them.
      const resolved = await resolvePluginCommand(command)
      if (resolved !== null && !('loadError' in resolved)) {
        const code = await resolved.command.run(rest, resolved.ctx)
        // A plugin is a boundary: a JS-authored verb that resolves nothing
        // would reach `process.exit(undefined)` and read as SUCCESS. A verb
        // that cannot say whether it succeeded fails, naming its owner.
        if (!Number.isInteger(code)) {
          throw new UserError(
            `plugin '${resolved.plugin.name}': command '${command}' resolved ${JSON.stringify(code)} instead of an exit code`,
          )
        }
        return code
      }
      // A broken workspace file cannot say whether the verb exists. Say
      // both things: the verb is unknown HERE, and why the lookup could not
      // finish — a typo still reads as a typo, and a real plugin verb still
      // points at the file that broke it.
      const loadNote =
        resolved !== null && 'loadError' in resolved
          ? `\n  (plugin verbs could not be looked up: vx.workspace failed to load: ${resolved.loadError})`
          : ''
      if (command === 'serve' || command === 'dev') {
        // vx core is only a task runner — it has no service layer of its
        // own. A dashboard, remote cache, distributed execution, etc. are
        // provided by PLUGINS (declared in vx.workspace.ts), never by core.
        // We keep this neutral hint for the common muscle-memory verbs, but
        // core names no specific plugin package: any package can provide
        // these.
        process.stderr.write(
          `vx: '${command}' is not a vx core command.\n` +
            `  vx core runs tasks in-process. A dashboard, remote cache, and\n` +
            `  distributed execution come from plugins — not core. See the plugin\n` +
            `  guide: https://vznjs.github.io/vx/guides/plugins/\n`,
        )
        return 1
      }
      process.stderr.write(`vx: unknown command: ${command}${loadNote}\n`)
      printHelp()
      return 1
    }
  }
}

// Re-exports for tests + programmatic embedders.
export { detectFlow, parseRunArgs, resolveRunOptions, type RunArgs } from './run.js'
export { parsePruneArgs, parseDuration, parseSize } from './cache.js'
export { parseLockArgs, type LockArgs } from './lock.js'
export { parseMigrateArgs, type MigrateArgs } from './migrate.js'
export { parseShowArgs, type ShowArgs } from './show.js'
export { parseWhyArgs } from './why.js'
export { parseLastArgs } from './last.js'
export { parsePruneWorkspaceArgs } from './prune.js'
export { formatBytes } from './format.js'
