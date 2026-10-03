// Module contract for `cli`: the top-level dispatcher. Each subcommand
// handler lives in a sibling `<name>.ts`; tests import its parsers there.

import { VERSION } from '../version.js'
import { CORE_VERBS, flagHint, printHelp, refusedWord, seeHelp } from './help.js'
import { FOREIGN_VERBS } from './foreign-flags.js'
import { isUserError, MOVED_VERBS, nearest, UserError } from '../util/index.js'

// Every verb is imported when invoked, `run` included, and so is the
// plugin-verb lookup: each pulls in the orchestrator and the workspace
// loader, 49 ms of a 65 ms `vx --version` (2026-09-30). This file once
// re-exported the verbs' parsers for tests, which loaded every verb on
// every start. The specifiers are string literals, so `bun build
// --compile` still embeds them.
const plugins = () => import('./plugin-commands.js')

export async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv

  // `vx <verb> --help` is the universal reflex, and every verb answered
  // `unknown flag: --help` and exited 1 (walkthrough, 2026-09-04). Only args
  // BEFORE a `--` count: `vx run build -- --help` forwards it to the task,
  // which is the one place `--help` is not being asked of vx. Core verbs
  // only — a plugin verb owns its own arguments, `--help` included.
  if (command !== undefined && wantsHelp(command, rest)) {
    await printHelp(await (await plugins()).pluginCommandHelp(), command)
    return 0
  }

  switch (command) {
    case undefined: {
      // A bare `vx` where no workspace is printed 151 lines of help, none
      // of which says the one thing wrong: there is nothing here to run.
      const { findWorkspaceRoot } = await import('../workspace/index.js')
      try {
        await findWorkspaceRoot(process.cwd())
      } catch (err) {
        if (!isUserError(err)) throw err
        process.stderr.write(`vx: ${err.message}; \`vx help\` lists the verbs\n`)
        return 1
      }
      await printHelp(await (await plugins()).pluginCommandHelp())
      return 0
    }
    case '--help':
    case '-h':
      await printHelp(await (await plugins()).pluginCommandHelp())
      return 0
    case 'help': {
      // `vx help run` is the same question as `vx run --help`. A plugin verb
      // owns its own help, so anything but a core verb gets the whole
      // reference, which lists the plugin verbs.
      const verb = rest[0]
      const core = verb !== undefined && (CORE_VERBS as readonly string[]).includes(verb)
      if (verb !== undefined && !core) {
        // A name that is no verb here is the typo `vx rnu` is, not a request
        // for the whole reference: it printed 145 lines and no hint.
        const resolved = await (await plugins()).resolvePluginCommand(verb)
        const unknown = resolved === null || 'declaredVerbs' in resolved
        const pointer = MOVED_VERBS[verb] ?? FOREIGN_VERBS[verb]
        if (unknown && pointer !== undefined) {
          process.stderr.write(`${pointer}\n`)
          return 1
        }
        if (unknown && verb.startsWith('-')) {
          process.stderr.write(
            `vx help: unknown flag: ${verb}${flagHint('help', verb)} (see \`vx help\`)\n`,
          )
          return 1
        }
        if (unknown) {
          const declared = resolved === null ? [] : resolved.declaredVerbs
          process.stderr.write(
            `vx help: unknown command: ${verb}${didYouMeanVerb(verb, declared)} (see \`vx help\`)\n`,
          )
          return 1
        }
      }
      await printHelp(await (await plugins()).pluginCommandHelp(), core ? verb : undefined)
      return 0
    }
    case '--version':
    case 'version': {
      // `vx version --hlp` printed the version and exited 0: a word it
      // takes no more of is refused, as every other verb refuses one.
      const extra = rest[0]
      if (extra !== undefined) {
        process.stderr.write(
          `vx version: ${refusedWord(extra)}: ${extra}${flagHint('version', extra)}${seeHelp('version')}\n`,
        )
        return 1
      }
      process.stdout.write(`vx ${VERSION}\n`)
      return 0
    }
    case 'run':
      return await (await import('./run.js')).runCmd(rest)
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
      return await (await import('./info.js')).infoCmd(rest)
    case 'why':
      return await (await import('./why.js')).whyCmd(rest)
    case 'last':
      return await (await import('./last.js')).lastCmd(rest)
    case 'completions':
      return await (
        await import('./completions.js')
      ).completionsCmd(rest, await (await plugins()).pluginVerbs())
    default: {
      // Not a core verb: a plugin declared in the workspace around the cwd
      // may own it (`VxPlugin.commands`). Core verbs were matched above, so
      // nothing here can shadow them.
      const resolved = await (await plugins()).resolvePluginCommand(command)
      if (resolved !== null && !('loadError' in resolved) && !('declaredVerbs' in resolved)) {
        let code: number
        try {
          code = await resolved.command.run(rest, resolved.ctx)
        } catch (err) {
          // A verb's own refusal is its one line; anything else is the
          // plugin's crash, named as every other stage names one.
          if (isUserError(err)) throw err
          const message = err instanceof Error ? err.message : String(err)
          throw new UserError(
            `plugin '${resolved.plugin.name}' failed in command '${command}': ${message}`,
          )
        }
        // A plugin is a boundary: a JS-authored verb that resolves nothing
        // would reach `process.exit(undefined)` and read as SUCCESS. A verb
        // that cannot say whether it succeeded fails, naming its owner. So
        // does one past a byte: the OS keeps the low eight bits, and a verb
        // that returned 256 (a count of failures, say) exited 0.
        if (!Number.isInteger(code) || code < 0 || code > 255) {
          throw new UserError(
            `plugin '${resolved.plugin.name}': command '${command}' resolved ${JSON.stringify(code)} instead of an exit code (an integer 0–255)`,
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
      // workspace that declares a plugin verb of that name keeps it.
      const moved = MOVED_VERBS[command] ?? FOREIGN_VERBS[command]
      if (moved !== undefined) {
        process.stderr.write(`${moved}${loadNote}\n`)
        return 1
      }
      // A task typed where the verb goes (`turbo build`, `nx build app`),
      // `turbo dev` included: a repo's own `dev` task beats the no-service note.
      const declaredVerbs =
        resolved !== null && 'declaredVerbs' in resolved ? resolved.declaredVerbs : []
      const guess = didYouMeanVerb(command, declaredVerbs)
      // A typo of a task (`vx biuld`) names the task, unless a verb is closer.
      const task =
        loadNote === ''
          ? await (
              await import('./task-verb.js')
            ).taskVerbHint(command, rest, process.cwd(), guess === '' && !command.startsWith('-'))
          : null
      if (task !== null) {
        process.stderr.write(`vx: ${task}\n`)
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
      // One line, as a verb's own unknown flag or subcommand gets; the full
      // help after a typo was a hundred lines past the hint that mattered.
      // The verbs this workspace's plugins declare are verbs HERE, so they
      // join the "did you mean" set, and when nothing is close the second
      // line says where a verb can come from: `vx mpc` in a workspace
      // declaring `mcp` read as a plain unknown command, and `vx mcp`
      // before the plugin was declared said nothing about the file that
      // would declare it (2026-09-20).
      // A word that opens with a dash is a flag, and vx itself takes only
      // --help and --version: "unknown command: --bogus" named the wrong
      // thing (M-60).
      if (command.startsWith('-')) {
        // `-v` / `-V` is another tool's version flag, far from both names.
        const flag = /^-v$/i.test(command) ? '--version' : nearest(command, ['--help', '--version'])
        process.stderr.write(
          `vx: unknown flag: ${command}${flag === undefined ? '' : ` (did you mean ${flag}?)`}; a verb's flags follow the verb (see \`vx help\`)\n`,
        )
        return 1
      }
      process.stderr.write(
        `vx: unknown command: ${command}${guess}${loadNote} (see \`vx help\`)\n` +
          (guess === '' && loadNote === '' ? verbSourceNote(resolved, declaredVerbs) : ''),
      )
      return 1
    }
  }
}

export { registerCoreAlias } from './core-alias.js'

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

/** ` Did you mean run?` for a verb within two edits of a core one, or of a
 *  verb this workspace's plugins declare — the same hint a task or flag typo
 *  gets. The plugin verbs come from the lookup that just failed, so they
 *  cost no second load. */
function didYouMeanVerb(verb: string, pluginVerbsHere: readonly string[] = []): string {
  const best = nearest(verb, [...CORE_VERBS, ...pluginVerbsHere])
  return best === undefined ? '' : `. Did you mean ${best}?`
}

/**
 * Where a verb that is neither core nor declared COULD come from. Only when
 * nothing is close enough to guess: after a plain typo the guess is the
 * answer, and a second line would bury it.
 */
function verbSourceNote(resolved: unknown, declaredVerbs: readonly string[]): string {
  if (declaredVerbs.length > 0) {
    return `  This workspace's plugins declare: ${[...declaredVerbs].sort().join(', ')}.\n`
  }
  const here = resolved === null ? 'there is no workspace here' : 'this workspace declares none'
  return `  A plugin declared in vx.workspace.ts can add verbs; ${here}.\n`
}
