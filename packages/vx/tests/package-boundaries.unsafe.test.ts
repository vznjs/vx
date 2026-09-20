// Cross-package boundary law for the core / sibling-package split
// (docs/architecture.md § Repository shape). Sibling to
// module-boundaries.test.ts (which polices intra-core module edges).
//
// Rule 1: every import of vx inside packages/*/src/** must use the bare
//         specifier '@vzn/vx' (the package's public exports), never a deep
//         '@vzn/vx/src/...' path or a relative reach into core.
// Rule 2: core (src/**) never imports a sibling @vzn/vx-* package or any
//         packages/* path — the dependency direction is sibling → core, never
//         the reverse. The OTel/HTTP SDK closures stay out of core's budget.
// Rule 3: the exact runtime export set of src/index.ts is pinned. A
//         narrowing (a sibling-needed symbol silently un-exported) fails; a
//         widening is a deliberate decision that updates the snapshot.
// Rule 4: core ships no plugin — src/plugins does not exist. The last one
//         (schedule-history) is @vzn/vx-schedule-history since 2026-09-10;
//         a new plugin starts life as a package.
// Rule 5: every package's `oxfmt --check .` runs inside the sandbox, and
//         the sandbox runtime masks `<cwd>/.mcp.json`, `.vscode`, `.idea`
//         and `.claude` with a `/dev/null` bind whether or not they exist
//         (its DANGEROUS_FILES), so a walker that meets the mask fails
//         with "Failed to read file". The root config ignored them since
//         aba1c99; the per-package configs written when core moved under
//         packages/ did not, and `@vzn/vx#lint.oxfmt` went red on #431
//         (2026-09-16). Every config ignores every masked name.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const CORE = path.resolve(import.meta.dir, '..')
const CORE_SRC = path.join(CORE, 'src')
// The plugin packages are core's SIBLINGS under the workspace root, which is
// two levels above core now that core is `packages/vx` rather than the root.
const PACKAGES_DIR = path.join(CORE, '..')

