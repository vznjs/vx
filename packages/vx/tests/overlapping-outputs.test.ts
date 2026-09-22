// The addition shape of docs/design/overlapping-outputs-2026-09.md, end to
// end (item 588): `build` fills `dist`, `individual` depends on it and adds
// `dist/individual` (twenty's twenty-ui; storybook's sandbox/build is the
// same shape). Before 588 the pair was refused at graph build. Every row
// compares the tree under `dist` byte for byte with a COLD run of the same
// sources in a fresh workspace, which is the design note's acceptance:
// whatever the cache did, the tree is what the two commands produce.
import { readFile, rm, writeFile } from 'node:fs/promises'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import type { Logger } from '../src/orchestrator/index.js'
import { prepareRun, run } from '../src/orchestrator/index.js'
import { startLocalShortCircuit } from '../src/orchestrator/local-shortcircuit.js'

const silent = new Proxy({}, { get: () => () => undefined }) as Logger
const TIMEOUT = 30_000

// Two shapes of the same pair. SUBDIRECTORY (twenty): the dependant
// declares `dist/individual`, so its own glob never selects the upstream's
// files and only the upstream's current-check has to ignore the addition.
// SAME TREE (strapi's `build` / `build:types`, both on `dist/**`): the
// dependant's glob selects the upstream's files too, so its artifact must
// be narrowed to what its run added, and its hit must clean by rows.
const SHAPES = { subdirectory: "['dist/individual']", 'same tree': "['dist']" } as const
const configFor = (dependantOutputs: string): string => `
  export default {
    tasks: {
      build: {
        exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.txt && cp src/a.txt dist/a2.txt' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist'] } },
      },
      individual: {
        dependsOn: ['build'],
        exec: { command: 'mkdir -p dist/individual && cp srcb/b.txt dist/individual/b.txt' },
        // Detached from build's key (inputs.tasks: []) so it can HIT while
        // build misses — the arrangement the note names as the hazard.
        cache: { inputs: { files: ['srcb/**'], tasks: [] }, outputs: { files: ${dependantOutputs} } },
      },
      noop: {
        // Third in the chain, as strapi's build → build:code → build:types:
        // an overlap with individual too, ordered by this edge.
        dependsOn: ['individual'],
        exec: { command: 'true' },
        cache: { inputs: { files: ['srcb/**'], tasks: [] }, outputs: { files: ['dist/noop'] } },
      },
    },
  }
`
const TASKS = ['build', 'individual', 'noop']

interface Ws {
  root: string
  app: string
}

async function workspace(a: string, b: string, config: string): Promise<Ws> {
  const root = await makeWorkspace({ prefix: 'vx-ovl-' })
  const app = await addProject(root, 'app', { files: { 'src/a.txt': a, 'srcb/b.txt': b }, config })
  return { root, app }
}

/** Every file under dist with its bytes, sorted — the whole observable tree. */
function tree(app: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir).sort()) {
      const p = path.join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else
        out.push([
          path.relative(app, p).split(path.sep).join('/'),
          require('node:fs').readFileSync(p, 'utf8'),
        ])
    }
  }
  try {
    walk(path.join(app, 'dist'))
  } catch {
    // no dist
  }
  return out
}

/** The tree a cold run of both commands produces for these sources. */
async function coldTree(a: string, b: string, config: string): Promise<Array<[string, string]>> {
  const ws = await workspace(a, b, config)
  try {
    const r = await run({ cwd: ws.root, tasks: TASKS, log: silent })
    expect(r.ok).toBe(true)
    return tree(ws.app)
  } finally {
    await rm(ws.root, { recursive: true, force: true })
  }
}

const statusOf = (r: Awaited<ReturnType<typeof run>>): Record<string, string> =>
  Object.fromEntries(
    r.outcomes.map((o) => [o.node.taskName, o.status + (o.restored ? '+restored' : '')]),
  )

