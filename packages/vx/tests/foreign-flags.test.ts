// What a Turbo or Nx user types into `vx run`: each flag in
// `cli/foreign-flags.ts` gets one outcome. The expectations below are
// written by hand, not generated from the table — each foreign argv
// parses exactly as the vx argv beside it, or is refused with the exact
// line — and every table entry must be driven by one of them.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { parseRunArgs } from '../src/cli/run.js'
import {
  FOREIGN_FLAGS,
  FOREIGN_VERBS,
  renderForeignFlags,
  translateForeign,
} from '../src/cli/foreign-flags.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

/** [foreign argv, the vx argv it means, or the refusal]. */
const SAME: ReadonlyArray<readonly string[]> = [
  ['--filter', '...[main]'],
  ['--filter', '{apps/*}'],
  ['--filter', 'app^...'],
  ['--concurrency', '50%'],
  ['--continue'],
  ['--graph'],
  ['--force'],
  ['--affected'],
  ['--summarize'],
  ['--output-logs', 'errors-only'],
  ['--no-cache'],
  ['--cache', 'local:rw,remote:r'],
  ['--cache-dir', 'x'],
  ['--profile'],
  ['--all'],
]

const ALIAS: ReadonlyArray<readonly [readonly string[], readonly string[]]> = [
  [
    ['-F', 'web'],
    ['--filter', 'web'],
  ],
  [['-F=web...'], ['--filter=web...']],
  [['--continue=dependencies-successful'], ['--continue=deps-ok']],
  [['--dry-run'], ['--dry']],
  [['--dry-run=json'], ['--dry=json']],
  [['--only'], ['--exclude-dependencies']],
  [
    ['-t', 'lint,test'],
    ['lint', 'test'],
  ],
  [['--targets=lint'], ['lint']],
  [['--target', 'lint'], ['lint']],
  [
    ['-p', 'a,b'],
    ['--filter', 'a', '--filter', 'b'],
  ],
  [['--projects=a'], ['--filter', 'a']],
  [
    ['-p', '!b,a'],
    ['--filter', '*', '--filter', '!b', '--filter', 'a'],
  ],
  [['--projects=a,!b'], ['--filter', 'a', '--filter', '!b']],
  [
    ['--exclude', 'a,b'],
    ['--filter', '!a', '--filter', '!b'],
  ],
  [
    ['--parallel', '3'],
    ['--concurrency', '3'],
  ],
  [['--parallel=false'], ['--concurrency', '1']],
  [['--base', 'main'], ['--affected=main']],
  [['--base=main', '--head=HEAD'], ['--affected=main']],
  [['--skip-nx-cache'], ['--force']],
  [['--nx-bail'], ['--continue=never']],
  [
    ['--max-parallel', '3'],
    ['--concurrency', '3'],
  ],
  [['--exclude-task-dependencies'], ['--exclude-dependencies']],
  [['--skip-remote-cache'], ['--cache', 'local:rw,remote:']],
]

