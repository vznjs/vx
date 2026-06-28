// Cross-package boundary law for the core / cloud split. See
// docs/design/core-cloud-split-2026-06.md §9. Sibling to
// module-boundaries.test.ts (which polices intra-core module edges).
//
// Rule 1: every import of vx inside packages/cloud/src/** must use the
//         bare specifier '@vzn/vx' (the package's public exports), never a
//         deep '@vzn/vx/src/...' path or a relative reach into core.
// Rule 2: core (src/**) never imports '@vzn/vx-cloud' or any packages/cloud
//         path — the dependency direction is cloud → core, never the reverse.
// Rule 3: the exact runtime export set of src/index.ts is pinned. A
//         narrowing (a cloud-needed symbol silently un-exported) fails; a
//         widening is a deliberate decision that updates the snapshot.

import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const ROOT = path.join(import.meta.dir, '..')
const CORE_SRC = path.join(ROOT, 'src')
const CLOUD_SRC = path.join(ROOT, 'packages', 'cloud', 'src')

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

describe('package boundaries', () => {
  it('packages/cloud/src imports vx only via the bare @vzn/vx specifier', async () => {
    const imports = await importsOf(CLOUD_SRC)
    expect(imports.length).toBeGreaterThan(0)
    const violations = imports.filter(
      (i) =>
        i.specifier === '@vzn/vx/src' ||
        i.specifier.startsWith('@vzn/vx/src/') ||
        // a relative path that climbs out of packages/cloud into core src
        /(?:\.\.\/)+src\//.test(i.specifier),
    )
    expect(violations.map((v) => `${v.file} → ${v.specifier}`)).toEqual([])
  })

  it('core (src/**) never imports @vzn/vx-cloud or packages/cloud', async () => {
    const imports = await importsOf(CORE_SRC)
    const violations = imports.filter(
      (i) => i.specifier.startsWith('@vzn/vx-cloud') || i.specifier.includes('packages/cloud'),
    )
    expect(violations.map((v) => `${v.file} → ${v.specifier}`)).toEqual([])
  })

  it('pins the public runtime export set of src/index.ts', async () => {
    const mod = (await import('../src/index.js')) as Record<string, unknown>
    const actual = Object.keys(mod).sort()
    const expected = [
      'Cache',
      'ENVELOPE_ERRORS',
      'FULL_CACHE_POLICY',
      'FsCASBackend',
      'GitFilesCache',
      'LayeredCache',
      'MemoryCASBackend',
      'RemoteCache',
      'UserError',
      'VERSION',
      'WIRE_CHANNELS',
      'WIRE_PROTOCOL_VERSION',
      'buildTaskGraph',
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
      'digestEqual',
      'digestString',
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
      'getParallelismHistory',
      'getPrunableEntries',
      'getRecentFailures',
      'getRun',
      'getRunHeatmap',
      'getRunTrends',
      'getStorageGrowth',
      'getTaskDetail',
      'getTopTimeBurners',
      'isEnvelope',
      'isGroupTask',
      'isNotification',
      'isRequest',
      'listCacheEntries',
      'listInvocations',
      'listProjects',
      'listRuns',
      'loadWorkspaceConfig',
      'makeDigest',
      'makeError',
      'makeNotification',
      'makeRequest',
      'makeResponse',
      'markSurfacedDeps',
      'optionsToRequest',
      'parseCachePolicy',
      'parseDigest',
      'planRun',
      'prepareRun',
      'projectNode',
      'projectOutcome',
      'requestToOptions',
      'resolveCacheDir',
      'resolveInputs',
      'resolveOutputView',
      'resolveOutputs',
      'run',
      'serverMessageToEnvelope',
      'toWireEvent',
      'whyDidThisRerunQuery',
      'wireForwarder',
      'workerExecute',
    ]
    expect(actual).toEqual(expected)
  })
})