async function importsOf(dir: string): Promise<{ file: string; specifier: string }[]> {
  const out: { file: string; specifier: string }[] = []
  const glob = new Bun.Glob('**/*.ts')
  for await (const rel of glob.scan({ cwd: dir })) {
    const text = await Bun.file(path.join(dir, rel)).text()
    for (const m of text.matchAll(/^(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
      out.push({ file: rel.split(path.sep).join('/'), specifier: m[1]! })
    }
  }
  return out
}

/** Every `packages/<name>/src` directory that exists. */
async function packageSrcDirs(): Promise<{ name: string; src: string }[]> {
  const out: { name: string; src: string }[] = []
  const glob = new Bun.Glob('*/src')
  for await (const rel of glob.scan({ cwd: PACKAGES_DIR, onlyFiles: false })) {
    const name = rel.split(path.sep)[0]!
    // Core lives under packages/ too, but it is the thing the others import —
    // scanning it here would ask core to import itself by bare specifier.
    if (name === 'vx') continue
    out.push({ name, src: path.join(PACKAGES_DIR, rel) })
  }
  return out
}

describe('package boundaries', () => {
  it('every packages/*/src imports vx only via the bare @vzn/vx specifier', async () => {
    const dirs = await packageSrcDirs()
    expect(dirs.length).toBeGreaterThan(0)
    const allViolations: string[] = []
    for (const { name, src } of dirs) {
      const imports = await importsOf(src)
      const violations = imports.filter(
        (i) =>
          i.specifier === '@vzn/vx/src' ||
          i.specifier.startsWith('@vzn/vx/src/') ||
          // a relative path that climbs out of the package into core src
          /(?:\.\.\/)+src\//.test(i.specifier),
      )
      allViolations.push(...violations.map((v) => `${name}/src/${v.file} → ${v.specifier}`))
    }
    expect(allViolations).toEqual([])
  })

  it('core (src/**) never imports a sibling @vzn/vx-* package or packages/*', async () => {
    const imports = await importsOf(CORE_SRC)
    const violations = imports.filter(
      (i) =>
        (i.specifier.startsWith('@vzn/vx-') && i.specifier !== '@vzn/vx') ||
        i.specifier.includes('packages/'),
    )
    expect(violations.map((v) => `${v.file} → ${v.specifier}`)).toEqual([])
  })

  it('core ships no plugin: src/plugins does not exist', () => {
    expect(existsSync(path.join(CORE_SRC, 'plugins'))).toBe(false)
  })

  it('keeps the packages dir present (guards the scan)', () => {
    expect(existsSync(PACKAGES_DIR)).toBe(true)
  })

  it('pins the public runtime export set of src/index.ts', async () => {
    const mod = (await import('../src/index.js')) as Record<string, unknown>
    const actual = Object.keys(mod).sort()
    const expected = [
      'Cache',
      'LOG_WIRE_VERSION',
      'LayeredCache',
      'LocalHistoryProvider',
      'PERSISTENT_TASK_NAMES',
      'PERSISTENT_TODO',
      'PLUGIN_HOOKS',
      'TASK_STATUSES',
      'TELEMETRY_SCHEMA_VERSION',
      'TaskLogBuffer',
      'UserError',
      'VERSION',
      'applyMigration',
      'buildPackageGraph',
      'clampInt',
      'collectInfo',
      'definePlugin',
      'defineProject',
      'defineWorkspace',
      'deriveCacheSource',
      'escapeMarkdownCell',
      'exitSignal',
      'findWorkspaceRoot',
      'isCacheHit',
      'isPassStatus',
      'isUserError',
      'latestRunId',
      'listProjectMetas',
      'loadProjectConfig',
      'loadResolvedProjects',
      'loadWorkspace',
      'lockfileClaim',
      'machineMemoryBytes',
      'machineParallelism',
      'nearMatches',
      // Widened 2026-09-20 (item 445): `@vzn/vx-migrate` asks the same
      // "do these two output globs provably overlap?" question at
      // migration time, and asked it with a COPY of core's function. The
      // copy missed items 441 and 442, so the migration reported clean on
      // configs core then refused to load. One rule, one place.
      'outputsOverlap',
      'planRun',
      'prepareRun',
      'quoteTsLiteral',
      'reachDigests',
      'run',
      'splitTaskId',
      'whyDidThisRerunQuery',
    ]
    expect(actual).toEqual(expected)
  })

  it('every package oxfmt config ignores the names the sandbox masks', async () => {
    const masked = ['.mcp.json', '.vscode', '.idea', '.claude']
    const configs = [path.join(PACKAGES_DIR, '..', '.oxfmtrc.json')]
    const glob = new Bun.Glob('*/.oxfmtrc.json')
    for await (const rel of glob.scan({ cwd: PACKAGES_DIR, dot: true })) {
      configs.push(path.join(PACKAGES_DIR, rel))
    }
    expect(configs.length).toBeGreaterThan(5)
    const lacking: string[] = []
    for (const file of configs) {
      const cfg = JSON.parse(await Bun.file(file).text()) as { ignorePatterns?: string[] }
      const ignored = cfg.ignorePatterns ?? []
      for (const name of masked) {
        if (!ignored.includes(name))
          lacking.push(`${path.relative(PACKAGES_DIR, file)} lacks ${name}`)
      }
    }
    expect(lacking).toEqual([])
  })

  // Rule 6: the runtime floor. Every package declares `engines.bun`, and a
  // package that ALSO enforces a floor in code (core's
  // `util/bun-version.ts`, `@vzn/vx-reapi`'s `wire.ts`) may require a newer
  // Bun than it declares but never an older one — a constant below its own
  // manifest is a promise the package does not keep. They are equal today,
  // and equal for different reasons: core's floor is the answers an older
  // Bun gets WRONG — item 366 measured three, and `bun-version.ts` names
  // them — while the plugin's is an http2 client that hangs on its chunked
  // uploads. Nothing requires them to move together, so this holds the
  // relation, not the value (item 368).
  it('every package declares engines.bun, and no code floor sits below it', async () => {
    // Lexicographic, not component-wise: a floor of 2.0.0 against an engines
    // of 1.9.0 is NEWER, and a `some(n < e)` over the parts calls it older on
    // the minor. Proven below before it is used.
    const lessThan = (a: readonly number[], b: readonly number[]): boolean => {
      for (let i = 0; i < 3; i += 1) {
        if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number)
      }
      return false
    }
    expect([
      lessThan([1, 3, 11], [1, 4, 0]),
      lessThan([2, 0, 0], [1, 9, 0]),
      lessThan([1, 4, 0], [1, 4, 0]),
      lessThan([1, 4, 1], [1, 4, 0]),
    ]).toEqual([true, false, false, false])
    const parse = (range: string): number[] => {
      const m = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/.exec(range)
      expect({ range, understood: m !== null }).toEqual({ range, understood: true })
      return [Number(m![1]), Number(m![2]), Number(m![3] ?? 0)]
    }
    const declared = new Map<string, number[]>()
    const glob = new Bun.Glob('*/package.json')
    for await (const rel of glob.scan({ cwd: PACKAGES_DIR })) {
      const pkg = JSON.parse(await Bun.file(path.join(PACKAGES_DIR, rel)).text()) as {
        name: string
        engines?: { bun?: string }
      }
      const range = pkg.engines?.bun
      expect({ pkg: pkg.name, declaresBun: range !== undefined }).toEqual({
        pkg: pkg.name,
        declaresBun: true,
      })
      declared.set(rel.split('/')[0] as string, parse(range as string))
    }
    expect(declared.size).toBeGreaterThan(8)

    const below: string[] = []
    const src = new Bun.Glob('*/src/**/*.ts')
    for await (const rel of src.scan({ cwd: PACKAGES_DIR })) {
      const text = await Bun.file(path.join(PACKAGES_DIR, rel)).text()
      const m = /MIN_BUN = \[(\d+), (\d+), (\d+)\]/.exec(text)
      if (m === null) continue
      const dir = rel.split('/')[0] as string
      const floor = [Number(m[1]), Number(m[2]), Number(m[3])]
      const engines = declared.get(dir) as number[]
      if (lessThan(floor, engines)) {
        below.push(`${rel}: MIN_BUN ${floor.join('.')} < engines ${engines.join('.')}`)
      }
    }
    expect(below).toEqual([])
  })
})

// Rule 3 pins the RUNTIME export set, which types are not — so the façade
// could name a function and withhold the type it returns, and did: `run` and
// `prepareRun` both had theirs, `planRun` did not, while docs/cli.md
// § Programmatic API listed all three as the surface an embedder builds on
// (item 387, 2026-09-19). Discovered from the façade rather than listed: the
// next engine function re-exported here is held to the same rule without an
// edit.
describe('the programmatic surface names every type it returns', () => {
  it('each engine function re-exported from src/index.ts exports its result type', async () => {
    const facade = await Bun.file(path.join(CORE_SRC, 'index.ts')).text()
    const fns = [...facade.matchAll(/^export \{([^}]+)\} from '\.\/orchestrator\/index\.js'$/gm)]
      .flatMap((m) => m[1]!.split(',').map((s) => s.trim()))
      .filter((s) => s !== '' && !s.startsWith('type '))
    expect(fns).toContain('planRun')

    let orchestrator = ''
    const files = new Bun.Glob('*.ts')
    for await (const rel of files.scan({ cwd: path.join(CORE_SRC, 'orchestrator') })) {
      orchestrator += await Bun.file(path.join(CORE_SRC, 'orchestrator', rel)).text()
    }
    // Both spellings the façade uses: a whole `export type { … }` clause and
    // a `type X` member inside a value `export { … }`. Reading only the first
    // reported `collectInfo → InfoFacts` missing when the line right above
    // exports it — a naive selector passes by claiming a gap as readily as by
    // missing one.
    const exportedTypes = new Set(
      [...facade.matchAll(/^export (type )?\{([^}]+)\} from/gms)].flatMap((m) =>
        m[2]!
          .split(',')
          .map((s) => s.trim())
          .filter((s) => m[1] !== undefined || s.startsWith('type '))
          .map((s) => s.replace(/^type\s+/, '').split(/\s+as\s+/)[0]!),
      ),
    )
    // A built-in needs no export; only a type core declares can be withheld.
    const BUILTIN = new Set([
      'Map',
      'Set',
      'Array',
      'Promise',
      'void',
      'string',
      'number',
      'boolean',
    ])
    const missing: string[] = []
    const checked: string[] = []
    for (const fn of fns) {
      const decl = new RegExp(
        String.raw`export async function ${fn}\b[\s\S]*?\): Promise<([A-Za-z]+)`,
      ).exec(orchestrator)
      if (decl === null) continue
      checked.push(fn)
      const type = decl[1]!
      if (!BUILTIN.has(type) && !exportedTypes.has(type)) missing.push(`${fn} → ${type}`)
    }
    // The rule reaches every async engine function on the façade, not a list
    // of three: these are the ones docs/cli.md names, and the check must have
    // found them for `missing` to mean anything.
    for (const fn of ['run', 'planRun', 'prepareRun']) expect(checked).toContain(fn)
    expect(missing).toEqual([])
  })
})
