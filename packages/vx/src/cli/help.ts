import {
  CORE_VERBS,
  detectColors,
  errorDocument,
  maskedLine,
  nearest,
  paint,
  refusalNotice,
  ui,
  wantsJson,
  type ColorSupport,
} from '../util/index.js'

export async function printHelp(
  pluginCommands: readonly string[] = [],
  verb?: string,
): Promise<void> {
  const text = verb === undefined ? helpText(pluginCommands) : verbHelpText(verb)
  process.stdout.write(paintHelp(text, helpColors(process.stdout, detectColors), paint))
}

/**
 * Help paints on a terminal only. `FORCE_COLOR=1` set for a run's log in
 * CI does not paint it: a script that greps `vx help` (or reads the flag
 * list from it) gets plain text whatever forces colour elsewhere.
 */
export function helpColors(
  stream: { isTTY?: boolean },
  detect: (s: NodeJS.WriteStream) => ColorSupport,
): ColorSupport {
  return { enabled: stream.isTTY === true && detect(stream as NodeJS.WriteStream).enabled }
}

const VERB = '#06b6d4' // cyan-500 — the orchestrator's accent
const TERM = '#22d3ee' // cyan-400 — a flag, a selector, an example

/**
 * The reference with ANSI accents, line by line and never reflowed, so the
 * painted text strips back to `text` exactly: section headings bold (their
 * `(for <verb>)` dim), `vx <verb>` bold cyan, and the term an option or
 * example line opens with cyan. Prose and continuation lines stay plain.
 */
