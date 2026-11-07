// Every test file in this repo is run by some task.
//
// A skip at least prints itself. A file no task names prints nothing: the
// gate is `vx run ci --all`, and a suite it never launches is green by
// omission. Three of the commands that launch suites here look only at the
// TOP level of a `tests/` directory — the shard dealer `readdirSync`s it,
// the unsafe task globs `./tests/*.unsafe.test.ts`, and vx-reapi loops over
// `tests/*.test.ts` — so a suite written one directory down
// (`tests/reapi/wire.test.ts`) would be launched by nothing at all, in the
// package whose own suite is its `test` task.
//
// The commands are read from the configs themselves rather than restated,
// so a package that changes how it launches its tests is measured by what
// it now does.
//
// `.unsafe`: it reads every package, which the cross-project law forbids a
// sandboxed task.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { testFiles } from '../scripts/test-shard.js'

const repo = path.resolve(import.meta.dir, '..', '..', '..')
const packagesDir = path.join(repo, 'packages')

interface TaskLike {
  exec?: { command?: string }
}
interface ConfigLike {
  tasks?: Record<string, TaskLike>
}

/** Every `*.test.ts` under `dir`, at any depth, as a POSIX path from it. */
function suitesUnder(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
    if (e.isDirectory()) out.push(...suitesUnder(path.join(dir, e.name), rel))
    else if (e.name.endsWith('.test.ts')) out.push(rel)
  }
  return out
}

/**
 * What one `test`-family command launches, as a predicate over a suite path
 * relative to the package. A bare `bun test` (no path argument) is Bun's own
 * recursive discovery, so it takes everything; a command naming globs takes
 * what they match; the shard dealer's set is the dealer's own function.
 */
