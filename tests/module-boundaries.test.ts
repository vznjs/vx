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

import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const SRC = path.join(import.meta.dir, '..', 'src')

/** Module of a src-relative file path. Root files are their own modules. */
function moduleOf(rel: string): string {
  const seg = rel.split('/')
  if (seg.length > 1) return seg[0]!
  return rel.replace(/\.ts$/, '') // bin / index / config / version
}

const ALLOWED: Record<string, readonly string[]> = {
  util: [],
  config: [],
  version: [],
  workspace: ['util', 'config'],
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
