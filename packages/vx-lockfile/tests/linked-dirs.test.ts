// A linked directory the lockfile does not name by a path the key reads:
// pnpm's `excludeLinksFromLockfile` drops a `link:` from the file, yarn
// berry locates a `link:` / `portal:` from a `portal:` or `file:` package
// by that package's locator, and bun records a `bun link` (global) link as
// `link:<name>`. Each was hashed as nothing, so an edit in the linked
// directory replayed the old output. The lockfile texts are the ones pnpm
// 10.28, yarn 4 and bun 1.4 wrote for these manifests.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { type Logger } from '@vzn/vx'
import { planRun } from '../../vx/tests/helpers/orchestrator.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { affectedIds, commitAll, lockAt, moved } from './helpers/affected.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const BUILD =
  "export default { tasks: { build: { exec: { command: 'echo built' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true } } }\n"

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

let base: string
let root: string
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'vx-linked-dirs-'))
  root = path.join(base, 'ws')
  await mkdir(root)
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

async function workspace(
  pm: string,
  lock: { file: string; text: string },
  libDeps: Record<string, string>,
): Promise<void> {
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
  )
  for (const name of ['lib', 'other']) {
    const dir = path.join(root, 'packages', name)
    await mkdir(path.join(dir, 'src'), { recursive: true })
    const deps = name === 'lib' ? { dependencies: libDeps } : {}
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', ...deps }),
    )
    await writeFile(path.join(dir, 'src', 'index.js'), `// ${name}\n`)
    await writeFile(path.join(dir, 'vx.config.mjs'), BUILD)
  }
  await writeFile(path.join(root, lock.file), lock.text)
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([`${pm}()`], `import { ${pm} } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
}

async function pkg(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest))
  await writeFile(path.join(dir, 'index.js'), '// v1\n')
}

const hashes = async (): Promise<Record<string, string>> => {
  const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
  return Object.fromEntries(plan.tasks.map((t) => [t.node.id, t.hash]))
}

describe('pnpm excludeLinksFromLockfile: a link: to a directory no workspace holds', () => {
  const LOCK = {
    file: 'pnpm-lock.yaml',
    text: `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: true

importers:

  .: {}

  packages/lib: {}

  packages/other: {}
`,
  }
  beforeEach(async () => {
    await pkg(path.join(root, 'vendor/dep'), { name: 'dep', version: '1.0.0' })
  })
  const setup = async (deps: Record<string, string>) => {
    await workspace('pnpm', LOCK, deps)
    await writeFile(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\nexcludeLinksFromLockfile: true\n',
    )
  }

  it('an edit inside it re-keys and selects the project linking it', async () => {
    await setup({ dep: 'link:../../vendor/dep' })
    commitAll(root)
    lockAt(root)
    const before = await hashes()
    expect(moved(before, await hashes())).toEqual([])
    await writeFile(path.join(root, 'vendor/dep/index.js'), '// v2\n')
    expect(moved(before, await hashes())).toContain('lib#build')
    expect(affectedIds(root, 'build')).toContain('lib#build')
  })

  it('a link added to the manifest under the same lockfile and lock is read', async () => {
    // pnpm writes the same file once the link is added: a memo or lock of
    // that file's bytes still names the directories it named before.
    await setup({})
    lockAt(root)
    await hashes()
    await writeFile(
      path.join(root, 'packages/lib/package.json'),
      JSON.stringify({
        name: 'lib',
        version: '1.0.0',
        dependencies: { dep: 'link:../../vendor/dep' },
      }),
    )
    const before = await hashes()
    await writeFile(path.join(root, 'vendor/dep/index.js'), '// v2\n')
    expect(moved(before, await hashes())).toContain('lib#build')
  })
})

const LOCATOR = 'lib%40workspace%3Apackages%2Flib'
const berry = (outer: 'portal' | 'file', inner: 'link' | 'portal'): string => {
  const p =
    outer === 'portal'
      ? `p@portal:../../vendor/p::locator=${LOCATOR}`
      : `p@file:../../vendor/p#../../vendor/p::hash=841398&locator=${LOCATOR}`
  const key = outer === 'portal' ? p : `p@file:../../vendor/p::locator=${LOCATOR}`
  const q = `q@${inner}:../q::locator=${encodeURIComponent(p)}`
  return `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 8
  cacheKey: 10c0

"lib@workspace:packages/lib":
  version: 0.0.0-use.local
  resolution: "lib@workspace:packages/lib"
  dependencies:
    p: "${outer}:../../vendor/p"
  languageName: unknown
  linkType: soft

"other@workspace:packages/other":
  version: 0.0.0-use.local
  resolution: "other@workspace:packages/other"
  languageName: unknown
  linkType: soft

"${key}":
  version: ${outer === 'portal' ? '0.0.0-use.local' : '1.0.0'}
  resolution: "${p}"
  dependencies:
    q: "${inner}:../q"
  languageName: node
  linkType: ${outer === 'portal' ? 'soft' : 'hard'}

"${q}":
  version: 0.0.0-use.local
  resolution: "${q}"
  languageName: node
  linkType: soft

"r@workspace:.":
  version: 0.0.0-use.local
  resolution: "r@workspace:."
  languageName: unknown
  linkType: soft
`
}

