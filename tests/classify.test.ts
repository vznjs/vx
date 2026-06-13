import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { prepareRun } from '../src/orchestrator/prepare.js'
import { classifyTasks } from '../src/orchestrator/classify.js'
import { computeTaskHash } from '../src/orchestrator/task-hash.js'
import { run } from '../src/orchestrator/index.js'
import type { TaskOutcome } from '../src/graph/index.js'

const TIMEOUT = 30_000

interface WS {
  root: string
}

async function makeWorkspace(): Promise<WS> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-classify-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  initGitRepo(root)
  return { root }
}

function initGitRepo(cwd: string): void {
  const g = (...args: string[]): void => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0)
      throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(p.stderr)}`)
  }
  g('init', '-q')
  g('config', 'user.email', 'test@vx.local')
  g('config', 'user.name', 'vx test')
}

async function addProject(
  root: string,
  name: string,
  args: { deps?: Record<string, string>; files?: Record<string, string>; config: string },
): Promise<string> {
  const safe = name.replace('@', '').replace('/', '-')
  const dir = path.join(root, 'packages', safe)
  await mkdir(dir, { recursive: true })
  const pkg: Record<string, unknown> = { name, version: '0.0.0' }
  if (args.deps && Object.keys(args.deps).length > 0) pkg.dependencies = args.deps
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  await writeFile(path.join(dir, 'vx.config.mjs'), args.config)
  for (const [rel, content] of Object.entries(args.files ?? {})) {
    const full = path.join(dir, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return dir
}

const silent = () => ({
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
})

describe('upfront classification', () => {
  let ws: WS

  beforeEach(async () => {
    ws = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(ws.root, { recursive: true, force: true })
  })

  it(
    'derives each stable-input task key by folding upstream KEYS topologically — identical to the per-task path',
    async () => {
      // lib#build (workspace dep), app#build depends on ^build. Both
      // have narrow inputs that cannot match upstream outputs, so they
      // are stable-input tasks: their upfront key must equal what
      // computeTaskHash derives with the real upstream outcome.
      await addProject(ws.root, 'lib', {
        files: { 'src/x.txt': 'v1' },
        config: `export default { tasks: { build: {
          exec: { command: "cat src/x.txt > dist.txt" },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist.txt'] } },
        } } }`,
      })
      await addProject(ws.root, 'app', {
        deps: { lib: 'workspace:*' },
        files: { 'src/y.txt': 'app' },
        config: `export default { tasks: { build: {
          exec: { command: "cat src/y.txt > out.txt" },
          dependsOn: ['^build'],
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      })

      const prepared = await prepareRun({ cwd: ws.root, tasks: ['build'], log: silent() }, silent())
      if (prepared.empty !== null) throw new Error('expected non-empty prepared run')
      try {
        const cls = await classifyTasks({
          nodes: prepared.nodes,
          workspaceRoot: prepared.workspaceRoot,
          workspaceFingerprint: prepared.workspaceFingerprint,
          cache: prepared.cache,
          noCache: false,
          nestedDirsByProject: prepared.nestedDirsByProject,
          gitFilesCache: prepared.gitFilesCache,
          hashCache: prepared.hashCache,
        })

        const libKey = cls.byId.get('lib#build')!.key
        const appKey = cls.byId.get('app#build')!.key
        expect(libKey).toBeTruthy()
        expect(appKey).toBeTruthy()

        // Neither task globs an upstream output → both stable.
        expect(cls.byId.get('lib#build')!.needsRecompute).toBe(false)
        expect(cls.byId.get('app#build')!.needsRecompute).toBe(false)

        // app#build's authoritative key, computed with the real
        // upstream outcome carrying lib's key, must match the upfront
        // one (pure-input transitive: upstream outcome.hash IS its key).
        const libOutcome: TaskOutcome = {
          node: prepared.nodes.get('lib#build')!,
          status: 'success',
          exitCode: 0,
          durationMs: 0,
          hash: libKey,
        }
        const recomputed = await computeTaskHash({
          node: prepared.nodes.get('app#build')!,
          upstream: [libOutcome],
          workspaceRoot: prepared.workspaceRoot,
          workspaceFingerprint: prepared.workspaceFingerprint,
          cache: prepared.cache,
          nestedProjectDirs: prepared.nestedDirsByProject.get('app') ?? [],
          gitFilesCache: prepared.gitFilesCache,
          hashCache: prepared.hashCache,
        })
        expect(recomputed).toBe(appKey)
      } finally {
        prepared.cache.close()
      }
    },
    TIMEOUT,
  )

  it(
    'classifies all-miss before any cache exists, then up-to-date on a warm run',
    async () => {
      await addProject(ws.root, 'solo', {
        files: { 'src/a.txt': 'hello' },
        config: `export default { tasks: { build: {
          exec: { command: "cat src/a.txt > out.txt" },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      })

      // Cold: classification sees one miss.
      const cold = await prepareRun({ cwd: ws.root, tasks: ['build'], log: silent() }, silent())
      if (cold.empty !== null) throw new Error('non-empty')
      const clsCold = await classifyTasks({
        nodes: cold.nodes,
        workspaceRoot: cold.workspaceRoot,
        workspaceFingerprint: cold.workspaceFingerprint,
        cache: cold.cache,
        noCache: false,
        nestedDirsByProject: cold.nestedDirsByProject,
        gitFilesCache: cold.gitFilesCache,
        hashCache: cold.hashCache,
      })
      expect(clsCold.miss).toBe(1)
      expect(clsCold.upToDate).toBe(0)
      expect(clsCold.restoredLocal).toBe(0)
      cold.cache.close()

      // Run for real to populate the cache + leave outputs on disk.
      await run({ cwd: ws.root, tasks: ['build'], log: silent() })

      // Warm: outputs already current on disk → up-to-date.
      const warm = await prepareRun({ cwd: ws.root, tasks: ['build'], log: silent() }, silent())
      if (warm.empty !== null) throw new Error('non-empty')
      const clsWarm = await classifyTasks({
        nodes: warm.nodes,
        workspaceRoot: warm.workspaceRoot,
        workspaceFingerprint: warm.workspaceFingerprint,
        cache: warm.cache,
        noCache: false,
        nestedDirsByProject: warm.nestedDirsByProject,
        gitFilesCache: warm.gitFilesCache,
        hashCache: warm.hashCache,
      })
      expect(clsWarm.miss).toBe(0)
      expect(clsWarm.upToDate).toBe(1)
      expect(clsWarm.restoredLocal).toBe(0)
      warm.cache.close()
    },
    TIMEOUT,
  )

  it(
    'flags a consumer that globs an upstream-generated file for mid-run recompute',
    async () => {
      // codegen writes generated.txt; build inputs `**/*` which matches
      // generated.txt — build cannot trust its upfront key.
      await addProject(ws.root, 'gen', {
        files: { 'src/in.txt': 'v1' },
        config: `export default { tasks: {
          codegen: {
            exec: { command: "cat src/in.txt > generated.txt" },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['generated.txt'] } },
          },
          build: {
            exec: { command: "cat generated.txt > out.txt" },
            dependsOn: ['codegen'],
            cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
          },
        } }`,
      })
      const prepared = await prepareRun({ cwd: ws.root, tasks: ['build'], log: silent() }, silent())
      if (prepared.empty !== null) throw new Error('non-empty')
      try {
        const cls = await classifyTasks({
          nodes: prepared.nodes,
          workspaceRoot: prepared.workspaceRoot,
          workspaceFingerprint: prepared.workspaceFingerprint,
          cache: prepared.cache,
          noCache: false,
          nestedDirsByProject: prepared.nestedDirsByProject,
          gitFilesCache: prepared.gitFilesCache,
          hashCache: prepared.hashCache,
        })
        // codegen's narrow input cannot see its own output dir → stable.
        expect(cls.byId.get('gen#codegen')!.needsRecompute).toBe(false)
        // build globs `**/*` over generated.txt → preliminary.
        expect(cls.byId.get('gen#build')!.needsRecompute).toBe(true)
      } finally {
        prepared.cache.close()
      }
    },
    TIMEOUT,
  )
})
