// What a Turbo or Nx user's hands type, and what `vx run` does with it.
// Every flag here has one outcome: vx takes it as it is (`same`), takes it
// as another spelling (`alias`, rewritten before the parse), or refuses it
// with the vx way to say it (`refuse`). Nothing is dropped in silence: a
// flag vx does not know was already a refusal, but one that named no way
// on left a `turbo run --dry-run` user at a dead end. The table renders
// cli.md's parity section (`renderForeignFlags`), pinned by a test.

export interface ForeignFlag {
  runner: 'turbo' | 'nx'
  /** Every spelling, first the one shown. */
  names: readonly string[]
  /** It takes a value: `--flag <v>` or `--flag=<v>`. */
  value: boolean
  /** When only some values are foreign (`--continue=dependencies-successful`). */
  when?: (value: string | undefined) => boolean
  /** How the table shows a `when` row. */
  shown?: string
  outcome: 'same' | 'alias' | 'refuse'
  /** The vx spelling, or what to use instead. */
  vx: string
  /** For an alias: the vx argv. For a refusal: none. */
  to?: (value: string | undefined) => string[]
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

const GRAPH_IMAGE = /\.(svg|png|jpe?g|pdf|json|html|mermaid)$/i

export const FOREIGN_FLAGS: readonly ForeignFlag[] = [
  {
    runner: 'turbo',
    names: ['--filter'],
    value: true,
    outcome: 'same',
    vx: '`--filter`, the same grammar (`...[ref]`, `{dir}`, `^`, `!`)',
  },
  {
    runner: 'turbo',
    names: ['--concurrency'],
    value: true,
    outcome: 'same',
    vx: '`--concurrency <n|n%>`',
  },
  {
    runner: 'turbo',
    names: ['--continue'],
    value: true,
    when: (v) => v === 'dependencies-successful',
    shown: '`--continue=dependencies-successful`',
    outcome: 'alias',
    vx: '`--continue=deps-ok`',
    to: () => ['--continue=deps-ok'],
  },
  {
    runner: 'turbo',
    names: ['--continue'],
    value: false,
    outcome: 'same',
    vx: '`--continue[=never|deps-ok|always]`',
  },
  {
    runner: 'turbo',
    names: ['--dry-run'],
    value: false,
    outcome: 'alias',
    vx: '`--dry[=text|json]`',
    to: (v) => [v === undefined ? '--dry' : `--dry=${v}`],
  },
  {
    runner: 'turbo',
    names: ['--graph'],
    value: true,
    when: (v) => v !== undefined && GRAPH_IMAGE.test(v),
    shown: '`--graph=<file>.svg|png|json|html|…`',
    outcome: 'refuse',
    vx: 'vx writes Graphviz DOT only: `--graph=<file>.dot`, then `dot -Tsvg`',
  },
  {
    runner: 'turbo',
    names: ['--graph'],
    value: false,
    outcome: 'same',
    vx: '`--graph[=<file>.dot]`',
  },
  {
    runner: 'turbo',
    names: ['--force'],
    value: false,
    outcome: 'same',
    vx: '`--force`: skip cache reads, keep writes',
  },
  {
    runner: 'turbo',
    names: ['--affected'],
    value: false,
    outcome: 'same',
    vx: '`--affected[=<base>]`',
  },
  {
    runner: 'turbo',
    names: ['--summarize'],
    value: false,
    outcome: 'same',
    vx: '`--summarize[=<path>]`',
  },
  {
    runner: 'turbo',
    names: ['--output-logs'],
    value: true,
    when: (v) => v === 'new-only',
    shown: '`--output-logs=new-only`',
    outcome: 'refuse',
    vx: 'use `--output-logs=full` (a hit replays its log) or `errors-only`',
  },
  {
    runner: 'turbo',
    names: ['--output-logs'],
    value: true,
    outcome: 'same',
    vx: '`--output-logs full|errors-only|hash-only|none`',
  },
  { runner: 'turbo', names: ['--no-cache'], value: false, outcome: 'same', vx: '`--no-cache`' },
  {
    runner: 'turbo',
    names: ['--cache'],
    value: true,
    outcome: 'same',
    vx: '`--cache local:rw,remote:r`',
  },
  {
    runner: 'turbo',
    names: ['--cache-dir'],
    value: true,
    outcome: 'same',
    vx: '`--cache-dir <path>`',
  },
  {
    runner: 'turbo',
    names: ['--profile'],
    value: false,
    outcome: 'same',
    vx: '`--profile[=<path>]` (Chrome trace)',
  },
  {
    runner: 'turbo',
    names: ['--only'],
    value: false,
    outcome: 'alias',
    vx: '`--exclude-dependencies`',
    to: () => ['--exclude-dependencies'],
  },
  {
    runner: 'nx',
    names: ['--parallel'],
    value: true,
    when: (v) => v !== undefined && v !== 'true',
    shown: '`--parallel <n>`',
    outcome: 'alias',
    vx: '`--concurrency <n>` (`--parallel=false` is 1)',
    to: (v) => ['--concurrency', v === 'false' ? '1' : (v ?? '')],
  },
  {
    runner: 'turbo',
    names: ['--parallel'],
    value: false,
    when: (v) => v === undefined || v === 'true',
    shown: '`--parallel`',
    outcome: 'refuse',
    vx: 'vx always honours `dependsOn`; `--concurrency <n>` sets how many run at once',
  },
  {
    runner: 'turbo',
    names: ['--scope'],
    value: true,
    outcome: 'refuse',
    vx: 'use `--filter <pkg>`',
  },
  {
    runner: 'turbo',
    names: ['--since'],
    value: true,
    outcome: 'refuse',
    vx: "use `--filter '[<ref>]'` or `--affected=<ref>`",
  },
  {
    runner: 'turbo',
    names: ['--remote-only'],
    value: false,
    outcome: 'refuse',
    vx: 'use `--cache local:,remote:rw`',
  },
  {
    runner: 'turbo',
    names: ['--remote-cache-read-only'],
    value: false,
    outcome: 'refuse',
    vx: 'use `--cache local:rw,remote:r`',
  },
  {
    runner: 'turbo',
    names: ['--token', '--team', '--api'],
    value: true,
    outcome: 'refuse',
    vx: 'a remote cache is a plugin: `turboCache()` from @vzn/vx-migrate in vx.workspace.ts reads TURBO_TOKEN / TURBO_TEAM / TURBO_API',
  },
  {
    runner: 'turbo',
    names: ['--no-daemon', '--daemon'],
    value: false,
    outcome: 'refuse',
    vx: 'vx has no daemon: drop it',
  },
  {
    runner: 'turbo',
    names: ['--ui', '--log-order', '--log-prefix'],
    value: true,
    outcome: 'refuse',
    vx: 'vx frames each task’s output: `--output-logs <mode>` sets how much',
  },
  {
    runner: 'nx',
    names: ['-t', '--targets', '--target'],
    value: true,
    outcome: 'alias',
    vx: 'the task names, positional: `vx run build test`',
    to: (v) => list(v),
  },
  {
    runner: 'nx',
    names: ['-p', '--projects'],
    value: true,
    outcome: 'alias',
    vx: '`--filter <pattern>`, one per project',
    to: (v) => list(v).flatMap((p) => ['--filter', p]),
  },
  {
    runner: 'nx',
    names: ['--exclude'],
    value: true,
    outcome: 'alias',
    vx: "`--filter '!<pattern>'`, one per project",
    to: (v) => list(v).flatMap((p) => ['--filter', `!${p}`]),
  },
  {
    runner: 'nx',
    names: ['--base'],
    value: true,
    outcome: 'alias',
    vx: '`--affected=<ref>`',
    to: (v) => [`--affected=${v ?? ''}`],
  },
  {
    runner: 'nx',
    names: ['--head'],
    value: true,
    when: (v) => v === 'HEAD',
    shown: '`--head HEAD`',
    outcome: 'alias',
    vx: 'nothing: vx compares `--affected=<base>` with the working tree',
    to: () => [],
  },
  {
    runner: 'nx',
    names: ['--head'],
    value: true,
    outcome: 'refuse',
    vx: 'vx compares `--affected=<base>` with the working tree: check out the head first',
  },
  {
    runner: 'nx',
    names: ['--skip-nx-cache'],
    value: false,
    outcome: 'alias',
    vx: '`--force`',
    to: () => ['--force'],
  },
  { runner: 'nx', names: ['--all'], value: false, outcome: 'same', vx: '`--all`' },
  {
    runner: 'nx',
    names: ['--nx-bail'],
    value: false,
    outcome: 'alias',
    vx: '`--continue=never`',
    to: () => ['--continue=never'],
  },
  {
    runner: 'nx',
    names: ['-c', '--configuration'],
    value: true,
    outcome: 'refuse',
    vx: 'a configuration is its own task: `vx run <target>:<configuration>`',
  },
  {
    runner: 'nx',
    names: ['--output-style'],
    value: true,
    outcome: 'refuse',
    vx: 'use `--output-logs <mode>`',
  },
  {
    runner: 'nx',
    names: ['--uncommitted', '--untracked'],
    value: false,
    outcome: 'refuse',
    vx: 'use `--affected=HEAD` (the working tree against the last commit)',
  },
  {
    runner: 'nx',
    names: ['--no-cloud'],
    value: false,
    outcome: 'refuse',
    vx: 'vx has no cloud: drop it',
  },
]

/** Nx's verbs, as its users type them: `vx run` takes their flags. */
const TURBO_LOGIN =
  'vx has no login: a remote cache is a plugin, `turboCache()` from @vzn/vx-migrate in vx.workspace.ts, which reads TURBO_TOKEN / TURBO_TEAM / TURBO_API'

export const FOREIGN_VERBS: Readonly<Record<string, string>> = {
  'run-many':
    '`nx run-many` is `vx run <task> --all` here; -t, -p, --exclude and --parallel work as they are',
  affected:
    '`nx affected` is `vx run <task> --affected` here; -t, --base and --exclude work as they are',
  graph: '`nx graph` is `vx run <task> --graph[=<file>.dot]` here: the task graph as Graphviz DOT',
  ls: '`turbo ls` is `vx show` here: every project, its directory and its task count',
  query:
    '`turbo query` has no vx form: `vx run <task> --dry=json` prints the planned graph as JSON',
  reset: '`nx reset` is `vx cache prune` here (or remove the cache directory `vx info` names)',
  daemon: 'vx has no daemon: there is nothing to start or stop',
  login: TURBO_LOGIN,
  logout: TURBO_LOGIN,
  link: TURBO_LOGIN,
  unlink: TURBO_LOGIN,
}

/**
 * Rewrite each aliased foreign flag into its vx argv, or refuse the first
 * refused one. A `same` flag and anything unknown pass through to the
 * parser. Arguments after `--` are the task's and are never read.
 */
export function translateForeign(args: readonly string[]): string[] | { error: string } {
  const out: string[] = []
  const sep = args.indexOf('--')
  const before = sep === -1 ? args : args.slice(0, sep)
  for (let i = 0; i < before.length; i++) {
    const a = before[i]!
    const eq = a.indexOf('=')
    const name = eq === -1 ? a : a.slice(0, eq)
    const inline = eq === -1 ? undefined : a.slice(eq + 1)
    const entries = FOREIGN_FLAGS.filter((f) => f.names.includes(name) || f.names.includes(a))
    const next = before[i + 1]
    const spaced = inline === undefined && next !== undefined && !next.startsWith('-')
    const hit = entries.find((f) => {
      const v = f.value ? (inline ?? (spaced ? next : undefined)) : inline
      return f.when === undefined || f.when(v)
    })
    if (hit === undefined || hit.outcome === 'same') {
      out.push(a)
      continue
    }
    const v = hit.value ? (inline ?? (spaced ? next : undefined)) : inline
    if (hit.value && inline === undefined && spaced) i++
    if (hit.outcome === 'refuse') return { error: `${name} (${hit.runner}): ${hit.vx}` }
    out.push(...hit.to!(v))
  }
  return sep === -1 ? out : [...out, ...args.slice(sep)]
}

/** cli.md's parity table, one row per entry. */
export function renderForeignFlags(): string {
  const rows = FOREIGN_FLAGS.map((f) => {
    const flag = f.shown ?? f.names.map((n) => `\`${n}${f.value ? ' <v>' : ''}\``).join(', ')
    return `| ${f.runner} | ${flag.replaceAll('|', '\\|')} | ${f.outcome} | ${f.vx.replaceAll('|', '\\|')} |`
  })
  return ['| runner | flag | outcome | in vx |', '| --- | --- | --- | --- |', ...rows].join('\n')
}