describe('yarn berry: a link: or portal: located by a portal: or file: package', () => {
  for (const [outer, inner] of [
    ['portal', 'link'],
    ['portal', 'portal'],
    ['file', 'link'],
  ] as const) {
    it(`${outer}: → ${inner}: an edit inside the inner directory re-keys and selects the project`, async () => {
      await pkg(path.join(root, 'vendor/q'), { name: 'q', version: '1.0.0' })
      await pkg(path.join(root, 'vendor/p'), {
        name: 'p',
        version: '1.0.0',
        dependencies: { q: `${inner}:../q` },
      })
      await workspace(
        'yarn',
        { file: 'yarn.lock', text: berry(outer, inner) },
        {
          p: `${outer}:../../vendor/p`,
        },
      )
      await writeFile(path.join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n')
      commitAll(root)
      lockAt(root)
      const before = await hashes()
      await writeFile(path.join(root, 'vendor/q/index.js'), '// v2\n')
      expect(moved(before, await hashes())).toEqual(['lib#build'])
      expect(affectedIds(root, 'build')).toEqual(['lib#build'])
    })
  }
})

describe('bun: a `bun link` (global) link: <name>', () => {
  const LOCK = {
    file: 'bun.lock',
    text: `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "r",
    },
    "packages/lib": {
      "name": "lib",
      "version": "1.0.0",
      "dependencies": {
        "gdep": "link:gdep",
      },
    },
    "packages/other": {
      "name": "other",
      "version": "1.0.0",
    },
  },
  "packages": {
    "gdep": ["gdep@link:gdep", {}],

    "lib": ["lib@workspace:packages/lib"],

    "other": ["other@workspace:packages/other"],
  }
}
`,
  }
  // Bun links the package's source into the global store, and the install
  // links that into node_modules: the isolated linker under the workspace
  // that asks for it, the hoisted one at the root.
  for (const at of ['packages/lib/node_modules', 'node_modules'] as const) {
    it(`an edit in the linked source re-keys the project linking it (${at})`, async () => {
      const source = path.join(base, 'ext/gdep')
      await pkg(source, { name: 'gdep', version: '1.0.0' })
      await mkdir(path.join(base, 'global/node_modules'), { recursive: true })
      await symlink(source, path.join(base, 'global/node_modules/gdep'))
      await workspace('bun', LOCK, { gdep: 'link:gdep' })
      await mkdir(path.join(root, at), { recursive: true })
      await symlink(path.join(base, 'global/node_modules/gdep'), path.join(root, at, 'gdep'))
      lockAt(root)
      const before = await hashes()
      expect(moved(before, await hashes())).toEqual([])
      await writeFile(path.join(source, 'index.js'), '// v2\n')
      expect(moved(before, await hashes())).toEqual(['lib#build'])
    })
  }
})
