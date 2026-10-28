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
  // `settings`: every setting's path, env name, flag and parse (src/settings.ts).
  settings: ['util'],
  // `handoff`: the hand-off to a project's own vx runs before anything else
  // loads, so it stands alone; the doctor reports which vx ran. `util` only
  // as a lazy import on the submodule path: git spawned with vx's git env
  // and resolved PATH, as every other git spawn is.
  handoff: ['util'],
  // `version`: the lock records which vx validated it.
  // `handoff`: the git top-level, learned once for the hand-off and the root walk.
  workspace: ['util', 'config', 'version', 'settings', 'handoff'],
  graph: ['util', 'config', 'workspace'],
  cache: ['util', 'config'],
  exec: ['util', 'config'],
  // `history`: read-only SQL over what runs left behind; it never runs,
  // renders or writes a run, so it reaches nothing that does.
  history: ['util', 'graph', 'cache'],
  // `report`: renders the outcomes it is handed; it never runs a task or
  // reads the cache, so it reaches neither orchestrator nor cache.
  report: ['util', 'settings', 'exec', 'graph'],
  orchestrator: [
    'util',
    'config',
    'version',
    'handoff',
    'settings',
    'workspace',
    'graph',
    'cache',
    'exec',
    'history',
    'report',
  ],
  // `handoff`: init walks to the git top-level and says the workspace file it wrote is there.
  cli: [
    'util',
    'config',
    'version',
    'handoff',
    'settings',
    'workspace',
    'graph',
    'cache',
    'history',
    'orchestrator',
    'report',
  ],
  index: [
    'util',
    'config',
    'version',
    'settings',
    'workspace',
    'graph',
    'cache',
    'exec',
    'history',
    'orchestrator',
    'report',
  ],
  // `index`: bin lazy-loads the façade so a plugin's `@vzn/vx` resolves
  // to this copy (registerCoreAlias). `version`: a lone `--version` is
  // answered before the dispatcher loads.
  bin: ['util', 'version', 'handoff', 'cli', 'index'],
}

// Modules whose contract (index.ts) is the only legal cross-module
// import target. The ratchet is complete: every directory module.
const CONTRACTED: readonly string[] = [
  'cache',
  'exec',
  'util',
  'workspace',
  'graph',
  'history',
  'orchestrator',
  'report',
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
    // Static `import ... from 'x'` / `export ... from 'x'` specifiers, and
    // `import('x')`: a lazy load crosses a boundary as a static one does
    // (bin.ts loads the façade that way).
    const specs = [
      ...text.matchAll(/^(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm),
      ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ]
    for (const m of specs) {
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
    // The last one (schedule-history) left as a package on
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

// Only `vx lock` and `vx lock --check` evaluate a config (owner,
// 2026-10-14): every other reader — a run, `vx show`, `vx info`, the
// picker, `--affected`, `vx watch`, an embedder — reads the lock. A raw
// `loadProjectConfig` or a load with `configs: 'evaluate'` anywhere else
// answers from a DIFFERENT workspace than the one that runs. The rule was
// prose once (item 362, 2026-09-19); this is the grep.
describe('only vx lock evaluates a config', () => {
  it('only cli/lock.ts calls the loader or asks loadProjects to evaluate', async () => {
    const callers: string[] = []
    for (const rel of new Bun.Glob('**/*.ts').scanSync({ cwd: SRC })) {
      // The loader's own definition, and the load that runs it on request.
      if (rel === 'workspace/project-loader.ts' || rel === 'orchestrator/projects.ts') continue
      const text = await Bun.file(path.join(SRC, rel)).text()
      if (/\bloadProjectConfigs?\(|configs: 'evaluate'/.test(text)) callers.push(rel)
    }
    expect(callers.sort()).toEqual(['cli/lock.ts'])
  })
})
