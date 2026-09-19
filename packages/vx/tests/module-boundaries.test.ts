// Module-boundary law. See docs/design/module-isolation-2026-06.md.
//
// Rule 1: a file in module A may import from module B only when the
//         ALLOWED matrix grants A → B.
// Rule 2: once a module is listed in CONTRACTED, cross-module imports
//         of it must target its index.ts (the contract), never an
//         internal file. CONTRACTED is a ratchet — it grows as the
//         contract PRs land and never shrinks.
//
// Only src/ is scanned. Tests are exempt: they may exercise internals.

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const SRC = path.join(import.meta.dir, '..', 'src')

/**
 * Module of a src-relative file path. Root files are their own modules.
 */
function moduleOf(rel: string): string {
  const seg = rel.split('/')
  if (seg.length > 1) return seg[0]!
  return rel.replace(/\.ts$/, '') // bin / index / config / version
}

const ALLOWED: Record<string, readonly string[]> = {
  util: [],
  config: [],
  version: [],
  // `version`: the config-evaluation cache keys on vx's version, since a
  // stored evaluation is served without re-validation.
  workspace: ['util', 'config', 'version'],
  graph: ['util', 'config', 'workspace'],
  cache: ['util', 'config'],
  exec: ['util', 'config'],
  orchestrator: ['util', 'config', 'version', 'workspace', 'graph', 'cache', 'exec'],
  cli: ['util', 'config', 'version', 'workspace', 'graph', 'cache', 'orchestrator'],
  index: ['util', 'config', 'version', 'workspace', 'graph', 'cache', 'exec', 'orchestrator'],
  bin: ['util', 'cli'],
}

// Modules whose contract (index.ts) is the only legal cross-module
// import target. The ratchet is complete: every directory module.
const CONTRACTED: readonly string[] = [
  'cache',
  'exec',
  'util',
  'workspace',
  'graph',
  'orchestrator',
  'cli',
]

interface Edge {
  from: string
  to: string
  fromModule: string
  toModule: string
  specifier: string
}

async function collectEdges(): Promise<Edge[]> {
  const edges: Edge[] = []
  const glob = new Bun.Glob('**/*.ts')
  for await (const rel of glob.scan({ cwd: SRC })) {
    const norm = rel.split(path.sep).join('/')
    const text = await Bun.file(path.join(SRC, rel)).text()
    // Static `import ... from 'x'` / `export ... from 'x'` specifiers.
    // No dynamic imports exist on boundary paths today; if one appears
    // the matrix below is the place to encode the decision.
    for (const m of text.matchAll(/^(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1]!
      if (!spec.startsWith('.')) continue // bare imports = packages, not modules
      if (spec.endsWith('.json')) continue // JSON is data (e.g. version.ts → package.json)
      if (spec.endsWith('.html')) continue // embedded asset (cli/ui-asset.ts), not a module
      const resolved = path
        .normalize(path.join(path.dirname(norm), spec))
        .split(path.sep)
        .join('/')
        .replace(/\.(js|ts)$/, '')
      const fromModule = moduleOf(norm)
      const toModule = moduleOf(`${resolved}.ts`)
      if (fromModule === toModule) continue
      edges.push({ from: norm, to: resolved, fromModule, toModule, specifier: spec })
    }
  }
  return edges
}

describe('module boundaries', () => {
  it('every cross-module import edge is in the ALLOWED matrix', async () => {
    const edges = await collectEdges()
    expect(edges.length).toBeGreaterThan(0)
    const violations = edges.filter((e) => {
      const allowed = ALLOWED[e.fromModule]
      // Unknown module = new top-level file/dir; force a matrix decision.
      if (allowed === undefined) return true
      return !allowed.includes(e.toModule)
    })
    expect(
      violations.map((v) => `${v.from} → ${v.specifier} (${v.fromModule} → ${v.toModule})`),
    ).toEqual([])
  })

  // Rule 1 forces a matrix decision for a new module that IMPORTS across a
  // boundary — an unknown `fromModule` is a violation. A new module that is
  // only IMPORTED escapes both rules: nothing puts it in CONTRACTED, so
  // cross-module imports may reach into its internals, while the comment
  // above CONTRACTED says the ratchet covers "every directory module". That
  // is a comment claiming what the code does not enforce, so enforce it
  // (item 363, 2026-09-19).
  it('both lists cover every module on disk', () => {
    const entries = readdirSync(SRC, { withFileTypes: true })
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    const rootFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => e.name.replace(/\.ts$/, ''))
      .sort()
    // A new directory is contracted from the day it lands, or this fails and
    // the author decides in the open.
    expect([...CONTRACTED].sort()).toEqual(dirs)
    expect(Object.keys(ALLOWED).sort()).toEqual([...dirs, ...rootFiles].sort())
  })

  it('core ships no plugin: src/plugins does not exist', () => {
    // The last one (schedule-history) became @vzn/vx-schedule-history on
    // 2026-09-10. A new plugin starts life as a package, never here.
    expect(existsSync(path.join(SRC, 'plugins'))).toBe(false)
  })

  it('contracted modules are imported only via their index', async () => {
    const edges = await collectEdges()
    const violations = edges.filter(
      (e) => CONTRACTED.includes(e.toModule) && e.to !== `${e.toModule}/index`,
    )
    expect(
      violations.map((v) => `${v.from} → ${v.specifier} (must import ${v.toModule}/index)`),
    ).toEqual([])
  })
})

