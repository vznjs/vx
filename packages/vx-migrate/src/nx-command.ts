// What an `nx:run-commands` target (or a plain `command`, its shorthand)
// runs as under vx: Nx's own option handling — `normalizeOptions` in
// run-commands.impl.ts and the two runners in running-tasks.ts, read from
// nx 22.7 and 23.2, where they agree — rendered as ONE POSIX sh line.
//
// Where: Nx runs the commands from the WORKSPACE ROOT unless `options.cwd`
// says otherwise; vx runs every command from the project dir and has no
// per-task cwd, so the line starts with the `cd` that gets there —
// `cd ../.. && node ./scripts/build/build-package.ts --cwd code/lib/cli`
// is exactly what storybook's `compile` does (2026-09-11).
//
// How: Nx runs each command in a shell of its own, and `commands` run in
// PARALLEL unless `parallel: false` (the schema's default is `true`): all
// start at once, the first failure SIGTERMs the rest and fails the task,
// the task succeeds when every command has. Joined with `&&` they ran one
// after another, so a failing check never ran while the server beside it
// was up (nx#28477), and one command's `exit` or `cd` leaked into the next.
// Each command is a subshell here, and the parallel form is background
// jobs whose first failure signals the line's shell, which TERMs its own
// process group — every task vx runs is one (runner.ts spawns `detached`)
// — and returns only once every command has exited, as Nx settles every
// command before it fails the task: a TERMed server's cleanup trap runs
// to its end inside the task, not after it. (Under vx's Linux sandbox the
// runtime's wrapper shell shares that group, and the TERM ends it too.)
//
// Arguments: Nx appends every option it does not consume (`--name=value`),
// the `args` option and the arguments given on its command line to EACH
// command unless `forwardAllArgs` is false, fills `{args}` with them, and
// `{args.name}` with one of them, a forwarded one first. vx appends `vx run … -- <args>` to the
// end of the line, so a line of more than one command is a function the
// forwarded arguments reach as `"$@"` (nx#12165). An option the forwarded
// arguments name is not appended: Nx drops it, and the line decides it
// once it has them (`nx_opt`).

import path from 'node:path'
import { relPosix } from './paths.js'

interface NxCommandContext {
  /** Project dir relative to the workspace root, `.` for the root. */
  readonly projectRel: string
  /** The Nx project name, what `{projectName}` expands to. */
  readonly projectName: string
  /** Whether a vx task runs Nx project `project`'s `target`: what a leading `nx <target> <project>` may become. */
  readonly isTarget?: (project: string, target: string) => boolean
}

/** The line `nx-env --ready-when` prints once every string is seen (`READY` in nx-env.cjs). */
const NX_ENV_READY = '^nx-env: ready$'

/** A run-commands target as vx runs it. */
interface RunCommandsLine {
  readonly command: string
  /** `exec.env.define`: the target's `env`, and `FORCE_COLOR` under `color`. */
  readonly env: Readonly<Record<string, string>>
  /** Nx's `readyWhen` as the pattern `exec.persistent.readyWhen` takes, when the target has one. */
  readonly readyWhen: string | undefined
  /**
   * Several `readyWhen` strings, all of which Nx waits for: the line runs
   * under `nx-env --ready-when`, which prints its ready line once all have
   * appeared, and `readyWhen` matches that line.
   */
  readonly readyAll?: readonly string[]
  /** `envFile` as declared: workspace-root-relative, or absolute. */
  readonly envFile: string | undefined
  /**
   * The Nx targets the line's leading `nx <target> <project>` /
   * `nx run <project>:<target>` commands ran, taken out of the line: each
   * is a dependency edge instead.
   */
  readonly nxCalls?: readonly { readonly project: string; readonly target: string }[]
}

/** `nx <target> <project>` or `nx run <project>:<target>`, through a package runner or not, with nothing else. */
const NX_CALL =
  /^(?:(?:npx|bunx|pnpm(?: exec)?|yarn)\s+)?nx\s+(?:run\s+([\w@./-]+):([\w:.-]+)|([\w:.-]+)\s+([\w@./-]+))$/

/** The options run-commands consumes itself; every other one is forwarded to each command. */
const PROP_KEYS: ReadonlySet<string> = new Set([
  'command',
  'commands',
  'color',
  'no-color',
  'parallel',
  'no-parallel',
  'readyWhen',
  'cwd',
  'args',
  'envFile',
  '__unparsed__',
  'env',
  'usePty',
  'streamOutput',
  'verbose',
  'forwardAllArgs',
  'tty',
])

