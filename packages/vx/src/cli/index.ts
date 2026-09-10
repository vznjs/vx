// Module contract for `cli`: the top-level dispatcher plus re-exports
// for the test suite, which asserts on the pure parsers and formatters
// directly. Each subcommand handler lives in a sibling `<name>.ts`.

import { VERSION } from '../version.js'
import { runCmd } from './run.js'
import { CORE_VERBS, printHelp } from './help.js'
import { pluginCommandHelp, resolvePluginCommand } from './plugin-commands.js'
import { MOVED_VERBS, nearest, UserError } from '../util/index.js'

// Every verb but `run` is imported when invoked. `vx run` is the hot path
// and nearly every invocation; the other verbs' modules are code that
// process never calls. Measured 2026-09-03: `--version` is 25 ms either
// way (module loading is not where start-up goes), so this is hygiene, not
// a speed-up. The specifiers are string literals, so `bun build --compile`
// still embeds them.

export async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv

  // `vx <verb> --help` is the universal reflex, and every verb answered
  // `unknown flag: --help` and exited 1 (walkthrough, 2026-09-04). Only args
  // BEFORE a `--` count: `vx run build -- --help` forwards it to the task,
  // which is the one place `--help` is not being asked of vx. Core verbs
  // only — a plugin verb owns its own arguments, `--help` included.
  if (command !== undefined && wantsHelp(command, rest)) {
    printHelp(await pluginCommandHelp())
    return 0
  }

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
    case 'init':
      return await (await import('./init.js')).initCmd(rest)
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
      // A verb core owned once (`migrate`, `prune`) and a package owns now:
      // the pointer, but only after the plugins had their chance — a
      // workspace that declares @vzn/vx-prune keeps `vx prune`.
      const moved = MOVED_VERBS[command]
      if (moved !== undefined) {
        process.stderr.write(`${moved}${loadNote}\n`)
        return 1
      }
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
      process.stderr.write(`vx: unknown command: ${command}${didYouMeanVerb(command)}${loadNote}\n`)
      printHelp()
      return 1
    }
  }
}

// Re-exports for tests + programmatic embedders.
export { detectFlow, parseRunArgs, resolveRunOptions, type RunArgs } from './run.js'
export { parsePruneArgs, parseDuration, parseSize } from './cache.js'
export { parseLockArgs, type LockArgs } from './lock.js'
export { parseInitArgs, type InitArgs } from './init.js'
export { parseShowArgs, type ShowArgs } from './show.js'
export { parseWhyArgs } from './why.js'
export { parseLastArgs } from './last.js'
export { formatBytes } from './format.js'

/**
 * Is this invocation asking for help rather than work? See the call site for
 * why the scan stops at `--`, and why plugin verbs are excluded.
 */
function wantsHelp(command: string, rest: readonly string[]): boolean {
  if (!(CORE_VERBS as readonly string[]).includes(command)) return false
  const sep = rest.indexOf('--')
  const own = sep === -1 ? rest : rest.slice(0, sep)
  return own.includes('--help') || own.includes('-h')
}

/** ` Did you mean run?` for a verb within two edits of a core one — the same
 *  hint a task or flag typo gets. Plugin verbs are not listed: resolving
 *  them loads the workspace, and this path is reached only when that
 *  lookup found nothing. */
function didYouMeanVerb(verb: string): string {
  const best = nearest(verb, CORE_VERBS)
  return best === undefined ? '' : `. Did you mean ${best}?`
}