const REFUSE: ReadonlyArray<readonly [readonly string[], string]> = [
  [
    ['--graph=deps.svg'],
    '--graph (turbo): vx writes Graphviz DOT only: `--graph=<file>.dot`, then `dot -Tsvg`',
  ],
  [
    ['--output-logs=new-only'],
    '--output-logs (turbo): use `--output-logs=full` (a hit replays its log) or `errors-only`',
  ],
  [
    ['--parallel'],
    '--parallel (turbo): vx always honours `dependsOn`; `--concurrency <n>` sets how many run at once',
  ],
  [['--scope', 'app'], '--scope (turbo): use `--filter <pkg>`'],
  [['--since=main'], "--since (turbo): use `--filter '[<ref>]'` or `--affected=<ref>`"],
  [['--remote-only'], '--remote-only (turbo): use `--cache local:,remote:rw`'],
  [
    ['--remote-cache-read-only'],
    '--remote-cache-read-only (turbo): use `--cache local:rw,remote:r`',
  ],
  [
    ['--token', 't'],
    '--token (turbo): a remote cache is a plugin: `turboCache()` from @vzn/vx-migrate in vx.workspace.ts reads TURBO_TOKEN / TURBO_TEAM / TURBO_API',
  ],
  [
    ['--anon-profile'],
    '--anon-profile (turbo): use `--profile[=<path>]`; vx has no redacting variant, so read it before sharing it',
  ],
  [['--cache-workers', 'x'], '--cache-workers (turbo): vx sizes its own cache I/O: drop it'],
  [['--cwd', 'x'], '--cwd (turbo): run vx from that directory: `cd <dir> && vx run …`'],
  [
    ['--dangerously-disable-package-manager-check'],
    '--dangerously-disable-package-manager-check (turbo): vx reads no `packageManager` field: drop it',
  ],
  [
    ['--env-mode', 'x'],
    '--env-mode (turbo): vx passes only the variables a task declares (strict): list the rest in `exec.env.passThrough`',
  ],
  [
    ['--framework-inference', 'x'],
    "--framework-inference (turbo): under `turbo()` inference is Turbo's; take a name back with a `!` entry in the task's `env`",
  ],
  [
    ['--global-deps', 'x'],
    "--global-deps (turbo): declare them in `cache.inputs.workspaceFiles` (under `turbo()`, turbo.json's `globalDependencies`)",
  ],
  [
    ['--json'],
    "--json (turbo): use `--dry=json` for the plan, `--summarize[=<path>]` for the run's JSON record",
  ],
  [['--log-file'], "--log-file (turbo): use `--summarize[=<path>]` for the run's JSON record"],
  [['--preflight'], '--preflight (turbo): `turboCache()` sends no CORS preflight: drop it'],
  [
    ['--remote-cache-timeout', 'x'],
    '--remote-cache-timeout (turbo): set `turboCache({ timeoutMs })` or `TURBO_REMOTE_CACHE_TIMEOUT`',
  ],
  [
    ['--single-package'],
    '--single-package (turbo): a repo with no workspaces is one project already: drop it',
  ],
  [['--no-daemon'], '--no-daemon (turbo): vx has no daemon: drop it'],
  [
    ['--ui=tui'],
    '--ui (turbo): vx frames each task’s output: `--output-logs <mode>` sets how much',
  ],
  [['--color'], '--color (turbo): set `FORCE_COLOR=1`'],
  [['--no-color'], '--no-color (turbo): set `NO_COLOR=1`'],
  [['--heap', 'h.pprof'], "--heap (turbo): use `--profile[=<path>]` for vx's own trace"],
  [['--trace=t.pprof'], "--trace (turbo): use `--profile[=<path>]` for vx's own trace"],
  [
    ['--login', 'x'],
    '--login (turbo): vx has no login: a remote cache is a plugin (`turboCache()` from @vzn/vx-migrate)',
  ],
  [['--no-update-notifier'], '--no-update-notifier (turbo): vx prints no update notice: drop it'],
  [['--skip-infer'], '--skip-infer (turbo): vx runs the binary it is: drop it'],
  [
    ['--root-turbo-json', 'x.json'],
    '--root-turbo-json (turbo): `turbo()` reads the `turbo.json` at the workspace root: move it there',
  ],
  [
    ['--experimental-otel-enabled'],
    '--experimental-otel-enabled (turbo): telemetry is a plugin: `otel()` from @vzn/vx-otel in vx.workspace.ts',
  ],
  [
    ['--experimental-otel-endpoint=http://c'],
    '--experimental-otel-endpoint (turbo): telemetry is a plugin: `otel()` from @vzn/vx-otel in vx.workspace.ts',
  ],
  [
    ['--head', 'feature'],
    '--head (nx): vx compares `--affected=<base>` with the working tree: check out the head first',
  ],
  [['-c', 'ci'], '-c (nx): a configuration is its own task: `vx run <target>:<configuration>`'],
  [['--output-style=stream'], '--output-style (nx): use `--output-logs <mode>`'],
  [
    ['--uncommitted'],
    '--uncommitted (nx): use `--affected=HEAD` (the working tree against the last commit)',
  ],
  [['--no-cloud'], '--no-cloud (nx): vx has no cloud: drop it'],
  [['--files', 'a.ts'], '--files (nx): vx asks git what changed: `--affected=<base>`'],
  [['--verbose'], '--verbose (nx): use `--verbosity <n>` (1 adds the summary table)'],
  [['--batch'], '--batch (nx): vx runs one command per task: drop it'],
  [['--dte'], '--dte (nx): vx distributes nothing: drop it'],
  [['--nx-ignore-cycles'], '--nx-ignore-cycles (nx): vx refuses a task cycle by name: break it'],
  [
    ['--runner', 'cloud'],
    '--runner (nx): a remote cache is a plugin: `nxCache()` from @vzn/vx-migrate in vx.workspace.ts',
  ],
  [['--skip-sync'], '--skip-sync (nx): vx never runs sync generators: drop it'],
  [['--tui'], '--tui (nx): vx frames each task’s output: `--output-logs <mode>` sets how much'],
]

