// A workspace package a registry package depends on: a → is-odd@3.0.1 →
// is-number, which the install resolved to the workspace packages/b
// (named is-number, 6.0.0). Read from each importer's own dependencies
// alone, a had no edge to b, so a#build folded no b#build key: an edit to
// b's source replayed a's old output, and `--affected` left a out. Each
// lockfile is the one that manager wrote (npm 10: b satisfies ^6.0.0, so
// `node_modules/is-number` links it; Yarn 4: transparent workspaces; pnpm
// 9: `overrides: { is-number: workspace:* }`; bun 1.4: the workspace at
// `is-number`). c depends on nothing but, under pnpm, b directly.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { DiscoverContext, Logger, ProjectMeta, VxPlugin } from '@vzn/vx'
import { planRun } from '../../vx/tests/helpers/orchestrator.js'
import { bun, npm, pnpm, yarn } from '../src/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const IS_ODD =
  'sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA=='

const NPM = (bDeps: Record<string, string> = {}): string =>
  JSON.stringify({
    name: 'root',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'root', workspaces: ['packages/*'] },
      'node_modules/a': { resolved: 'packages/a', link: true },
      'node_modules/c': { resolved: 'packages/c', link: true },
      'node_modules/is-number': { resolved: 'packages/b', link: true },
      'node_modules/is-odd': {
        version: '3.0.1',
        resolved: 'https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz',
        integrity: IS_ODD,
        dependencies: { 'is-number': '^6.0.0' },
      },
      'packages/a': { version: '1.0.0', dependencies: { 'is-odd': '3.0.1' } },
      'packages/b': { name: 'is-number', version: '6.0.0', dependencies: bDeps },
      'packages/c': { version: '1.0.0' },
    },
  })

const YARN = `__metadata:
  version: 8
  cacheKey: 10c0

"a@workspace:packages/a":
  version: 0.0.0-use.local
  resolution: "a@workspace:packages/a"
  dependencies:
    is-odd: "npm:3.0.1"
  languageName: unknown
  linkType: soft

"c@workspace:packages/c":
  version: 0.0.0-use.local
  resolution: "c@workspace:packages/c"
  languageName: unknown
  linkType: soft

"is-number@npm:^6.0.0, is-number@workspace:packages/b":
  version: 0.0.0-use.local
  resolution: "is-number@workspace:packages/b"
  languageName: unknown
  linkType: soft

"is-odd@npm:3.0.1":
  version: 3.0.1
  resolution: "is-odd@npm:3.0.1"
  dependencies:
    is-number: "npm:^6.0.0"
  checksum: 10c0/89ee2e
  languageName: node
  linkType: hard

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  languageName: unknown
  linkType: soft
`

const PNPM = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:
  is-number: workspace:*

importers:

  .: {}

  packages/a:
    dependencies:
      is-odd:
        specifier: 3.0.1
        version: 3.0.1

  packages/b: {}

  packages/c:
    dependencies:
      is-number:
        specifier: workspace:*
        version: link:../b

packages:

  is-odd@3.0.1:
    resolution: {integrity: ${IS_ODD}}
    engines: {node: '>=4'}

snapshots:

  is-odd@3.0.1:
    dependencies:
      is-number: link:packages/b
`

const BUN = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "root" },
    "packages/a": { "name": "a", "version": "1.0.0", "dependencies": { "is-odd": "3.0.1" } },
    "packages/b": { "name": "is-number", "version": "6.0.0" },
    "packages/c": { "name": "c", "version": "1.0.0" },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],
    "c": ["c@workspace:packages/c"],
    "is-number": ["is-number@workspace:packages/b"],
    "is-odd": ["is-odd@3.0.1", "", { "dependencies": { "is-number": "^6.0.0" } }, "${IS_ODD}"],
  }
}
`

const CASES = [
  { name: 'npm', file: 'package-lock.json', text: NPM(), make: npm },
  { name: 'yarn', file: 'yarn.lock', text: YARN, make: yarn },
  { name: 'pnpm', file: 'pnpm-lock.yaml', text: PNPM, make: pnpm },
  { name: 'bun', file: 'bun.lock', text: BUN, make: bun },
] as const

