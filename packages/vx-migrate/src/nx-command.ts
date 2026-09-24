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
// process group — every task vx runs is one (runner.ts spawns `detached`),
// so the group is the task's and nothing outside it.
//
// Arguments: Nx appends every option it does not consume (`--name=value`),
// the `args` option and the arguments given on its command line to EACH
// command unless `forwardAllArgs` is false, fills `{args}` with them, and
// `{args.name}` with one of them. vx appends `vx run … -- <args>` to the
// end of the line, so a line of more than one command is a function the
// forwarded arguments reach as `"$@"` (nx#12165).

import path from 'node:path'
import { relPosix } from './paths.js'

interface NxCommandContext {
  /** Project dir relative to the workspace root, `.` for the root. */
  readonly projectRel: string
  /** The Nx project name, what `{projectName}` expands to. */
  readonly projectName: string
}

/** A run-commands target as vx runs it. */
export interface RunCommandsLine {
  readonly command: string
  /** `exec.env.define`: the target's `env`, and `FORCE_COLOR` under `color`. */
  readonly env: Readonly<Record<string, string>>
  /** Nx's `readyWhen` as the pattern `exec.persistent.readyWhen` takes, when the target has one. */
  readonly readyWhen: string | undefined
  /** `envFile` as declared: workspace-root-relative, or absolute. */
  readonly envFile: string | undefined
}

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

/** Nx's `needsShellQuoting` / `isAlreadyQuoted` / `wrapArgIntoQuotesIfNeeded`, for the text it appends. */
const SHELL_META = /[|&;<>()$`\\!"'*?[\]{}~#\s]/
function nxQuoteArg(arg: string): string {
  const quoted = (s: string) =>
    s.length >= 2 && ((s[0] === "'" && s.at(-1) === "'") || (s[0] === '"' && s.at(-1) === '"'))
  const eq = arg.indexOf('=')
  if (eq !== -1) {
    const key = arg.slice(0, eq)
    const value = arg.slice(eq + 1)
    if (key.startsWith('--') && SHELL_META.test(value) && !quoted(value)) {
      return `${key}="${value.replaceAll('"', '\\"')}"`
    }
    return arg
  }
  return SHELL_META.test(arg) && !quoted(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg
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
  if (
    entries.some(
      (e) =>
        e.prefix !== undefined ||
        e.prefixColor !== undefined ||
        e.color !== undefined ||
        e.bgColor !== undefined,
    )
  ) {
    todos.push(
      'nx:run-commands: per-command `prefix` / `color` output decoration is not reproduced',
    )
  }
  if (entries.length === 0) return { command: NOOP, env, readyWhen: undefined, envFile }

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
  const unknownArgs = unknown
    .filter(([k, v]) => typeof v !== 'object' && parsed[k] === v)
    .map(([k, v]) => nxQuoteArg(`--${k}=${String(v)}`))
  const forwardAll = (e: CommandEntry): boolean =>
    typeof e.forwardAllArgs === 'boolean'
      ? e.forwardAllArgs
      : typeof options['forwardAllArgs'] === 'boolean'
        ? options['forwardAllArgs']
        : true

  const commands: Interpolated[] = []
  for (const e of entries) {
    const c = e.command
    if (c.includes('{args.') && c.includes('{args}')) {
      todos.push('nx:run-commands: Nx refuses a command with both `{args}` and `{args.*}`')
      return null
    }
    let text: string
    let runtime: Interpolated['runtime']
    if (c.includes('{args.')) {
      text = c.replace(/\{args\.([^}]+)\}/g, (_, k: string) => templateText(parsed[k]))
      runtime = 'none'
      todos.push(
        '`{args.*}` is filled from the target’s options — a value passed after `vx run … --` does not reach it',
      )
    } else if (c.includes('{args}')) {
      text = c.replace(/\{args\}/g, `${[...unknownArgs, '"$@"'].join(' ')} ${argsOption ?? ''}`)
      runtime = 'inline'
    } else if (forwardAll(e)) {
      text = [c, ...unknownArgs, ...(argsOption ? [argsOption] : [])].join(' ')
      runtime = 'append'
    } else {
      text = c
      runtime = 'none'
    }
    commands.push({ text: expand(text, ctx), runtime })
  }

  const cd = cdPrefix(options['cwd'], ctx)
  const pattern =
    readyWhen.length === 0
      ? undefined
      : readyWhen.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  if (readyWhen.length > 1) {
    todos.push(
      `nx:run-commands: Nx waits for every \`readyWhen\` string (${readyWhen.map((s) => JSON.stringify(s)).join(', ')}); ` +
        'vx takes one pattern, so the task is ready on the first of them',
    )
  }
  const only = commands.length === 1 ? commands[0]! : undefined
  if (only !== undefined && only.runtime === 'append') {
    return { command: `${cd}${only.text}`, env, readyWhen: pattern, envFile }
  }
  // A subshell per command, as Nx gives each a shell of its own; a comment
  // in one must not swallow the `)` that closes it.
  const pieces = commands.map((c) =>
    c.runtime === 'append'
      ? `(nx_run ${shellQuote(c.text)} "$@")`
      : `(${c.text}${c.text.includes('#') ? '\n' : ''})`,
  )
  const body =
    parallel && pieces.length > 1
      ? `trap 'trap "" TERM; kill -TERM 0; exit 1' USR1; ${pieces.map((p) => `{ ${p} || kill -USR1 $$; } &`).join(' ')} wait`
      : pieces.join(' && ')
  const helper = commands.some((c) => c.runtime === 'append') ? `${NX_RUN}; ` : ''
  return {
    command: `${helper}${FN}() { ${body}; }; ${cd}${FN}`,
    env,
    readyWhen: pattern,
    envFile,
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