/** The function a line of more than one command defines, so forwarded arguments reach each. */
const FN = 'nx_run_commands'

/**
 * Runs one command with the forwarded arguments appended as TEXT, as Nx
 * appends them: a command ending in `done` or `fi` takes no words after it,
 * so an unconditional `"$@"` broke it even with no arguments. The command
 * sees the arguments as `$@` and `nx_c` as a variable; under Nx it sees
 * neither, and a command that reads them means nothing there.
 */
const NX_RUN = `nx_run() { nx_c=$1; shift; if [ $# -eq 0 ]; then eval "$nx_c"; else eval "$nx_c \\"\\$@\\""; fi; }`

/**
 * Whether the forwarded arguments name option `$1`, as the yargs-parser
 * call over `__unparsed__` reads them (no camel-case expansion, no dot
 * notation): `--k`, `--k=v`, `--no-k`, and `-k` for a one-letter key.
 * A bare `--` stops nothing: `nx run` hands what follows it on as well.
 */
const NX_OPT = `nx_opt() { nx_k=$1; shift; for nx_a; do case $nx_a in "--$nx_k"|"--$nx_k="*|"--no-$nx_k") return 0;; esac; if [ \${#nx_k} -eq 1 ]; then case $nx_a in "-$nx_k"|"-$nx_k="*) return 0;; esac; fi; done; return 1; }`

/**
 * Prints `{args.$1}` as Nx fills it: the forwarded arguments' value as the
 * yargs-parser call over `__unparsed__` reads it (`--k=v`, `--k v`, `--k`
 * as `true`, `--no-k` as `false`, `-k` for a one-letter key, repeats
 * joined with a comma), else `$2`, the options' value. A bare `--` stops
 * nothing, as under `nx run`.
 */
const NX_VAL =
  'nx_val() { nx_k=$1; nx_v=$2; nx_n=; shift 2; while [ $# -gt 0 ]; do nx_x=; nx_s=; ' +
  'case $1 in "--$nx_k="*) nx_x=${1#*=}; nx_s=1;; "--$nx_k") nx_s=2;; "--no-$nx_k") nx_x=false; nx_s=1;; esac; ' +
  'if [ -z "$nx_s" ] && [ ${#nx_k} -eq 1 ]; then case $1 in "-$nx_k="*) nx_x=${1#*=}; nx_s=1;; "-$nx_k") nx_s=2;; esac; fi; ' +
  'if [ "$nx_s" = 2 ]; then if [ $# -gt 1 ] && case $2 in --*|-[!0-9]*) false;; *) true;; esac; then nx_x=$2; shift; else nx_x=true; fi; fi; ' +
  'if [ -n "$nx_s" ]; then if [ -n "$nx_n" ]; then nx_v="$nx_v,$nx_x"; else nx_v=$nx_x; nx_n=1; fi; fi; ' +
  `shift; done; printf '%s' "$nx_v"; }`

/** A no-op: Nx completes a target with `commands: []` at once (nx#31345). */
const NOOP = 'true'

/** `{workspaceRoot}` etc. as Nx expands them, relative to the workspace root. */
function expand(s: string, ctx: NxCommandContext): string {
  return s
    .replaceAll('{workspaceRoot}', '.')
    .replaceAll('{projectRoot}', ctx.projectRel)
    .replaceAll('{projectName}', ctx.projectName)
}

/** Single-quoted unless the word is safe bare. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`
}

/**
 * Nx's `needsShellQuoting` / `isAlreadyQuoted` / `wrapArgIntoQuotesIfNeeded`
 * for the one shape it appends here, `--name=value`: Nx's branch for a word
 * without `=` has no caller in this file.
 */
