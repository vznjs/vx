// Cross-package boundary law for the core / sibling-package split. See
// docs/design/core-cloud-split-2026-06.md §9 and
// docs/design/observability-architecture-2026-06.md §9. Sibling to
// module-boundaries.test.ts (which polices intra-core module edges).
//
// Rule 1: every import of vx inside packages/*/src/** must use the bare
//         specifier '@vzn/vx' (the package's public exports), never a deep
//         '@vzn/vx/src/...' path or a relative reach into core.
// Rule 2: core (src/**) never imports a sibling @vzn/vx-* package or any
//         packages/* path — the dependency direction is sibling → core, never
//         the reverse. The OTel/HTTP SDK closures stay out of core's budget.
//         The bare '@vzn/vx' specifier is legal under src/plugins/** ONLY:
//         each core-provided plugin is package-shaped and reaches core the
//         way a sibling does (Rule 4).
// Rule 3: the exact runtime export set of src/index.ts is pinned. A
//         narrowing (a sibling-needed symbol silently un-exported) fails; a
//         widening is a deliberate decision that updates the snapshot.
// Rule 4: every src/plugins/<name>/index.ts imports from '@vzn/vx' and from
//         no other non-relative specifier — so the directory can be lifted
//         into its own package with zero edits.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const ROOT = path.join(import.meta.dir, '..')
const CORE_SRC = path.join(ROOT, 'src')
const PACKAGES_DIR = path.join(ROOT, 'packages')

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

  it('every src/plugins/<name>/index.ts imports core only via the bare @vzn/vx specifier', async () => {
    const pluginsDir = path.join(CORE_SRC, 'plugins')
    const glob = new Bun.Glob('*/index.ts')
    const entries: string[] = []
    for await (const rel of glob.scan({ cwd: pluginsDir })) entries.push(rel)
    expect(entries.sort()).toEqual(['local-cache/index.ts', 'local-executor/index.ts'])
    for (const rel of entries) {
      const imports = await importsOf(path.join(pluginsDir, path.dirname(rel)))
      const bare = imports.filter((i) => !i.specifier.startsWith('.')).map((i) => i.specifier)
      expect(bare).toContain('@vzn/vx')
      expect(new Set(bare)).toEqual(new Set(['@vzn/vx']))
    }
  })

  it('keeps the packages dir present (guards the scan)', () => {
    expect(existsSync(PACKAGES_DIR)).toBe(true)
  })

  it('pins the public runtime export set of src/index.ts', async () => {
    const mod = (await import('../src/index.js')) as Record<string, unknown>
    const actual = Object.keys(mod).sort()
    const expected = [
      'Cache',
      'FULL_CACHE_POLICY',
      'GitFilesCache',
      'LOCKFILE_NAME',
      'LOG_WIRE_VERSION',
      'LayeredCache',
      'RUN_LOG_BUDGET_CHARS',
      'TASK_LOG_TAIL_CHARS',
      'TASK_STATUSES',
      'TELEMETRY_SCHEMA_VERSION',
      'TaskLogBuffer',
      'UserError',
      'VERSION',
      'assembleRunSummary',
      'buildTaskGraph',
      'cacheKeyDiff',
      'captureDefaultBranch',
      'captureGitContext',
      'captureHostContext',
      'captureWorkspaceIdentity',
      'clampInt',
      'cleanOutputs',
      'computeTaskHash',
      'createEventBus',
      'createHashCache',
      'defaultLogger',
      'defineProject',
      'defineWorkspace',
      'deriveCacheSource',
      'deriveStableKeys',
      'detectCi',
      'diffOutputTrees',
      'escapeMarkdownCell',
      'expandRequested',
      'explainCacheKeyQuery',
      'findWorkspaceRoot',
      'getCacheStatsSql',
      'getHistory',
      'getInvocation',
      'getRun',
      // The flakiness classification rule, shared so the cloud analytics twin
      // cannot derive its own answer for the same dashboard badge.
      'isCacheHit',
      'isGroupTask',
      'isPassStatus',
      'listInvocations',
      'listProjectMetas',
      'listProjects',
      'listRuns',
      'loadProjectConfig',
      'loadWorkspace',
      'loadWorkspaceConfig',
      'markSurfacedDeps',
      'parseCachePolicy',
      'parseDecimalInt',
      'planRun',
      'prepareRun',
      'projectNode',
      'projectOutcome',
      'readLockfile',
      'resolveCacheDir',
      'resolveCacheScope',
      'resolveInputs',
      'resolveOutputView',
      'resolveOutputs',
      'run',
      'runCommand',
      'runSandboxed',
      'splitTaskId',
      'toWireEvent',
      'whyDidThisRerunQuery',
      'wireForwarder',
    ]
    expect(actual).toEqual(expected)
  })
})