function launchedBy(command: string): (suite: string) => boolean {
  if (/\bscripts\/test-shard\.ts\b/.test(command)) {
    const suite = /\s--unsafe\b/.test(command) ? 'unsafe' : 'safe'
    const platform = /\s--platform\b/.test(command)
    const dealt = new Set(testFiles(suite, platform).map((f) => `tests/${f}`))
    return (suite) => dealt.has(suite)
  }
  const globs = [
    ...command.matchAll(/(?:^|[\s"'(])\.?\/?((?:[\w.*-]+\/)*[\w.*-]+\.test\.ts)/g),
  ].map((m) => new Bun.Glob(m[1]!))
  if (globs.length > 0) return (suite) => globs.some((g) => g.match(suite))
  if (/\bbun test\b/.test(command)) return () => true
  return () => false
}

const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => {
    try {
      readdirSync(path.join(packagesDir, name, 'tests'))
      return true
    } catch {
      return false
    }
  })
  .sort()

describe('every test file is launched by a task', () => {
  it('reads real packages with real suites — the pin is not vacuous', () => {
    expect(packages.length).toBeGreaterThan(5)
    expect(packages).toContain('vx')
    expect(suitesUnder(path.join(packagesDir, 'vx', 'tests')).length).toBeGreaterThan(100)
  })

  it('no suite in any package is launched by nothing', async () => {
    const orphans: string[] = []
    for (const name of packages) {
      const dir = path.join(packagesDir, name)
      const config = (await import(path.join(dir, 'vx.config.ts'))) as { default: ConfigLike }
      const commands = Object.entries(config.default.tasks ?? {})
        .filter(([task]) => task === 'test' || task.startsWith('test.'))
        .map(([, task]) => task.exec?.command)
        .filter((c): c is string => typeof c === 'string')
      expect({ pkg: name, launchers: commands.length > 0 }).toEqual({ pkg: name, launchers: true })
      const takes = commands.map(launchedBy)
      for (const suite of suitesUnder(path.join(dir, 'tests'))) {
        if (!takes.some((take) => take(`tests/${suite}`))) orphans.push(`${name}: tests/${suite}`)
      }
    }
    expect(orphans).toEqual([])
  })

  // With every passing row printed, the failing row's error sat 300
  // lines up in a 9,500-line job log, past what a log reader fetches,
  // and item 948 went red three times with no cause on record (M-1).
  // `--only-failures` keeps the error near the end.
  it('every task that launches bun test prints only its failures', async () => {
    const launchers: string[] = []
    const verbose: string[] = []
    for (const name of packages) {
      const config = (await import(path.join(packagesDir, name, 'vx.config.ts'))) as {
        default: ConfigLike
      }
      for (const [task, t] of Object.entries(config.default.tasks ?? {})) {
        const command = t.exec?.command
        if (command === undefined || !/\bbun test\b/.test(command)) continue
        launchers.push(`${name}#${task}`)
        if (!/\bbun test --only-failures\b/.test(command)) verbose.push(`${name}#${task}`)
      }
    }
    expect(launchers).toContain('vx#test.bun.shard-1')
    expect(launchers).toContain('vx#test.bun.unsafe.shard-1')
    expect(launchers).toContain('vx-reapi#test.shard-1')
    expect(verbose).toEqual([])
  })

  // Bun's 5 s default is a wall budget: a vx-migrate test that spawns vx
  // four times passed it on a packed DTE worker (2026-11-05), as a core
  // one did before the core shards took 30 s (#4198). Speed is asserted
  // elsewhere; the timeout only catches a hang.
  it('every task that launches bun test gives a test 30 s or more', async () => {
    const privateDir = path.join(repo, 'private')
    const dirs = [
      ...packages.map((name) => path.join(packagesDir, name)),
      ...readdirSync(privateDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(privateDir, e.name))
        .filter((dir) => Bun.file(path.join(dir, 'vx.config.ts')).size > 0),
    ]
    const short: string[] = []
    for (const dir of dirs) {
      const name = path.relative(repo, dir)
      const config = (await import(path.join(dir, 'vx.config.ts'))) as {
        default: ConfigLike
      }
      for (const [task, t] of Object.entries(config.default.tasks ?? {})) {
        const command = t.exec?.command
        if (command === undefined || !/\bbun test\b/.test(command)) continue
        const ms = Number(/--timeout[= ](\d+)/.exec(command)?.[1] ?? 5_000)
        if (ms < 30_000) short.push(`${name}#${task}`)
      }
    }
    expect(short).toEqual([])
  })

  // A test's own timeout argument overrides the flag: 17 tests ran on 3
  // to 8 s of wall that way (2026-11-05). The test is found by walking
  // back from its closing `}, N)` to the line that opened it. N may be a
  // file's own `const NAME = N`: 18 files held their tests to 10-20 s that
  // way, and a Mac worker that stalled ~20 s failed one (2026-11-06).
  it('no test sets its own timeout under 30 s', () => {
    const short: string[] = []
    for (const top of ['packages', 'private']) {
      for (const file of new Bun.Glob('*/tests/**/*.test.ts').scanSync(path.join(repo, top))) {
        const text = readFileSync(path.join(repo, top, file), 'utf8')
        const consts = new Map(
          [...text.matchAll(/^const (\w+) = ([\d_]+)$/gm)].map((c) => [
            c[1]!,
            Number(c[2]!.replaceAll('_', '')),
          ]),
        )
        const ms = (arg: string): number =>
          /^[\d_]+$/.test(arg) ? Number(arg.replaceAll('_', '')) : (consts.get(arg) ?? Infinity)
        const lines = text.split('\n')
        lines.forEach((line, i) => {
          // One line: `it('…', fn, N)`.
          const one = /^\s*(it|test)(\.\w+)*\(.*, *(\w+)\)\s*$/.exec(line)
          if (one !== null && ms(one[3]!) < 30_000) {
            short.push(`${top}/${file}:${i + 1}`)
            return
          }
          // `}, N)`, or as the formatter breaks it: `},` / `N,` / `)`.
          const arg =
            /^\s*\}, *(\w+)\)\s*$/.exec(line)?.[1] ??
            (/^\s*\},?\s*$/.test(line) && /^\s*\)/.test(lines[i + 2] ?? '')
              ? /^\s*(\w+),?\s*$/.exec(lines[i + 1] ?? '')?.[1]
              : undefined)
          if (arg === undefined || ms(arg) >= 30_000) return
          let depth = 0
          for (let j = i; j >= 0; j--) {
            depth += lines[j]!.split('}').length - lines[j]!.split('{').length
            if (depth > 0) continue
            // The opener holds `it(`, or the formatter put it a few lines up:
            // `it(` / `'name',` / `async () => {`.
            const opener = [0, 1, 2, 3].some((k) =>
              k === 0
                ? /^\s*(it|test)(\.\w+)*\(/.test(lines[j]!)
                : /^\s*(it|test)(\.\w+)*\($/.test(lines[j - k] ?? ''),
            )
            if (opener) short.push(`${top}/${file}:${i + 1}`)
            return
          }
        })
      }
    }
    expect(short).toEqual([])
  })
})
