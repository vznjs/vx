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

import { readdirSync } from 'node:fs'
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
    const dealt = new Set(testFiles().map((f) => `tests/${f}`))
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
})