describe.each(Object.entries(SHAPES))('overlapping outputs, addition shape: %s', (_shape, outs) => {
  const config = configFor(outs)
  let ws: Ws
  beforeEach(async () => {
    ws = await workspace('A1', 'B1', config)
  })
  afterEach(async () => {
    await rm(ws.root, { recursive: true, force: true })
  })

  it(
    'both miss, then both hit up-to-date: the tree is the cold tree, twice',
    async () => {
      const cold = await run({ cwd: ws.root, tasks: TASKS, log: silent })
      expect(statusOf(cold)).toEqual({ build: 'success', individual: 'success', noop: 'success' })
      expect(tree(ws.app)).toEqual(await coldTree('A1', 'B1', config))
      const warm = await run({ cwd: ws.root, tasks: TASKS, log: silent })
      // Neither restores: build's current-check ignores what individual
      // declares it adds, and individual's checks only its own rows. noop's
      // artifact holds no rows, and a hit with no rows has always extracted
      // its (empty) artifact rather than skipping — pre-existing, not 588's.
      expect(statusOf(warm)).toEqual({
        build: 'cache-hit',
        individual: 'cache-hit',
        noop: 'cache-hit+restored',
      })
      expect(tree(ws.app)).toEqual(await coldTree('A1', 'B1', config))
    },
    TIMEOUT,
  )

  it(
    'upstream MISS + dependant HIT: build re-runs and wipes dist, individual restores its own rows after',
    async () => {
      await run({ cwd: ws.root, tasks: TASKS, log: silent })
      await writeFile(path.join(ws.app, 'src', 'a.txt'), 'A2')
      const r = await run({ cwd: ws.root, tasks: TASKS, log: silent })
      expect(statusOf(r)).toEqual({
        build: 'success',
        individual: 'cache-hit+restored',
        noop: 'cache-hit+restored',
      })
      // The sharp claim: individual's artifact holds ONLY dist/individual.
      // Had it captured dist/a.txt at save time (the glob walk), this
      // restore would bring A1 back over build's fresh A2.
      expect(tree(ws.app)).toEqual(await coldTree('A2', 'B1', config))
    },
    TIMEOUT,
  )

  it(
    'upstream HIT + dependant MISS: build stays up-to-date, individual re-runs beside it',
    async () => {
      await run({ cwd: ws.root, tasks: TASKS, log: silent })
      await writeFile(path.join(ws.app, 'srcb', 'b.txt'), 'B2')
      const r = await run({ cwd: ws.root, tasks: TASKS, log: silent })
      expect(statusOf(r)).toEqual({ build: 'cache-hit', individual: 'success', noop: 'success' })
      expect(tree(ws.app)).toEqual(await coldTree('A1', 'B2', config))
    },
    TIMEOUT,
  )

  it(
    'a dependant that adds nothing saves an empty set and its hit leaves the upstream tree alone',
    async () => {
      await run({ cwd: ws.root, tasks: TASKS, log: silent })
      await writeFile(path.join(ws.app, 'srcb', 'b.txt'), 'B2')
      await run({ cwd: ws.root, tasks: TASKS, log: silent })
      await writeFile(path.join(ws.app, 'srcb', 'b.txt'), 'B1')
      // noop hits its first entry again; individual hits its first entry
      // and restores b.txt=B1 over B2; build untouched.
      const r = await run({ cwd: ws.root, tasks: TASKS, log: silent })
      expect(statusOf(r)).toEqual({
        build: 'cache-hit',
        individual: 'cache-hit+restored',
        noop: 'cache-hit+restored',
      })
      expect(tree(ws.app)).toEqual(await coldTree('A1', 'B1', config))
    },
    TIMEOUT,
  )

  it(
    'the dependant is never restore-tier: it restores only after its upstream is on disk',
    async () => {
      await run({ cwd: ws.root, tasks: TASKS, log: silent })
      const prepared = await prepareRun({ cwd: ws.root, tasks: TASKS, log: silent }, silent)
      try {
        const sc = await startLocalShortCircuit({
          nodes: prepared.nodes,
          cache: prepared.cache,
          workspaceRoot: prepared.workspaceRoot,
          workspaceFingerprint: prepared.workspaceFingerprint,
          nestedDirsByProject: prepared.nestedDirsByProject,
          gitFilesCache: prepared.gitFilesCache,
          hashCache: prepared.hashCache,
          concurrency: 4,
        })
        expect(sc.restoreTier.has('app#individual')).toBe(false)
        expect(sc.restoreTier.has('app#noop')).toBe(false)
        // CONTROL: the upstream's own hit is restore-tier as any leaf hit is.
        expect(sc.restoreTier.has('app#build')).toBe(true)
      } finally {
        prepared.cache.close()
      }
    },
    TIMEOUT,
  )
})