// `turbo run --help` of Turbo 2.11.6, every long flag it lists, by hand,
// but the global `--help` and `--version` (`vx --help`, `vx --version`).
// A flag here that is neither vx's own nor in the table reached a Turbo
// user as "unknown flag" with no way on.
const TURBO_RUN_FLAGS = `--affected --anon-profile --api --cache --cache-dir --cache-workers
--color --concurrency --continue --cwd --daemon --dangerously-disable-package-manager-check
--dry-run --env-mode --experimental-otel-enabled --experimental-otel-endpoint
--experimental-otel-header --experimental-otel-interval-ms
--experimental-otel-metrics-run-summary --experimental-otel-metrics-task-details
--experimental-otel-protocol --experimental-otel-resource --experimental-otel-timeout-ms
--experimental-otel-use-remote-cache-token --filter --force --framework-inference
--global-deps --graph --heap --json --log-file --log-order --log-prefix --login --no-cache --no-color
--no-daemon --no-update-notifier --only --output-logs --parallel --preflight --profile --remote-cache-read-only --remote-cache-timeout --remote-only
--root-turbo-json --single-package --skip-infer --summarize --team --token --trace --ui
--verbosity`.split(/\s+/)

describe('Turbo and Nx flags on vx run', () => {
  it('a flag vx shares parses as it is', () => {
    for (const argv of SAME)
      expect([argv, parseRunArgs(['build', ...argv]).error]).toEqual([argv, undefined])
  })

  it('an alias parses exactly as its vx spelling', () => {
    for (const [foreign, vx] of ALIAS) {
      const got = parseRunArgs(['build', ...foreign])
      expect(got.error).toBeUndefined()
      expect([foreign, got]).toEqual([foreign, parseRunArgs(['build', ...vx])])
    }
  })

  it('a refused flag names the vx way, and a later flag never runs', () => {
    for (const [argv, error] of REFUSE) {
      expect([argv, parseRunArgs(['build', ...argv, '--dry']).error]).toEqual([argv, error])
    }
  })

  // Turbo's `-F` is `--filter`; it read as an unknown flag, and bare it
  // still did, where `--filter` bare asks for the value.
  it('a bare -F asks for the value, as a bare --filter does', () => {
    expect(parseRunArgs(['build', '-F']).error).toBe(parseRunArgs(['build', '--filter']).error)
  })

  // Nx's parser takes every long flag camelCased (`--nxBail`), as its
  // docs print them; vx answered "unknown flag".
  it("Nx's camelCase spelling is the kebab-case flag", () => {
    for (const [camel, kebab] of [
      [['--nxBail'], ['--nx-bail']],
      [['--skipNxCache'], ['--skip-nx-cache']],
      [['--maxParallel=2'], ['--max-parallel=2']],
      [
        ['--maxParallel', '2'],
        ['--max-parallel', '2'],
      ],
      [['--outputStyle=static'], ['--output-style=static']],
    ]) {
      const [got, want] = [parseRunArgs(['build', ...camel!]), parseRunArgs(['build', ...kebab!])]
      expect([camel, got]).toEqual([camel, want])
    }
    // CONTROL: a camelCase name with no Nx flag behind it stays unknown.
    expect(parseRunArgs(['build', '--dryRun']).error).toBe(
      'unknown flag: --dryRun (did you mean --dry?) (see `vx run --help`)',
    )
  })

  // Turbo's clap and Nx's yargs read `=true` / `=false` on these.
  // `--skip-nx-cache=false` forced every task, and `--summarize=true`
  // wrote the summary to a file named `true`.
  it('a boolean flag with =false is left out, with =true is bare', () => {
    for (const [foreign, vx] of [
      [['--force=true'], ['--force']],
      [['--force=false'], []],
      [['--summarize=true'], ['--summarize']],
      [['--summarize=false'], []],
      [['--remote-only=false'], []],
      [['--remote-cache-read-only=false'], []],
      [['--skip-nx-cache=false'], []],
      [['--skipNxCache=true'], ['--force']],
      [['--nx-bail=false'], []],
      [['--nxBail=true'], ['--continue=never']],
      [['--exclude-task-dependencies=false'], []],
      [['--skip-remote-cache=false'], []],
      [['--skip-remote-cache=true'], ['--cache', 'local:rw,remote:']],
    ]) {
      const got = parseRunArgs(['build', ...foreign!])
      expect([foreign, got.error]).toEqual([foreign, undefined])
      expect([foreign, got]).toEqual([foreign, parseRunArgs(['build', ...vx!])])
    }
    expect(parseRunArgs(['build', '--remote-only=true']).error).toBe(
      '--remote-only (turbo): use `--cache local:,remote:rw`',
    )
    // CONTROL: any other value is vx's own: a path stays a path.
    expect(parseRunArgs(['build', '--summarize=out.json']).summarize).toBe('out.json')
  })

  it("arguments after -- are the task's, never translated", () => {
    expect(parseRunArgs(['build', '--', '-t', 'x', '--parallel']).forwardArgs).toEqual([
      '-t',
      'x',
      '--parallel',
    ])
  })

  it("every flag Turbo's `run` lists is vx's own or in the table", () => {
    const spellings = new Set(FOREIGN_FLAGS.flatMap((f) => f.names))
    const help = Bun.spawnSync(['bun', BIN, 'run', '--help']).stdout.toString()
    const own = (f: string) => new RegExp(`${f}(?![\\w-])`).test(help)
    expect(TURBO_RUN_FLAGS.filter((f) => !spellings.has(f) && !own(f)).sort()).toEqual([])
  })

  it('every table entry is driven above, and every driven flag is in the table', () => {
    const driven = new Set(
      [...SAME, ...ALIAS.map(([f]) => f), ...REFUSE.map(([f]) => f)].map((argv) =>
        argv[0]!.replace(/=.*$/, ''),
      ),
    )
    const named = new Set(FOREIGN_FLAGS.map((f) => f.names[0]!))
    expect([...named].filter((n) => !driven.has(n)).sort()).toEqual([])
    const spellings = new Set(FOREIGN_FLAGS.flatMap((f) => f.names))
    expect([...driven].filter((n) => !spellings.has(n)).sort()).toEqual([])
  })

  it('cli.md carries the table as the source renders it', () => {
    // The formatter pads the columns; the cells are what must agree.
    const cells = (md: string): string => md.replace(/ *\| */g, '|').replace(/-{3,}/g, '---')
    const cli = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'cli.md'), 'utf8')
    expect(cells(cli)).toContain(`${cells(renderForeignFlags())}\n`)
  })

  // Every Turbo or Nx verb in the table, `nx graph` and `turbo ls` among
  // them, said `unknown command` with no way on before E-98.
  it('a Turbo or Nx verb names what does it in vx', async () => {
    const verbs = [
      'run-many',
      'affected',
      'graph',
      'ls',
      'query',
      'reset',
      'daemon',
      'login',
      'logout',
      'link',
      'unlink',
    ]
    expect(Object.keys(FOREIGN_VERBS).sort()).toEqual([...verbs].sort())
    const argvs = verbs.flatMap((verb) => [
      [verb, '-t', 'build'],
      ['help', verb],
    ])
    // At once, not one after another: 22 vx starts in series cost 1.6 s
    // here and passed bun's 5 s under strace with load beside it (M-26).
    const runs = await Promise.all(
      argvs.map(async (argv) => {
        const p = Bun.spawn({ cmd: [process.execPath, BIN, ...argv], stderr: 'pipe' })
        const [code, stderr] = await Promise.all([p.exited, new Response(p.stderr).text()])
        return [argv, code, stderr]
      }),
    )
    expect(runs).toEqual(
      argvs.map((argv) => [
        argv,
        1,
        `${FOREIGN_VERBS[argv[0] === 'help' ? argv[1]! : argv[0]!]}\n`,
      ]),
    )
  })
})

// docs/parity.md mapped Nx's `--skipNxCache` to `--no-cache` while vx aliases
// it to `--force` (J2-65). A flag the map's left column names that vx
// rewrites is a claim about the rewrite: the vx column names its result.
describe('docs/parity.md names the flag vx rewrites each aliased flag to', () => {
  it('holds for every aliased flag in the left column', () => {
    const doc = readFileSync(path.join(import.meta.dir, '..', 'docs', 'parity.md'), 'utf8')
    const aliased: string[] = []
    const wrong: string[] = []
    for (const line of doc.split('\n').filter((l) => l.startsWith('| `'))) {
      const [, left, right] = line.split(/(?<!\\)\|/).map((c) => c.trim())
      for (const m of left!.matchAll(/`(--[A-Za-z-]+(?:=[^`\s]*)?)`/g)) {
        const to = translateForeign([m[1]!])
        if ('error' in to || to.join(' ') === m[1]) continue
        aliased.push(m[1]!)
        if (!right!.includes(to[0]!.split('=')[0]!)) wrong.push(`${m[1]} → ${to.join(' ')}`)
      }
    }
    expect(aliased.length).toBeGreaterThan(3)
    expect(wrong).toEqual([])
  })
})
