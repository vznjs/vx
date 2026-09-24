// Item 687: every package that imports `@vzn/vx` reads core's SOURCE (core
// has no build), so its suite and its type-check must re-key when that
// source changes. They do through the task graph: a dependant's `install`
// folds `^build`, and core's `build` depends on `@vzn/vx#source`, whose
// inputs are core's source. As an empty group, core's `build` had a key
// that never moved, and a warm local cache replayed a plugin's pass over a
// core edit that broke it. Unsafe: it reads every package's manifest.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const REPO = path.resolve(import.meta.dir, '../../..')

interface DryTask {
  id: string
  deps: string[]
}

function dependantsOfCore(): string[] {
  const out: string[] = []
  for (const dir of readdirSync(path.join(REPO, 'packages'))) {
    let pkg: Record<string, unknown>
    try {
      pkg = JSON.parse(readFileSync(path.join(REPO, 'packages', dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const deps = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((k) =>
      Object.keys((pkg[k] as Record<string, string> | undefined) ?? {}),
    )
    if (pkg['name'] !== '@vzn/vx' && deps.includes('@vzn/vx')) out.push(pkg['name'] as string)
  }
  return out.sort()
}

describe('a dependant of core re-keys on core source (item 687)', () => {
  it("every dependant's test and type-check reach @vzn/vx#source in the task graph", () => {
    // A cache of its own: the suite runs as a user who cannot write the
    // checkout's `.vx/cache`, and a dry run still opens one.
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'vx-srckey-'))
    const r = Bun.spawnSync(
      [
        'bun',
        'packages/vx/src/bin.ts',
        'run',
        'test',
        'lint.oxlint',
        '--all',
        '--dry=json',
        `--cache-dir=${cacheDir}`,
      ],
      { cwd: REPO, stdout: 'pipe', stderr: 'pipe' },
    )
    rmSync(cacheDir, { recursive: true, force: true })
    expect([r.exitCode, r.exitCode === 0 ? '' : r.stderr.toString()]).toEqual([0, ''])
    const parsed = JSON.parse(r.stdout.toString()) as { tasks?: DryTask[] } | DryTask[]
    const tasks = Array.isArray(parsed) ? parsed : (parsed.tasks ?? [])
    const byId = new Map(tasks.map((t) => [t.id, t]))
    const reaches = (id: string): boolean => {
      const seen = new Set<string>()
      const stack = [id]
      while (stack.length > 0) {
        for (const d of byId.get(stack.pop()!)?.deps ?? []) {
          if (d === '@vzn/vx#source') return true
          if (!seen.has(d)) stack.push((seen.add(d), d))
        }
      }
      return false
    }
    const dependants = new Set(dependantsOfCore())
    const checked = tasks
      .map((t) => t.id)
      .filter((id) => /#(test|lint\.oxlint)$/.test(id) && dependants.has(id.split('#')[0]!))
    // Positive first: the walk found the dependants' suites at all.
    expect(checked.length).toBeGreaterThanOrEqual(dependants.size)
    expect(checked.filter((id) => !reaches(id))).toEqual([])
  })
})
