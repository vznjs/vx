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
// Rule 3: the exact runtime export set of src/index.ts is pinned. A
//         narrowing (a sibling-needed symbol silently un-exported) fails; a
//         widening is a deliberate decision that updates the snapshot.

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

  it('keeps the packages dir present (guards the scan)', () => {
    expect(existsSync(PACKAGES_DIR)).toBe(true)
  })

  it('pins the public runtime export set of src/index.ts', async () => {
    const mod = (await import('../src/index.js')) as Record<string, unknown>
    const actual = Object.keys(mod).sort()
    const expected = [
      'Cache',
      'ENVELOPE_ERRORS',
      'FULL_CACHE_POLICY',
      'GitFilesCache',
      'LOCKFILE_NAME',
      'LayeredCache',
      'TASK_STATUSES',
      'TELEMETRY_SCHEMA_VERSION',
      'UserError',
      'VERSION',
      'WIRE_CHANNELS',
      'WIRE_PROTOCOL_VERSION',
      'assembleRunSummary',
      'buildTaskGraph',
      'cacheKeyDiff',
      'captureDefaultBranch',
      'captureGitContext',
      'captureHostContext',
      'captureWorkspaceIdentity',
      'clampInt',
      'cleanOutputs',
      'clientMessageToEnvelope',
      'compareRuns',
      'computeTaskHash',
      'createEventBus',
      'createHashCache',
      'createVxSurface',
      'createWireRenderer',
      'decodeEnvelope',
      'defaultLogger',
      'defineProject',
      'defineWorkspace',
      'deriveCacheSource',
      'deriveStableKeys',
      'detectCi',
      'diffOutputTrees',
      'encodeForNDJSON',
      'encodeForSSE',
      'encodeForWS',
      'envelopeToClientMessage',
      'envelopeToServerMessage',
      'expandRequested',
      'explainCacheKeyQuery',
      'findWorkspaceRoot',
      'getBottlenecks',
      'getCacheBreakdown',
      'getCacheSavings',
      'getCacheStatsSql',
      'getFlakiestTasks',
      'getHistory',
      'getHitRateSplit',
      'getInvocation',
      'getParallelismHistory',
      'getPeriodComparison',
      'getPrunableEntries',
      'getRecentFailures',
      'getRegressions',
      'getRun',
      'getRunHeatmap',
      'getRunTrends',
      'getStorageGrowth',
      'getTaskDetail',
      'getTopTimeBurners',
      'isCacheHit',
      'isEnvelope',
      'isGroupTask',
      'isNotification',
      'isPassStatus',
      'isRequest',
      'listCacheEntries',
      'listInvocations',
      'listProjectMetas',
      'listProjects',
      'listRuns',
      'loadProjectConfig',
      'loadWorkspace',
      'loadWorkspaceConfig',
      'makeError',
      'makeNotification',
      'makeRequest',
      'makeResponse',
      'markSurfacedDeps',
      'optionsToRequest',
      'parseCachePolicy',
      'planRun',
      'prepareRun',
      'projectNode',
      'projectOutcome',
      'readLockfile',
      'requestToOptions',
      'resolveCacheDir',
      'resolveCacheScope',
      'resolveInputs',
      'resolveOutputView',
      'resolveOutputs',
      'run',
      'serverMessageToEnvelope',
      'splitTaskId',
      'toWireEvent',
      'whyDidThisRerunQuery',
      'wireForwarder',
    ]
    expect(actual).toEqual(expected)
  })
})
