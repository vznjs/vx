// Item 687: a package that imports a `@vzn/*` package reads its SOURCE
// (none has a build), so its suite and its type-check must re-key when that
// source changes. They do through the task graph: a dependant's `install`
// folds `^build`, and every package's `build` depends on its own `source`
// task, whose inputs are its source. With core's `build` an empty group and
// the plugins' absent, those keys never moved, and a warm local cache
// replayed a plugin's pass over a core edit that broke it. Unsafe: it reads
// every package's manifest.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const REPO = path.resolve(import.meta.dir, '../../..')

interface DryTask {
  id: string
  deps: string[]
}

/** Every workspace package, with the `@vzn/*` packages it depends on. */
function workspaceEdges(): Map<string, string[]> {
  const out = new Map<string, string[]>()
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
    out.set(
      pkg['name'] as string,
      deps.filter((d) => d.startsWith('@vzn/')),
    )
  }
  return out
}

describe('a dependant re-keys on the source of every package it imports (item 687)', () => {
  it("every dependant's test and type-check reach each dependency's #source in the task graph", () => {
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
    const reach = (id: string): Set<string> => {
      const seen = new Set<string>()
      const stack = [id]
      while (stack.length > 0) {
        for (const d of byId.get(stack.pop()!)?.deps ?? []) {
          if (!seen.has(d)) stack.push((seen.add(d), d))
        }
      }
      return seen
    }
    const edges = workspaceEdges()
    const missing: string[] = []
    let checked = 0
    for (const t of tasks) {
      if (!/#(test|lint\.oxlint)$/.test(t.id)) continue
      const reached = reach(t.id)
      for (const dep of edges.get(t.id.split('#')[0]!) ?? []) {
        checked++
        if (!reached.has(`${dep}#source`)) missing.push(`${t.id} -> ${dep}#source`)
      }
    }
    // Positive first: every plugin's suite imports core, so the walk
    // checked at least one edge per plugin package.
    expect(checked).toBeGreaterThanOrEqual(edges.size - 1)
    expect(missing).toEqual([])
  })
})