export function paintHelp(text: string, colors: ColorSupport, paint: Paint): string {
  if (!colors.enabled) return text
  const lines = text.split('\n')
  return lines
    .map((line, i) => {
      if (line === '') return line
      if (i === 0) {
        const [name, ...rest] = line.split(' ')
        return [paint(VERB, name!, colors, { bold: true }), ...rest].join(' ')
      }
      const heading = /^([A-Z][^:]*?)( \(for [^)]*\))?:$/.exec(line)
      if (heading !== null) {
        const qualifier =
          heading[2] === undefined ? '' : paint('', heading[2], colors, { dim: true })
        return `${paint('', heading[1]!, colors, { bold: true })}${qualifier}${paint('', ':', colors, { bold: true })}`
      }
      // `  term   description`: a term is a flag, a `vx` form, a selector.
      const row = /^(\s+)(\S(?:.*?\S)?)(\s{2,}\S.*)?$/.exec(line)
      if (row === null) return line
      const [, indent, term, description = ''] = row
      if (/^vx \S/.test(term!)) {
        const verb = term!.split(' ')[1]!
        // Prose that opens with `vx` (`vx core runs tasks…`) is not a form.
        if (description === '' && !(CORE_VERBS as readonly string[]).includes(verb)) return line
        const head = `vx ${verb}`
        const tail = term!.slice(head.length)
        return `${indent}${paint(VERB, head, colors, { bold: true })}${tail === '' ? '' : paint(TERM, tail, colors)}${description}`
      }
      if (description === '') return line
      if (/^(-|\(|[\w-]+#)/.test(term!))
        return `${indent}${paint(TERM, term!, colors)}${description}`
      return line
    })
    .join('\n')
}

/**
 * `vx <verb> --help`: the reference cut to one verb — the title, the Usage
 * lines that name it, and every section that is `(for <verb>)` or lists a
 * `vx <verb>` form — read from the same text, so nothing can drift. A verb
 * the reference does not know gets the whole thing.
 */
export function verbHelpText(verb: string): string {
  const blocks = helpText().split('\n\n')
  const title = blocks[0]!
  // The verb goes into a RegExp, so it is escaped: `vx 'r.n' --help` is an
  // unknown verb, not a pattern that matches `vx run` and answers with a
  // help cut for a verb that does not exist.
  const quoted = verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const names = (line: string): boolean =>
    new RegExp(`^\\s*vx ${quoted}( |$)`).test(line) ||
    line.includes(`(for ${verb})`) ||
    line.includes(`(for ${verb} `)
  const kept: string[] = []
  for (const block of blocks.slice(1)) {
    const lines = block.split('\n')
    if (lines[0] === 'Usage:') {
      const own = lines.slice(1).filter(names)
      if (own.length > 0) kept.push(['Usage:', ...own].join('\n'))
      continue
    }
    if (lines.some(names)) kept.push(block)
  }
  if (kept.length === 0) return helpText()
  return [title, ...kept, 'Full reference: vx help', ''].join('\n\n')
}

export function helpText(pluginCommands: readonly string[] = []): string {
  return [
    'vx — task orchestration you own',
    '',
    'Usage:',
    '  vx run [OPTIONS] [TASK | PKG#TASK ...] [-- forwarded-args...]',
    '  vx watch [OPTIONS] [--poll] TASK [-- forwarded-args...]',
    '  vx cache clean [--older-than <duration>] [--max-size <size>] [--global] [--dry] [--format pretty|json] [--cache-dir <path>]',
    '  vx lock [--check] [--format pretty|json]',
    '  vx init [--dry [--format pretty|json]] [--force] [--mjs] [--native|--keep] [--plugin <seam>]',
    '  vx upgrade [TAG] [-g|--global]',
    '  vx show [PROJECT[#TASK] | TASK] [--filter <pattern>] [--affected[=<ref>]] [--format pretty|json]',
    '  vx info [--format pretty|json] [--cache-dir <path>]',
    '  vx why (TASK | PKG#TASK) [--run RUNID] [--format pretty|json] [--cache-dir <path>]',
    '  vx last [RUNID] [--list[=N]] [--failed] [--log <task>] [--stats [<task>] [--branch <name>]] [--sql <query>] [--format pretty|json] [--cache-dir <path>]',
    '  vx docs <query> [--limit N] [--format pretty|json]',
    '  vx completions bash|zsh|fish',
    '  vx help [VERB]',
    '  vx version',
    '',
    'Selection (for run):',
    '  (default)                Run task in the project containing cwd.',
    '      --all                Run task in every project that declares it.',
    '      --filter <pat>       pnpm-style filter (repeatable). Examples:',
    '                             foo, @scope/*, ./packages/foo, foo..., ...foo,',
    '                             foo^..., !foo, [<since>]',
    '      --affected[=<base>]  Projects changed since <base>, and dependents',
    '                             (--filter "...[<base>]"); default the merge base',
    '                             with origin/<baseBranch>; none on that branch.',
    "  pkg#task                 Run a specific project's task directly.",
    '',
    'Execution (for run):',
    '  Each setting flag beats its VX_* variable, which beats .vx/workspace',
    '  (docs/schema.md § Settings).',
    '      --concurrency <n>           Max parallel tasks (default: usable cores);',
    '                                  50% means half of them.',
    '      --schedule <rule>           most-work (default) | critical-path |',
    '                                  direct-dependents | ready-order.',
    '      --branch <name>             The branch history records and forecasts read',
    "                                  (default: git's, else the CI provider's).",
    '      --exclude-dependencies[=names]  Skip dependsOn edges: all with no value,',
    '                                  or a comma list of names.',
    '      --no-cache                  No cache reads or writes; outputs are left',
    '                                  alone.',
    '      --force                     Skip cache reads but still write: every task',
    '                                  runs and refreshes its entry.',
    '      --cache-policy <spec>       Per-layer read/write: a comma list of',
    '                                  <layer>:<flags> (layer local or remote, flags',
    '                                  from rw). A named layer is set to exactly its',
    '                                  flags; unnamed layers keep theirs. Examples:',
    '                                  local:rw,remote:r (remote read-only), remote:',
    '                                  (remote off), local:r (local read-only).',
    '      --cache-dir <path>          Cache directory (cwd-relative); default',
    '                                  .vx/cache, entries in ~/.vx/<id>/cache.',
    '      --cache-download <mode>     all (default) | toplevel | none:',
    '                                  where remote outputs land.',
    '      --cache-concurrency-download <n>',
    '                                  Remote downloads at once.',
    '      --cache-concurrency-upload <n>',
    '                                  Uploads at once, per remote.',
    '      --cache-concurrency-restore <n>',
    '                                  Local hits restoring at once.',
    '      --retries <n>               Up to <n> more runs of a failed task, for',
    '                                  tasks without their own exec.retries. Not',
    '                                  folded into cache keys.',
    "      --timeout <duration>        A task's time limit (30s, 10m), for tasks",
    '                                  without their own exec.timeout. A task past it',
    '                                  is killed and fails.',
    '      --continue[=<mode>]         What a failed task takes down: never | deps-ok',
    '                                  (default, skips its dependents) | always (bare',
    '                                  form; dependents run, never save).',
    '      --output-logs <mode>        full | errors-only | hash-only | none, over',
    '                                  the flow default (focused without',
    '                                  --all/--filter/--affected, broad with, full in',
    '                                  CI).',
    '      --verbosity <n>             0 (default), or 1 and up for a per-task',
    '                                  summary table after the run.',
    '',
    'Planning (for run — skips execution):',
    "      --dry[=pretty|json]  Print the task graph and each task's predicted hit",
    '                           or miss.',
    '',
    'Artifacts (for run):',
    '      --profile[=<path>]    Write Chrome-trace JSON (default profile.json).',
    '',
    'Extensions (plugins):',
    '  vx core runs tasks in-process and nothing else. A dashboard, remote',
    '  cache, distributed execution, and telemetry export are provided by',
    '  PLUGINS declared in .vx/workspace.ts — first-party or your own. Core',
    '  depends on none of them; a plain `vx run` never requires a plugin.',
    '  See the plugin guide: https://vznjs.github.io/vx/docs/plugins/',
    '',
    'Argument forwarding (for run):',
    "  Anything after `--` is forwarded (shell-quoted) to the task's exec",
    '  command. The forwarded args are folded into the cache key.',
    '',
    'Watch mode:',
    '  vx watch <task>            Initial run, then re-run on filesystem changes.',
    '                             Uses the same flags as `vx run` except --dry /',
    '                             --profile / --verbosity (they plan or report one',
    '                             run), plus --poll (watch.poll: poll instead of',
    '                             the OS watcher). Press Ctrl+C to stop.',
    '                             Cache means most re-runs are near-zero cost',
    '                             (cache hits restore outputs + replay logs).',
    '',
    'Cache management:',
    '  vx cache clean --older-than 30d     Evict entries last accessed > 30 days ago.',
    '  vx cache clean --max-size 1G        Keep total cache under 1 GB (LRU eviction).',
    "  vx cache clean                      Clear .vx/cache and this repo's store ~/.vx/<id>/cache.",
    "      --global                        Clear every repo's store under ~/.vx.",
    '      --dry                           Say what the policy would reap; delete nothing.',
    '      --format <fmt>                  pretty (default) | json.',
    '      --cache-dir <path>              The cache a run with the same flag uses (why, last, info too).',
    '',
    '  Duration units: ms, s, m, h, d. Size units: K, M, G, T (powers of 1024).',
    '  Cache statistics — directory, entry count, size — are part of `vx info`.',
    '',
    'Introspection:',
    '  vx show              List every project: name, dir, declared task count.',
    "  vx show <project>    Print the project's resolved config as a run reads",
    '                       it from the lock, one block per task.',
    "  vx show <pkg>#<task> Print a single task's resolved config.",
    '  vx show <task>       That task in every project declaring it.',
    "      --filter <pattern>  The list (or a task's projects) as `vx run --filter` selects.",
    "      --affected[=<ref>]  A task's projects `vx run <task> --affected` runs; no task:",
    '                       the changed projects and their dependents.',
    '      --format <fmt>   pretty (default) | json.',
    '  vx info              Workspace doctor: vx/bun/git versions, project +',
    '                       task counts, cache dir/entries/size, recent runs,',
    '                       lock status.',
    '      --format <fmt>   pretty (default) | json.',
    "  vx why <task>        Why did this task re-run? Compares the task's latest",
    '                       run (or --run RUNID) against its previous run: names the',
    '                       exact changed cache-key components (files / env / runtime',
    '                       / upstream) from the persisted input fingerprints.',
    '      --format <fmt>   pretty (default) | json.',
    "  vx last [RUNID]      Replay a recorded run's summary from the local history —",
    '                       header (command, when, branch, counts) plus the per-task',
    '                       table, failures first. No re-execution, no cache probe.',
    '      --list[=N]       List the N most recent runs (default 10) with run ids.',
    '      --failed         Only failed runs: the latest one, or with --list the list.',
    "      --log <task>     That task's output in the run (latest that ran it): a failure's",
    '                       or the cached log; none for an uncached pass.',
    '      --stats [<task>] Per-task p50/p99, pass and hit rate, failure mode, peak',
    '                       RSS and CPU over the last 50 runs; a task id or name narrows.',
    "      --branch <name>  The branch --stats' p50 forecasts from (default: the run's).",
    '      --sql <query>    One read-only SELECT over the history (runs, invocations,',
    '                       entries, task_outcomes, ...): filter, group, trend.',
    '      --format <fmt>   pretty (default) | json.',
    '  info, why and last:',
    '      --cache-dir <path>  Read the cache a run with the same flag uses.',
    '',
    'Migration:',
    '  vx init              Install vx globally and as the root devDependency, then',
    '                       write .vx/workspace.ts and an empty root vx.config.ts. In a',
    '                       Turbo or Nx repo: runs @vzn/vx-migrate, which maps turbo.json',
    '                       or the Nx graph to vx (asking native or keep).',
    '      --dry            Print the generated files instead of writing them.',
    '      --format json    With --dry: the plan as one JSON document (schemas/init.json).',
    '      --force          Overwrite existing vx.config.* files.',
    '      --mjs            Write .mjs files (no type import) instead of .ts.',
    '      --native         Turbo or Nx: write a vx.config.ts per package (no question).',
    '      --keep           Turbo or Nx: only .vx/workspace.ts, declaring turbo() or nx().',
    '      --plugin <seam>  Instead: write plugins/<seam>.ts, a runnable plugin, and its',
    '                       test (executor, cache, telemetry, schedule, admit, commands,',
    '                       project, graph, key).',
    '',
    'Upgrade:',
    '  vx upgrade [TAG]     Bring vx to TAG (default: latest) the way it was installed.',
    "                       In a project: the project's vx, its @vzn/vx-* plugins and",
    '                       the global vx that ran it, to one release.',
    '      -g, --global     Only the global vx: no project, no plugin.',
    '',
    'Shell completions:',
    '  vx completions <shell>   Print a completion script for bash, zsh or fish: the',
    '                           verbs (plugin verbs of this workspace included) and',
    '                           every flag of each. `eval "$(vx completions bash)"`,',
    '                           or write it where the shell loads completions from.',
    '',
    'Docs:',
    "  vx docs <query>      Search the reference at this version's tag on GitHub (online):",
    '                       the sections holding every word of the query print whole,',
    '                       best first, with their URL; an error code',
    '                       (vx docs VX_E_CYCLE) prints its fix alone.',
    '      --limit N        How many sections (default 3).',
    '      --format json    {query, hits: [{page, heading, url, text}]}.',
    '',
    'Config lock:',
    '  vx lock              Evaluate every vx.config in the current environment, check',
    '                       the graph rules (run.rules) and freeze the resolved objects',
    '                       into .vx/projects.lock.json, the only place a run reads configs',
    '                       from. A run never evaluates one, never checks the rules',
    '                       and never writes the lock: with none it fails.',
    '  vx lock --check      Audit the lock: re-evaluate every config here and compare',
    '                       it with the frozen object, find a config added or gone, and',
    '                       check the graph rules. Exits 1 on drift (e.g. configs that read env',
    '                       vars). Run it before the run in CI. With --format json it prints',
    '                       {upToDate, audited, notAudited, problems}.',
    '',
    ...(pluginCommands.length > 0 ? ['Plugin commands:', ...pluginCommands, ''] : []),
  ].join('\n')
}

/**
 * Every argument error ends with this. `vx <verb> --help` prints the
 * reference (2026-09-04); before that there was nowhere to send a user who
 * got a flag wrong, so the errors just said no.
 */
export function seeHelp(verb: string): string {
  return ` (see \`vx ${verb} --help\`)`
}

/** `--format`'s value, or the one refusal every verb gives for a bad one. */
export function formatValue(
  v: string | undefined,
  verb: string,
): 'pretty' | 'json' | { error: string } {
  if (v === 'pretty' || v === 'json') return v
  return {
    error:
      v === undefined || v === ''
        ? `--format requires a value: pretty or json${seeHelp(verb)}`
        : `--format must be pretty or json (got ${v})${seeHelp(verb)}`,
  }
}

/** How a verb names a word it refuses: a flag, or a positional it takes no more of. */
export function refusedWord(arg: string): string {
  return arg.startsWith('-') ? 'unknown flag' : 'unexpected argument'
}

/**
 * `(did you mean --concurrency?)` for a flag within two edits of one `verb`
 * accepts; empty for anything else (a positional included). A third edit
 * is allowed only between flags that share their first five characters,
 * so `--timeouts` reaches `--timeout` while `--zzz` does not reach `--all`.
 */
export function flagHint(verb: string, arg: string): string {
  if (!arg.startsWith('-')) return ''
  const name = arg.replace(/=.*$/, '')
  // Every core verb answers `--help`, which no usage line spells.
  const flags = ['--help', ...acceptedFlags(verb)]
  // `--json` is gh's and Nx's spelling; a verb with `--format` reads it
  // there, and no edit budget reaches `--format json` from `--json`.
  if (name === '--json' && flags.includes('--format')) return ' (did you mean --format json?)'
  // `vx run` prints no JSON of its own, and edit distance reached `--force`
  // from `--format`: a run with its cache reads turned off.
  if ((name === '--format' || name === '--json') && flags.includes('--dry'))
    return ' (the run as JSON is `vx last --format json` after it; the plan is --dry=json)'
  // A flag one word too long (`--dry-run` for `--dry`) is too many edits
  // away for either budget, and so is one cut short at a word.
  const cut = flags.filter((f) => f.startsWith(`${name}-`) || name.startsWith(`${f}-`))
  const best =
    nearest(name, flags) ??
    nearest(
      name,
      flags.filter((f) => f.slice(0, 5) === name.slice(0, 5)),
      3,
    ) ??
    (cut.length === 1 ? cut[0] : undefined)
  return best === undefined ? '' : ` (did you mean ${best}?)`
}

/**
 * The documented `--flags` of one verb, read from the help text's
 * sections headed `… (for <verb>):` so there is no second list to drift —
 * and no hint that names another verb's flag. Only the flag an option line
 * OPENS with is one: an option line that named `vx lock --check` once put
 * `--check` in the list, so `vx run --chek`
 * was told "did you mean --check?" and `--check` was then refused.
 */
export function documentedFlags(verb: string, text = helpText()): string[] {
  const flags = new Set<string>()
  let inVerb = false
  for (const line of text.split('\n')) {
    if (/^[A-Z][A-Za-z ]*(?: \(for [a-z]+\))?:$/.test(line))
      inVerb = line.endsWith(`(for ${verb}):`)
    if (!inVerb) continue
    // `--x, --no-x`: a flag and its negation.
    const own = /^\s+(--[a-zA-Z][a-zA-Z-]*)(?:, (--[a-zA-Z][a-zA-Z-]*))?/.exec(line)
    if (own !== null) for (const f of own.slice(1)) if (f !== undefined) flags.add(f)
  }
  return [...flags]
}

/**
 * The `vx run` flags `vx watch` refuses: each plans or reports ONE run
 * (`watchRefusal` in watch.ts, held to this list by a test).
 */
export const WATCH_REFUSED_FLAGS: readonly string[] = ['--dry', '--profile', '--verbosity']

/**
 * The flags one verb accepts: those on its own Usage line, and for a verb
 * that takes `[OPTIONS]` (run, watch) the documented run flags — less the
 * ones watch refuses. The Usage line is the verb's synopsis; a section's
 * prose names other verbs' flags (`vx lock --check`, `--run RUNID` under
 * `vx why`) and is not read.
 */
export function acceptedFlags(verb: string): string[] {
  const quoted = verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const usage = helpText()
    .split('\n')
    .filter((line) => new RegExp(`^  vx ${quoted}( |$)`).test(line))
  const flags = new Set<string>()
  for (const line of usage) {
    for (const f of line.match(/--[a-zA-Z][a-zA-Z-]*/g) ?? []) flags.add(f)
    if (line.includes('[OPTIONS]')) {
      for (const f of documentedFlags('run')) {
        if (verb !== 'watch' || !WATCH_REFUSED_FLAGS.includes(f)) flags.add(f)
      }
    }
  }
  return [...flags]
}

export { CORE_VERBS } from '../util/index.js'

/**
 * A refusal a verb prints itself rather than throws: one line on stderr,
 * exit 1, and under `--format json` / `--dry=json` the same as the error
 * document on stdout that `bin.ts` prints for a thrown one (cli.md § Error
 * codes), so an agent reads a code.
 */
export function refuse(
  verb: string,
  args: readonly string[],
  message: string,
  code: string,
): number {
  const line = `vx ${verb}: ${message}`
  ui.print('err', refusalNotice(`vx ${verb}`, message))
  if (wantsJson(args)) process.stdout.write(errorDocument(code, maskedLine(line)))
  return 1
}

type Paint = typeof paint