const SHELL_META = /[|&;<>()$`\\!"'*?[\]{}~#\s]/
function nxQuoteArg(arg: string): string {
  const quoted = (s: string) =>
    s.length >= 2 && ((s[0] === "'" && s.at(-1) === "'") || (s[0] === '"' && s.at(-1) === '"'))
  const eq = arg.indexOf('=')
  const value = arg.slice(eq + 1)
  return SHELL_META.test(value) && !quoted(value)
    ? `${arg.slice(0, eq)}="${value.replaceAll('"', '\\"')}"`
    : arg
}

/**
 * The `args` option as the yargs-parser call in Nx's `parseArgs` reads it,
 * for `{args.name}` and for which forwarded option it overrides: `--k=v`,
 * `--k v`, `--k`, `--no-k`, camel-case expansion, numbers parsed.
 */
function parseArgsOption(text: string): Record<string, unknown> {
  const tokens: string[] = []
  for (const m of text.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)) tokens.push(m[0])
  const unquote = (s: string) => s.replace(/^(["'])(.*)\1$/s, '$2')
  const value = (s: string): unknown => {
    const v = unquote(s)
    return /^0[^.]/.test(v) || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(v) ? v : Number(v)
  }
  const out: Record<string, unknown> = {}
  const set = (key: string, v: unknown) => {
    const names = [key, key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())]
    for (const k of new Set(names)) {
      const prev = out[k]
      out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v]
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    const flag = /^--?([^=]+)(?:=(.*))?$/s.exec(t)
    if (flag === null) continue
    const [, name, inline] = flag
    if (name!.includes('.')) continue
    if (inline !== undefined) set(name!, value(inline))
    else if (name!.startsWith('no-')) set(name!.slice(3), false)
    else if (tokens[i + 1] !== undefined && !tokens[i + 1]!.startsWith('-'))
      set(name!, value(tokens[++i]!))
    else set(name!, true)
  }
  return out
}

/** A value as Nx's template replacement coerces it; an absent one is empty. */
function templateText(v: unknown): string {
  if (v === undefined) return ''
  if (Array.isArray(v)) return v.join(',')
  if (typeof v === 'object' && v !== null) return '[object Object]'
  return String(v as string | number | boolean | null)
}

/** `cd <from the project dir to where Nx ran it> && `, or nothing when that is the project dir. */
function cdPrefix(cwd: unknown, ctx: NxCommandContext): string {
  let where = '.'
  if (typeof cwd === 'string' && cwd.length > 0) {
    const e = expand(cwd, ctx)
    if (path.posix.isAbsolute(e)) return `cd ${shellQuote(e)} && `
    where = path.posix.normalize(e).replace(/\/$/, '') || '.'
  }
  const projectDir = ctx.projectRel === '' ? '.' : ctx.projectRel
  if (where === projectDir) return ''
  return `cd ${shellQuote(relPosix(projectDir, where))} && `
}

interface CommandEntry {
  readonly command: string
  readonly forwardAllArgs?: unknown
  readonly prefix?: unknown
  readonly prefixColor?: unknown
  readonly color?: unknown
  readonly bgColor?: unknown
}

/**
 * One command after Nx's interpolation. `runtime` is where the arguments
 * given after `vx run … --` go: appended, already in the text as `"$@"`
 * (`{args}`), or nowhere.
 */
interface Interpolated {
  readonly text: string
  readonly runtime: 'append' | 'inline' | 'none'
  /**
   * The unconsumed options as `[name, --name=value]`, for a command that
   * forwards them: Nx drops one the forwarded arguments name
   * (`unknownOptions` skips a key `__unparsed__` holds), so which of them
   * the command gets is known only once vx run's arguments are.
   */
  readonly baked: readonly (readonly [string, string])[]
  /** The `args` option, after the unconsumed options. */
  readonly tail: string | undefined
}

/**
 * The line for one run-commands target, or null when Nx itself refuses the
 * options (the caller writes the placeholder; `todos` says why). `todos`
 * also receives every option this line does not reproduce.
 */
export function mapRunCommands(
  options: Record<string, unknown>,
  ctx: NxCommandContext,
  todos: string[],
): RunCommandsLine | null {
  const readyWhen =
    typeof options['readyWhen'] === 'string'
      ? [options['readyWhen']]
      : Array.isArray(options['readyWhen'])
        ? options['readyWhen'].filter((s): s is string => typeof s === 'string')
        : []
  const single = options['command']
  let entries: CommandEntry[]
  let parallel: boolean
  if ((typeof single === 'string' && single.length > 0) || Array.isArray(single)) {
    entries = [{ command: Array.isArray(single) ? single.join(' ') : single }]
    parallel = readyWhen.length > 0
  } else if (Array.isArray(options['commands'])) {
    const raw = options['commands'] as unknown[]
    entries = raw.map((c) => (typeof c === 'string' ? { command: c } : (c as CommandEntry)))
    if (entries.some((e) => typeof e?.command !== 'string')) {
      todos.push(
        `nx:run-commands: a command entry has no command — options: ${JSON.stringify(options)}`,
      )
      return null
    }
    parallel = options['parallel'] !== false
  } else {
    todos.push(`nx:run-commands target has no command — options: ${JSON.stringify(options)}`)
    return null
  }
  if (readyWhen.length > 0 && !parallel) {
    todos.push('nx:run-commands: Nx refuses `readyWhen` without `parallel: true`')
    return null
  }
  const decorated = entries.some(
    (e) =>
      e.prefix !== undefined ||
      e.prefixColor !== undefined ||
      e.color !== undefined ||
      e.bgColor !== undefined,
  )
  // Nx throws on decoration in a serial run; the target never ran under Nx.
  if (decorated && !parallel) {
    todos.push(
      'nx:run-commands: Nx refuses `prefix` / `prefixColor` / `color` / `bgColor` without `parallel: true`',
    )
    return null
  }

  const env = mapEnv(options, todos)
  const envFile =
    typeof options['envFile'] === 'string' && options['envFile'].length > 0
      ? expand(options['envFile'], ctx)
      : undefined
  if (options['streamOutput'] === false) {
    todos.push('nx:run-commands: `streamOutput: false` — vx shows the output per its own modes')
  }
  if (Array.isArray(options['__unparsed__']) && options['__unparsed__'].length > 0) {
    todos.push('nx:run-commands: `__unparsed__` in the graph is not forwarded')
  }
  if (decorated) {
    todos.push(
      'nx:run-commands: per-command `prefix` / `color` output decoration is not reproduced',
    )
  }
  const argsOption = Array.isArray(options['args'])
    ? options['args'].join(' ')
    : typeof options['args'] === 'string'
      ? options['args']
      : undefined
  const unknown = Object.entries(options).filter(([k]) => !PROP_KEYS.has(k))
  const parsed: Record<string, unknown> = {
    ...Object.fromEntries(unknown),
    ...(argsOption ? parseArgsOption(argsOption.replace(/(^"|"$)/g, '')) : {}),
  }
  const baked = unknown
    .filter(([k, v]) => typeof v !== 'object' && parsed[k] === v)
    .map(([k, v]) => [k, expand(nxQuoteArg(`--${k}=${String(v)}`), ctx)] as const)
  const forwardAll = (e: CommandEntry): boolean =>
    typeof e.forwardAllArgs === 'boolean'
      ? e.forwardAllArgs
      : typeof options['forwardAllArgs'] === 'boolean'
        ? options['forwardAllArgs']
        : true

  // A command that runs another target under Nx, ahead of the rest of a
  // serial line (ngrx's `build` opens with `nx build-package <project>`),
  // ran Nx inside the task and kept two cached tasks on one output with no
  // edge between them; as an edge, the target runs first as Nx ran it. One
  // Nx would hand options or arguments to stays a command.
  const nxCalls: { project: string; target: string }[] = []
  if ((!parallel || entries.length === 1) && readyWhen.length === 0 && ctx.isTarget) {
    while (entries.length > 0) {
      const e = entries[0]!
      const m = NX_CALL.exec(e.command.trim())
      if (m === null || (forwardAll(e) && (unknown.length > 0 || argsOption))) break
      const project = m[1] ?? m[4]!
      const target = m[2] ?? m[3]!
      if (!ctx.isTarget(project, target)) break
      nxCalls.push({ project, target })
      entries.shift()
    }
  }
  const calls = nxCalls.length > 0 ? { nxCalls } : {}
  if (entries.length === 0) return { command: NOOP, env, readyWhen: undefined, envFile, ...calls }

  const commands: Interpolated[] = []
  let named = false
  for (const e of entries) {
    const c = e.command
    if (c.includes('{args.') && c.includes('{args}')) {
      todos.push('nx:run-commands: Nx refuses a command with both `{args}` and `{args.*}`')
      return null
    }
    let text: string
    let runtime: Interpolated['runtime']
    let tail: string | undefined
    if (c.includes('{args.')) {
      // Spliced in as text, as Nx splices it, once the arguments are known.
      text =
        'eval ' +
        c
          .split(/\{args\.([^}]+)\}/)
          .map((p, i) =>
            i % 2 === 0
              ? shellQuote(p)
              : `"$(nx_val ${shellQuote(p)} ${shellQuote(templateText(parsed[p]))} "$@")"`,
          )
          .join('')
      runtime = 'none'
      named = true
    } else if (c.includes('{args}')) {
      text = c
      tail = `"$@" ${argsOption ?? ''}`
      runtime = 'inline'
    } else if (forwardAll(e)) {
      text = c
      tail = argsOption
      runtime = 'append'
    } else {
      text = c
      runtime = 'none'
    }
    commands.push({
      text: expand(text, ctx),
      runtime,
      baked: runtime === 'none' ? [] : baked,
      tail: tail === undefined ? undefined : expand(tail, ctx),
    })
  }

  const cd = cdPrefix(options['cwd'], ctx)
  const pattern =
    readyWhen.length === 0
      ? undefined
      : readyWhen.length === 1
        ? readyWhen[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        : NX_ENV_READY
  const ready = readyWhen.length > 1 ? { readyAll: readyWhen } : {}
  const only = commands.length === 1 ? commands[0]! : undefined
  if (only !== undefined && only.runtime === 'append' && only.baked.length === 0) {
    const line = only.tail === undefined ? only.text : `${only.text} ${only.tail}`
    return { command: `${cd}${line}`, env, readyWhen: pattern, envFile, ...ready, ...calls }
  }
  // A subshell per command, as Nx gives each a shell of its own; a comment
  // in one must not swallow the `)` that closes it.
  const pieces = commands.map((c) => {
    // The unconsumed options the forwarded arguments leave, as text: each
    // after a space when appended, before one where `{args}` stood.
    const kept = c.baked
      .map(([k, arg]) => {
        const word =
          c.runtime === 'inline' ? `"$nx_u"${shellQuote(`${arg} `)}` : `"$nx_u "${shellQuote(arg)}`
        return `nx_opt ${shellQuote(k)} "$@" || nx_u=${word}; `
      })
      .join('')
    if (c.runtime === 'append') {
      if (kept === '') {
        const text = c.tail === undefined ? c.text : `${c.text} ${c.tail}`
        return `(nx_run ${shellQuote(text)} "$@")`
      }
      const tail = c.tail === undefined ? '' : `" "${shellQuote(c.tail)}`
      return `(nx_u=; ${kept}nx_run ${shellQuote(c.text)}"$nx_u"${tail} "$@")`
    }
    if (c.runtime === 'inline') {
      if (kept === '') {
        const text = c.text.replaceAll('{args}', c.tail!)
        return `(${text}${text.includes('#') ? '\n' : ''})`
      }
      const text = c.text
        .split('{args}')
        .map((p) => shellQuote(p))
        .join(`"$nx_u"${shellQuote(c.tail!)}`)
      return `(nx_u=; ${kept}eval ${text})`
    }
    return `(${c.text}${c.text.includes('#') ? '\n' : ''})`
  })
  // Each job's shell catches the TERM so it outlives it and the line's
  // `wait` covers its command's exit (a subshell resets a caught signal,
  // so the command itself still takes the TERM); the flag keeps a job TERMed
  // from outside from signalling a line's shell that is already gone.
  const body =
    parallel && pieces.length > 1
      ? `trap 'trap "" TERM USR1; kill -TERM 0; wait; exit 1' USR1; ${pieces.map((p) => `{ trap 'nx_term=1' TERM; ${p} || [ -n "$nx_term" ] || kill -USR1 $$; } &`).join(' ')} wait`
      : pieces.join(' && ')
  const helper =
    (commands.some((c) => c.runtime === 'append') ? `${NX_RUN}; ` : '') +
    (commands.some((c) => c.runtime !== 'none' && c.baked.length > 0) ? `${NX_OPT}; ` : '') +
    (named ? `${NX_VAL}; ` : '')
  return {
    command: `${helper}${FN}() { ${body}; }; ${cd}${FN}`,
    env,
    readyWhen: pattern,
    envFile,
    ...ready,
    ...calls,
  }
}

/** The target's `env` (Nx gives it priority over every other source), and `color`'s `FORCE_COLOR`. */
function mapEnv(options: Record<string, unknown>, todos: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  const declared = options['env']
  if (typeof declared === 'object' && declared !== null && !Array.isArray(declared)) {
    for (const [k, v] of Object.entries(declared)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        env[k] = String(v)
      else todos.push(`nx:run-commands: \`env.${k}\` is not a string — not set`)
    }
  } else if (declared !== undefined) {
    todos.push('nx:run-commands: `env` is not an object — not set')
  }
  if (options['color'] === true) env['FORCE_COLOR'] = 'true'
  return env
}
