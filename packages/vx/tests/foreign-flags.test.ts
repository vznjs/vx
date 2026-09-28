// What a Turbo or Nx user types into `vx run`: each flag in
// `cli/foreign-flags.ts` gets one outcome. The expectations below are
// written by hand, not generated from the table — each foreign argv
// parses exactly as the vx argv beside it, or is refused with the exact
// line — and every table entry must be driven by one of them.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { parseRunArgs } from '../src/cli/index.js'
import { FOREIGN_FLAGS, FOREIGN_VERBS, renderForeignFlags } from '../src/cli/foreign-flags.js'

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
  [['--no-daemon'], '--no-daemon (turbo): vx has no daemon: drop it'],
  [
    ['--ui=tui'],
    '--ui (turbo): vx frames each task’s output: `--output-logs <mode>` sets how much',
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
]

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

  it("arguments after -- are the task's, never translated", () => {
    expect(parseRunArgs(['build', '--', '-t', 'x', '--parallel']).forwardArgs).toEqual([
      '-t',
      'x',
      '--parallel',
    ])
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

  it('`vx run-many` and `vx affected` name the vx run that does it', () => {
    for (const verb of ['run-many', 'affected']) {
      for (const argv of [
        [verb, '-t', 'build'],
        ['help', verb],
      ]) {
        const p = Bun.spawnSync({ cmd: [process.execPath, BIN, ...argv] })
        expect([argv, p.exitCode, p.stderr.toString()]).toEqual([
          argv,
          1,
          `${FOREIGN_VERBS[verb]}\n`,
        ])
      }
    }
  })
})
