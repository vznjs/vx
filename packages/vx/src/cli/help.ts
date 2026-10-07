import type { ColorSupport, paint as Paint } from '../orchestrator/index.js'
import { CORE_VERBS, nearest } from '../util/index.js'

export async function printHelp(
  pluginCommands: readonly string[] = [],
  verb?: string,
): Promise<void> {
  const text = verb === undefined ? helpText(pluginCommands) : verbHelpText(verb)
  // The orchestrator is already loaded by the plugin-verb lookup every
  // caller awaits first, so this import costs `vx --version` nothing.
  const { detectColors, paint } = await import('../orchestrator/index.js')
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
export function paintHelp(text: string, colors: ColorSupport, paint: typeof Paint): string {
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
    'vx — open, extensible monorepo task runner',
    '',
    'Usage:',
    '  vx run [OPTIONS] [TASK | PKG#TASK ...] [-- forwarded-args...]',
    '  vx watch [OPTIONS] TASK [-- forwarded-args...]',
    '  vx cache prune [--older-than <duration>] [--max-size <size>] [--dry-run] [--format pretty|json] [--cache-dir <path>]',
    '  vx lock [--check]',
    '  vx init [--dry] [--force] [--mjs] [--plugin <seam>]',
    '  vx upgrade [tag]',
    '  vx show [PROJECT[#TASK] | TASK] [--filter <pattern>] [--affected[=<ref>]] [--format pretty|json]',
    '  vx info [--format pretty|json] [--cache-dir <path>]',
    '  vx why (TASK | PKG#TASK) [--run <runId>] [--format pretty|json] [--cache-dir <path>]',
    '  vx last [RUNID] [--list[=N]] [--failed] [--format pretty|json] [--cache-dir <path>]',
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
    '      --affected[=<base>]  Sugar for --filter "...[<base>]". Default base =',
    '                             affectedBase, else origin/HEAD, else main or',
    '                             master, else HEAD~1.',
    "  pkg#task                 Run a specific project's task directly.",
    '',
    'Execution (for run):',
    '      --concurrency <n>           Max parallel tasks (default: the cores this process may use); `50%` = half of them.',
    '      --exclude-dependencies[=names]  Skip dependsOn edges. No value = all; comma list = specific names.',
    '      --no-cache                  Disable caching entirely (no reads, no writes, outputs left alone).',
    '      --force                     Re-execute everything (skip reads) but still refresh the cache (writes on).',
    '      --cache <spec>              Per-layer read/write control. Comma list of <layer>:<flags>',
    '                                  (layer = local|remote, flags ⊆ rw). A named layer is set EXACTLY',
    '                                  to its flags; unnamed layers keep their value. Examples:',
    '                                  local:rw,remote:r (remote read-only), remote: (remote off),',
    '                                  local:r (local read-only).',
    '      --cache-dir <path>          Cache directory override (cwd-relative). Beats the workspace',
    '                                  cacheDir field + the .vx/cache default.',
    '      --retry <n>                 Re-run a failed task up to <n> more times (default for tasks',
    "                                  without their own exec.retries; explicit config wins). Doesn't",
    '                                  affect cache keys.',
    '      --timeout <ms>              Default per-task timeout for tasks without their own exec.timeout',
    '                                  (above VX_TASK_TIMEOUT env + workspace timeout). Kills + fails',
    '                                  a runaway task. Per-task exec.timeout always wins.',
    '      --continue[=<mode>]         What a failed task takes down: never | deps-ok (default, skips',
    '                                  its dependents) | always (bare form; dependents run, never save).',
    '      --frozen                    Load configs from vx-lock.json (CI; pair with vx lock --check).',
    '      --output-logs <mode>        full | errors-only | hash-only | none — overrides the flow default',
    '                                  (focused without --all/--filter/--affected, broad with, full in CI).',
    '      --download <mode>           all (default) | toplevel | none — where remote outputs land.',
    '      --verbosity <n>             0 (default) or 1+: print a per-task summary table after the run.',
    '',
    'Planning (for run — skips execution):',
    '      --dry[=text|json]    Print the task graph + cache hit/miss prediction.',
    '      --graph[=<path>]     Emit Graphviz DOT (stdout if no path).',
    '',
    'Artifacts (for run):',
    '      --summarize[=<path>]  Write per-run JSON to <cacheDir>/runs/<run_id>.json.',
    '      --profile[=<path>]    Write Chrome-trace JSON (default profile.json).',
    '      --report[=markdown]   Print a markdown run report to stdout after the run.',
    '      --report-file <path>  Append that report to <path> (for $GITHUB_STEP_SUMMARY).',
    '      --tag <k=v>           Label this invocation (repeatable); recorded on its history row.',
    '',
    'Extensions (plugins):',
    '  vx core runs tasks in-process and nothing else. A dashboard, remote',
    '  cache, distributed execution, and telemetry export are provided by',
    '  PLUGINS declared in vx.workspace.ts — first-party or your own. Core',
    '  depends on none of them; a plain `vx run` never requires a plugin.',
    '  See the plugin guide: https://vznjs.github.io/vx/guides/plugins/',
    '',
    'Turbo and Nx spellings (for run):',
    '  What turbo run / nx run-many / nx affected take works here, or is refused',
    '  naming the vx spelling: -t build,test, -p app, --exclude docs, --parallel 4,',
    '  and --base main, --dry-run, --skip-nx-cache. `vx build` names `vx run build`.',
    '  Every flag: https://vznjs.github.io/vx/cli/#turbo-and-nx-flags',
    '',
    'Argument forwarding (for run):',
    "  Anything after `--` is forwarded (shell-quoted) to the task's exec",
    '  command. The forwarded args are folded into the cache key.',
    '',
    'Watch mode:',
    '  vx watch <task>            Initial run, then re-run on filesystem changes.',
    '                             Uses the same flags as `vx run` except --dry /',
    '                             --graph / --summarize / --profile / --report /',
    '                             --report-file / --verbosity (they plan or report',
    '                             one run). Press Ctrl+C to stop. Cache means most',
    '                             re-runs are near-zero cost (cache hits restore',
    '                             outputs + replay logs).',
    '',
    'Cache management:',
    '  vx cache prune --older-than 30d     Evict entries last accessed > 30 days ago.',
    '  vx cache prune --max-size 1G        Keep total cache under 1 GB (LRU eviction).',
    '      --dry-run                       Say what the policy would reap; delete nothing.',
    '      --format <fmt>                  pretty (default) | json.',
    '      --cache-dir <path>              The cache a run with the same flag uses (why, last, info too).',
    '',
    '  Duration units: s, m, h, d. Size units: K, M, G, T (powers of 1024).',
    '  Cache statistics — directory, entry count, size — are part of `vx info`.',
    '',
    'Introspection:',
    '  vx show              List every project: name, dir, declared task count.',
    "  vx show <project>    Print the project's LIVE resolved config (fresh",
    '                       evaluation, not the lock), one block per task.',
    "  vx show <pkg>#<task> Print a single task's resolved config.",
    '  vx show <task>       That task in every project declaring it.',
    "      --filter <pattern>  The list (or a task's projects) as `vx run --filter` selects.",
    '      --affected[=<ref>]  Only what `vx run --affected` selects: changed and dependents.',
    '      --format <fmt>   pretty (default) | json.',
    '  vx info              Workspace doctor: vx/bun/git versions, project +',
    '                       task counts, cache dir/entries/size, recent runs,',
    '                       lock status.',
    '      --format <fmt>   pretty (default) | json.',
    "  vx why <task>        Why did this task re-run? Compares the task's latest",
    '                       run (or --run <id>) against its previous run: names the',
    '                       exact changed cache-key components (files / env / runtime',
    '                       / upstream) from the persisted input fingerprints.',
    '      --format <fmt>   pretty (default) | json.',
    "  vx last [runId]      Replay a recorded run's summary from the local history —",
    '                       header (command, when, branch, counts) plus the per-task',
    '                       table, failures first. No re-execution, no cache probe.',
    '      --list[=N]       List the N most recent runs (default 10) with run ids.',
    '      --failed         Only failed runs: the latest one, or with --list the list.',
    '      --format <fmt>   pretty (default) | json.',
    '',
    'Migration:',
    '  vx init              Generate vx.workspace.ts + one vx.config.ts per package',
    '                       from package.json scripts. Unmappable settings become',
    '                       TODO(vx-migrate) comments. Beside turbo.json or nx.json:',
    '                       only vx.workspace.ts, declaring turbo() or nx().',
    '      --dry            Print the generated files instead of writing them.',
    '      --force          Overwrite existing vx.config.* files.',
    '      --plugin <seam>  Instead: write plugins/<seam>.ts, a runnable plugin, and its',
    '                       test (executor, cache, telemetry, schedule, admit, commands,',
    '                       project, graph, key).',
    '  From turbo.json or an Nx project graph: `bunx @vzn/vx-migrate` (its own package).',
    '',
    'Shell completions:',
    '  vx completions <shell>   Print a completion script for bash, zsh or fish: the',
    '                           verbs (plugin verbs of this workspace included) and',
    '                           every flag of each. `eval "$(vx completions bash)"`,',
    '                           or write it where the shell loads completions from.',
    '',
    'Config lock:',
    '  vx lock              Evaluate every vx.config in the current environment and',
    '                       freeze the resolved objects into vx-lock.json. Plain runs',
    '                       always evaluate live; only `vx run --frozen` consumes the',
    '                       lock (CI reproducibility, frozen-env semantics).',
    '  vx lock --check      Audit the lock: file-changed hash report PLUS a full',
    '                       re-evaluation compared against the frozen objects. Exits 1',
    '                       on drift (e.g. configs that read env vars). Run it before',
    '                       `vx run --frozen` in CI.',
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
 * so `--retries` reaches `--retry` while `--zzz` does not reach `--all`.
 */
export function flagHint(verb: string, arg: string): string {
  if (!arg.startsWith('-')) return ''
  const name = arg.replace(/=.*$/, '')
  // Every core verb answers `--help`, which no usage line spells.
  const flags = ['--help', ...acceptedFlags(verb)]
  // `--json` is gh's and Nx's spelling; a verb with `--format` reads it
  // there, and no edit budget reaches `--format json` from `--json`.
  if (name === '--json' && flags.includes('--format')) return ' (did you mean --format json?)'
  // A flag cut short at a word (`--dry` for prune's `--dry-run`, which
  // `vx run` spells `--dry`) is too many edits away for either budget.
  const cut = flags.filter((f) => f.startsWith(`${name}-`))
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
 * OPENS with is one: `--frozen`'s line says "pair with vx lock --check", and
 * reading every flag on it put `--check` in the list, so `vx run --chek`
 * was told "did you mean --check?" and `--check` was then refused.
 */
export function documentedFlags(verb: string, text = helpText()): string[] {
  const flags = new Set<string>()
  let inVerb = false
  for (const line of text.split('\n')) {
    if (/^[A-Z][A-Za-z ]*(?: \(for [a-z]+\))?:$/.test(line))
      inVerb = line.endsWith(`(for ${verb}):`)
    if (!inVerb) continue
    const own = /^\s+(--[a-zA-Z][a-zA-Z-]*)/.exec(line)
    if (own !== null) flags.add(own[1]!)
  }
  return [...flags]
}

/**
 * The `vx run` flags `vx watch` refuses: each plans or reports ONE run
 * (`watchRefusal` in watch.ts, held to this list by a test).
 */
export const WATCH_REFUSED_FLAGS: readonly string[] = [
  '--dry',
  '--graph',
  '--summarize',
  '--profile',
  '--report',
  '--report-file',
  '--verbosity',
]

/**
 * The flags one verb accepts: those on its own Usage line, and for a verb
 * that takes `[OPTIONS]` (run, watch) the documented run flags — less the
 * ones watch refuses. The Usage line is the verb's synopsis; a section's
 * prose names other verbs' flags (`vx lock --check`, `--run <id>` under
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