const MANIFESTS: Record<string, Record<string, unknown>> = {
  '.': { name: 'root', private: true, workspaces: ['packages/*'] },
  'packages/a': { name: 'a', version: '1.0.0', dependencies: { 'is-odd': '3.0.1' } },
  'packages/b': { name: 'is-number', version: '6.0.0', main: 'src/index.js' },
  'packages/c': { name: 'c', version: '1.0.0' },
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-transitive-'))
  for (const [dir, pkg] of Object.entries(MANIFESTS)) {
    await mkdir(path.join(root, dir, 'src'), { recursive: true })
    await writeFile(path.join(root, dir, 'package.json'), JSON.stringify(pkg))
  }
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function discover(plugin: VxPlugin) {
  const projects: ProjectMeta[] = Object.keys(MANIFESTS).map((dir) => ({
    name: dir === '.' ? '//' : dir,
    dir: path.join(root, dir),
    configPath: null,
  }))
  const ctx: DiscoverContext = {
    workspaceRoot: root,
    cacheDir: path.join(root, '.vx', 'cache'),
    projects,
    warn: () => {},
    worktreeChanges: async () => null,
  }
  const rel = (dir: string) => path.relative(root, dir).split(path.sep).join('/') || '.'
  return (await plugin.discover!(ctx)).map((e) => ({
    dir: rel(e.dir),
    deps: (e.deps ?? []).map(rel),
    reach: (e.reach ?? []).map(rel),
  }))
}

describe('a workspace package reached through a registry package', () => {
  for (const c of CASES) {
    it(`${c.name}(): is an order edge of the project reaching it`, async () => {
      await writeFile(path.join(root, c.file), c.text)
      const got = await discover(c.make())
      expect(got.find((e) => e.dir === 'packages/a')).toEqual({
        dir: 'packages/a',
        deps: ['packages/b'],
        reach: [],
      })
      // CONTROL: b reaches no workspace, and the root none.
      expect(got.find((e) => e.dir === 'packages/b')).toEqual({
        dir: 'packages/b',
        deps: [],
        reach: [],
      })
    })
  }

  it('npm(): one that would close a cycle through the order edges is reach only', async () => {
    // b now depends on a: a → is-odd → b → a. b's own edge orders; a's,
    // which only a registry package installs, is reach.
    await writeFile(path.join(root, 'package-lock.json'), NPM({ a: '*' }))
    await writeFile(
      path.join(root, 'packages/b/package.json'),
      JSON.stringify({ ...MANIFESTS['packages/b'], dependencies: { a: '*' } }),
    )
    const got = await discover(npm())
    expect(got.find((e) => e.dir === 'packages/a')).toEqual({
      dir: 'packages/a',
      deps: [],
      reach: ['packages/b'],
    })
    expect(got.find((e) => e.dir === 'packages/b')).toEqual({
      dir: 'packages/b',
      deps: ['packages/a'],
      reach: [],
    })
  })
})

describe('vx run: an edit to that workspace package', () => {
  for (const c of CASES) {
    it(`${c.name}(): re-keys the project that loads it through the registry package`, async () => {
      await writeFile(path.join(root, c.file), c.text)
      for (const dir of ['packages/a', 'packages/b', 'packages/c']) {
        await writeFile(path.join(root, dir, 'src', 'index.js'), `// ${dir}\n`)
        await writeFile(
          path.join(root, dir, 'vx.config.mjs'),
          `export default { tasks: { build: { dependsOn: ['^build'], exec: { command: 'echo built' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true } } }\n`,
        )
      }
      await Bun.write(
        path.join(root, '.vx/workspace.mjs'),
        localWorkspaceSource(
          [`${c.name}()`],
          `import { ${c.name} } from ${JSON.stringify(PLUGIN_INDEX)}\n`,
        ),
      )
      Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
      const hashes = async () =>
        Object.fromEntries(
          (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks.map((t) => [
            t.node.id,
            t.hash,
          ]),
        )
      const before = await hashes()
      await writeFile(path.join(root, 'packages/b/src/index.js'), '// edited\n')
      const after = await hashes()
      const moved = Object.keys(after).filter((id) => after[id] !== before[id])
      // c loads b only under pnpm, which links it directly.
      expect(moved.sort()).toEqual(
        c.name === 'pnpm'
          ? ['a#build', 'c#build', 'is-number#build']
          : ['a#build', 'is-number#build'],
      )
    })
  }
})

function silent(): Logger {
  return {
    runStart() {},
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
    status() {},
  } as never
}