// The staged load (`orchestrator/projects.ts:loadProjects`, and
// `loadCliProjects` over it) is the config load every reader shares: it runs
// the plugin `project` stage, serves cached evaluations, and is what a run
// itself sees. A raw `loadProjectConfig` sees none of that, so a reader that
// reaches for it answers from a DIFFERENT workspace than the one that runs —
// `vx info` would miss a plugin's injected tasks, `--affected` would miss the
// owners of one.
//
// Two uses are legitimate and STATUS § Next 8(c) names them: `vx lock`, which
// must read each config raw and fresh because the lock IS the frozen
// evaluation, and the fallback each staged reader takes when the staged load
// THROWS — a broken config must not take the whole verb down. The rule was
// prose, and the instruction it carried ("grep for `loadProjectConfig(`
// before adding a consumer that is not a fallback") relied on someone doing
// the grep. This is the grep (item 362, 2026-09-19).
describe('the raw config load has only its two sanctioned uses', () => {
  const STAGED = /\b(loadProjects|loadCliProjects|stagedLoad)\(/

  it('only these files call loadProjectConfig, and each one earns it', async () => {
    const callers = new Map<string, number[]>()
    for (const rel of new Bun.Glob('**/*.ts').scanSync({ cwd: SRC })) {
      if (rel === 'workspace/project-loader.ts') continue // its own definition
      const lines = (await Bun.file(path.join(SRC, rel)).text()).split('\n')
      const at = lines
        .map((l, i) => (/\bloadProjectConfig\(/.test(l) ? i : -1))
        .filter((i) => i >= 0)
      if (at.length > 0) callers.set(rel, at)
    }
    // A new name here is not automatically wrong — it is a consumer that has
    // to justify itself in this test, which is the point.
    expect([...callers.keys()].sort()).toEqual([
      'cli/lock.ts',
      'cli/select.ts',
      'cli/watch.ts',
      'orchestrator/doctor.ts',
    ])

    for (const [rel, at] of callers) {
      const text = await Bun.file(path.join(SRC, rel)).text()
      const lines = text.split('\n')
      if (rel === 'cli/lock.ts') {
        // The lock is the frozen evaluation; a cached one would freeze a
        // stale object into the file people commit.
        for (const i of at) {
          const call = lines.slice(i, i + 3).join(' ')
          expect({ rel, line: i + 1, fresh: call.includes('fresh: true') }).toEqual({
            rel,
            line: i + 1,
            fresh: true,
          })
        }
        continue
      }
      // Every other caller tries the staged load first and reaches for the
      // raw one only after a `catch`.
      const staged = lines.findIndex((l) => STAGED.test(l))
      expect({ rel, staged: staged >= 0 }).toEqual({ rel, staged: true })
      for (const i of at) {
        // The staged attempt, then a `catch`, then this call: the order is
        // what makes it a fallback rather than a second source of truth.
        const between = lines.slice(staged, i).join('\n')
        expect({
          rel,
          line: i + 1,
          afterStagedCatch: staged < i && /\bcatch\b/.test(between),
        }).toEqual({ rel, line: i + 1, afterStagedCatch: true })
      }
    }
  })
})
