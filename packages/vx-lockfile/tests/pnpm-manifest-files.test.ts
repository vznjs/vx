// pnpm takes `package.yaml` or `package.json5` as a member's manifest and
// records its `link:` dependencies in pnpm-lock.yaml (pnpm 10.28, probed).
// pnpm() read only `package.json`: such a member lost its `^build` edges
// to the packages it links, was named by its path, and had package.json,
// not its manifest, as its tasks' input, so it built beside q and hit with
// old content. The lockfile is the one that install wrote.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { type DiscoverContext, type Logger } from '@vzn/vx'
import { planRun } from '../../vx/tests/helpers/orchestrator.js'
import { pnpm } from '../src/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const BUILD =
  "export default { tasks: { build: { dependsOn: ['^build'], exec: { command: 'echo built' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true } } }\n"
const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  packages/p:
    dependencies:
      q:
        specifier: workspace:*
        version: link:../q

  packages/q: {}

  packages/r:
    dependencies:
      q:
        specifier: workspace:*
        version: link:../q
`
const MANIFESTS = {
  p: ['package.yaml', 'name: p\nversion: 1.0.0\ndependencies:\n  q: workspace:*\n'],
  q: ['package.json', '{"name":"q","version":"1.0.0"}'],
  r: ['package.json5', "{name: 'r', version: '1.0.0', dependencies: {q: 'workspace:*',},}\n"],
} as const

const silent = (): Logger =>
  ({
    runStart() {},
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
    status() {},
  }) as never

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-pnpm-manifests-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  await writeFile(path.join(root, 'pnpm-lock.yaml'), LOCK)
  for (const [name, [file, text]] of Object.entries(MANIFESTS)) {
    const dir = path.join(root, 'packages', name)
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, file), text)
    await writeFile(path.join(dir, 'src', 'index.js'), `// ${name}\n`)
    await writeFile(path.join(dir, 'vx.config.mjs'), BUILD)
  }
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource(['pnpm()'], `import { pnpm } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function discover() {
  const ctx: DiscoverContext = {
    workspaceRoot: root,
    cacheDir: path.join(root, '.vx', 'cache'),
    projects: [],
    warn: () => {},
    worktreeChanges: async () => null,
  }
  return (await pnpm().discover!(ctx)).map((e) => ({
    dir: path.relative(root, e.dir),
    name: e.name,
    deps: (e.deps ?? []).map((d) => path.relative(root, d)),
  }))
}

const plan = async () =>
  new Map(
    (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks.map((t) => [
      t.node.id,
      t,
    ]),
  )

it('a package.yaml or package.json5 member is named by it and keeps its edges', async () => {
  expect(await discover()).toEqual([
    { dir: 'packages/p', name: 'p', deps: ['packages/q'] },
    { dir: 'packages/q', name: 'q', deps: [] },
    { dir: 'packages/r', name: 'r', deps: ['packages/q'] },
  ])
  const tasks = await plan()
  expect(tasks.get('p#build')!.node.deps).toEqual(['q#build'])
  expect(tasks.get('r#build')!.node.deps).toEqual(['q#build'])
})

it("its manifest is its tasks' input, and an edit to it re-keys them", async () => {
  const before = await plan()
  expect(before.get('p#build')!.node.config.inputs?.files).toEqual(['src/**', 'package.yaml'])
  expect(before.get('r#build')!.node.config.inputs?.files).toEqual(['src/**', 'package.json5'])
  // CONTROL: a package.json member keeps package.json.
  expect(before.get('q#build')!.node.config.inputs?.files).toEqual(['src/**', 'package.json'])
  await writeFile(path.join(root, 'packages/p/package.yaml'), `${MANIFESTS.p[1]}description: x\n`)
  const after = await plan()
  expect(after.get('p#build')!.hash).not.toBe(before.get('p#build')!.hash)
  expect(after.get('r#build')!.hash).toBe(before.get('r#build')!.hash)
})

it('a package.yaml member the lockfile lacks refuses until the install', async () => {
  await mkdir(path.join(root, 'packages/s'), { recursive: true })
  await writeFile(path.join(root, 'packages/s/package.yaml'), 'name: s\n')
  await expect(discover()).rejects.toThrow(
    'pnpm-lock.yaml is out of date: it does not list the workspace packages/s — run `pnpm install`',
  )
})

it('a dependency a package.yaml declares that the lockfile lacks refuses until the install', async () => {
  await writeFile(path.join(root, 'packages/p/package.yaml'), `${MANIFESTS.p[1]}  r: workspace:*\n`)
  await expect(discover()).rejects.toThrow(
    "pnpm-lock.yaml is out of date: it does not list packages/p's dependency on r — run `pnpm install`",
  )
})

it('a manifest that does not parse refuses, naming it', async () => {
  await writeFile(path.join(root, 'packages/p/package.yaml'), 'name: [p\n')
  await expect(discover()).rejects.toThrow('packages/p/package.yaml: not YAML (')
  await writeFile(path.join(root, 'packages/p/package.yaml'), '- p\n')
  await expect(discover()).rejects.toThrow('packages/p/package.yaml: not a YAML mapping')
  await writeFile(path.join(root, 'packages/p/package.yaml'), MANIFESTS.p[1])
  await writeFile(path.join(root, 'packages/r/package.json5'), '{name: ')
  await expect(discover()).rejects.toThrow('packages/r/package.json5: not JSON5 (')
})

it('two manifests in one directory refuse, naming both', async () => {
  // pnpm 10.28 then lists the package by its package.json and installs
  // the package.yaml's dependencies: which one keys it is a guess.
  await writeFile(path.join(root, 'packages/p/package.json'), '{"name":"p"}')
  await expect(discover()).rejects.toThrow(
    'packages/p: holds package.json and package.yaml, two manifests — keep one',
  )
})
