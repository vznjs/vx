// A `file:` directory dependency: pnpm and bun copy the directory into
// node_modules at install, npm links it, and their lockfiles record only
// its path. An edit inside it changed what a task reads while no key
// moved, so the hit replayed output built from the old copy (Growth,
// file-dir-dep-stale.sh). The lockfile texts are the ones pnpm 10.28,
// bun 1.4 and npm 10.9 wrote for `"dep": "file:../../vendor/dep"` in
// packages/lib.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { type Logger } from '@vzn/vx'
import { planRun } from '../../vx/tests/helpers/orchestrator.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { affectedIds, commitAll, moved } from './helpers/affected.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const BUILD =
  "export default { tasks: { build: { exec: { command: 'echo built' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } } } }\n"

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

const LOCKS = {
  pnpm: {
    file: 'pnpm-lock.yaml',
    text: `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  packages/lib:
    dependencies:
      dep:
        specifier: file:../../vendor/dep
        version: file:vendor/dep

  packages/other: {}

packages:

  dep@file:vendor/dep:
    resolution: {directory: vendor/dep, type: directory}

snapshots:

  dep@file:vendor/dep: {}
`,
  },
  bun: {
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
        "dep": "file:../../vendor/dep",
      },
    },
    "packages/other": {
      "name": "other",
      "version": "1.0.0",
    },
  },
  "packages": {
    "lib": ["lib@workspace:packages/lib"],

    "other": ["other@workspace:packages/other"],

    "lib/dep": ["dep@file:vendor/dep", {}],
  }
}
`,
  },
  // npm links a `file:` directory into node_modules instead of copying it:
  // what a task reads is the directory as it is now.
  npm: {
    file: 'package-lock.json',
    text: `${JSON.stringify(
      {
        name: 'r',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'r', workspaces: ['packages/*'] },
          'node_modules/dep': { resolved: 'vendor/dep', link: true },
          'node_modules/lib': { resolved: 'packages/lib', link: true },
          'node_modules/other': { resolved: 'packages/other', link: true },
          'packages/lib': { version: '1.0.0', dependencies: { dep: 'file:../../vendor/dep' } },
          'packages/other': { version: '1.0.0' },
          'vendor/dep': { version: '1.0.0' },
        },
      },
      null,
      2,
    )}\n`,
  },
  // With `install-links=true` npm copies the directory instead and records
  // it as `resolved: "file:vendor/dep"`, no integrity: the copy is what a
  // task reads, and a fresh install takes the directory as it is now.
  'npm install-links': {
    file: 'package-lock.json',
    text: `${JSON.stringify(
      {
        name: 'r',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'r', workspaces: ['packages/*'] },
          'node_modules/dep': { version: '1.0.0', resolved: 'file:vendor/dep' },
          'node_modules/lib': { resolved: 'packages/lib', link: true },
          'node_modules/other': { resolved: 'packages/other', link: true },
          'packages/lib': { version: '1.0.0', dependencies: { dep: 'file:../../vendor/dep' } },
          'packages/other': { version: '1.0.0' },
        },
      },
      null,
      2,
    )}\n`,
  },
  // A `!` glob in the root's workspaces matched every path, so the linked
  // directory read as a workspace: a project, its content in no key.
  'npm !glob': {
    file: 'package-lock.json',
    text: `${JSON.stringify(
      {
        name: 'r',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'r', workspaces: ['packages/*', '!**/test/**'] },
          'node_modules/dep': { resolved: 'vendor/dep', link: true },
          'node_modules/lib': { resolved: 'packages/lib', link: true },
          'node_modules/other': { resolved: 'packages/other', link: true },
          'packages/lib': { version: '1.0.0', dependencies: { dep: 'file:../../vendor/dep' } },
          'packages/other': { version: '1.0.0' },
          'vendor/dep': { version: '1.0.0' },
        },
      },
      null,
      2,
    )}\n`,
  },
  // pnpm links a `link:` directory that is no importer; the lockfile
  // records only its path.
  'pnpm link:': {
    file: 'pnpm-lock.yaml',
    spec: 'link:../../vendor/dep',
    text: `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  packages/lib:
    dependencies:
      dep:
        specifier: link:../../vendor/dep
        version: link:../../vendor/dep

  packages/other: {}
`,
  },
  // An override to a `link:` directory reached only through a package:
  // pnpm writes the link in the snapshot, root-relative, and no importer
  // names it, so its content was never read and an edit moved no key.
  'pnpm link: override': {
    file: 'pnpm-lock.yaml',
    spec: '1.0.0',
    text: `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:
  inner: link:./vendor/dep

importers:

  .: {}

  packages/lib:
    dependencies:
      dep:
        specifier: 1.0.0
        version: 1.0.0

  packages/other: {}

packages:

  dep@1.0.0:
    resolution: {integrity: sha512-dep}

snapshots:

  dep@1.0.0:
    dependencies:
      inner: link:vendor/dep
`,
  },
  // Bun links a `link:` directory and records only its path, root-relative
  // (bun 1.4.4).
  'bun link:': {
    file: 'bun.lock',
    spec: 'link:../../vendor/dep',
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
        "dep": "link:../../vendor/dep",
      },
    },
    "packages/other": {
      "name": "other",
      "version": "1.0.0",
    },
  },
  "packages": {
    "dep": ["dep@link:./vendor/dep", {}],

    "lib": ["lib@workspace:packages/lib"],

    "other": ["other@workspace:packages/other"],
  }
}
`,
  },
  // Yarn berry links a `portal:` directory; its entry records no hash.
  'yarn portal:': {
    file: 'yarn.lock',
    spec: 'portal:../../vendor/dep',
    text: `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 8
  cacheKey: 10c0

"dep@portal:../../vendor/dep::locator=lib%40workspace%3Apackages%2Flib":
  version: 0.0.0-use.local
  resolution: "dep@portal:../../vendor/dep::locator=lib%40workspace%3Apackages%2Flib"
  languageName: node
  linkType: soft

"lib@workspace:packages/lib":
  version: 0.0.0-use.local
  resolution: "lib@workspace:packages/lib"
  dependencies:
    dep: "portal:../../vendor/dep"
  languageName: unknown
  linkType: soft

"other@workspace:packages/other":
  version: 0.0.0-use.local
  resolution: "other@workspace:packages/other"
  languageName: unknown
  linkType: soft

"r@workspace:.":
  version: 0.0.0-use.local
  resolution: "r@workspace:."
  languageName: unknown
  linkType: soft
`,
  },
  // Yarn classic links a `link:` directory and records no hash of it.
  'yarn link:': {
    file: 'yarn.lock',
    spec: 'link:../../vendor/dep',
    reaches: ['lib#build', 'other#build'],
    text: `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"dep@link:vendor/dep":
  version "0.0.0"
  uid ""
`,
  },
  // Yarn classic copies a `file:` directory and records no hash of it. Its
  // digest is the whole lockfile's, so every project moves.
  yarn: {
    reaches: ['lib#build', 'other#build'],
    file: 'yarn.lock',
    text: `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"dep@file:vendor/dep":
  version "1.0.0"
`,
  },
} as const

for (const row of [
  'pnpm',
  'bun',
  'npm',
  'npm install-links',
  'npm !glob',
  'pnpm link:',
  'pnpm link: override',
  'bun link:',
  'yarn portal:',
  'yarn link:',
  'yarn',
] as const) {
  const lock: { file: string; text: string; spec?: string; reaches?: readonly string[] } =
    LOCKS[row]
  const reaches = lock.reaches ?? ['lib#build']
  const pm = row.split(' ')[0]!
  describe(`${row}: a \`file:\` directory dependency`, () => {
    let root: string
    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), `vx-file-dir-${pm}-`))
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
      )
      await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
      await mkdir(path.join(root, 'vendor/dep'), { recursive: true })
      await writeFile(
        path.join(root, 'vendor/dep/package.json'),
        JSON.stringify({ name: 'dep', version: '1.0.0', main: 'index.js' }),
      )
      await writeFile(path.join(root, 'vendor/dep/index.js'), '// dep v1\n')
      for (const name of ['lib', 'other']) {
        const dir = path.join(root, 'packages', name)
        await mkdir(path.join(dir, 'src'), { recursive: true })
        const deps =
          name === 'lib' ? { dependencies: { dep: lock.spec ?? 'file:../../vendor/dep' } } : {}
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
        localWorkspaceSource(
          [`${pm}()`],
          `import { ${pm} } from ${JSON.stringify(PLUGIN_INDEX)}\n`,
        ),
      )
      Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    const hashes = async (): Promise<Record<string, string>> => {
      const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      return Object.fromEntries(plan.tasks.map((t) => [t.node.id, t.hash]))
    }

    it('an edit inside the directory re-keys and selects the projects reaching it', async () => {
      commitAll(root)
      const before = await hashes()
      // CONTROL: nothing changed, nothing moves.
      expect(moved(before, await hashes())).toEqual([])
      await writeFile(path.join(root, 'vendor/dep/index.js'), '// dep v2\n')
      expect(moved(before, await hashes())).toEqual([...reaches])
      expect(affectedIds(root, 'build')).toEqual([...reaches])
    })

    it('a file added to the directory re-keys the project reaching it', async () => {
      const before = await hashes()
      await writeFile(path.join(root, 'vendor/dep/extra.js'), '// new\n')
      expect(moved(before, await hashes())).toEqual([...reaches])
    })

    it('a file the directory links to is its content', async () => {
      await writeFile(path.join(root, 'vendor/shared.js'), '// shared v1\n')
      await symlink('../shared.js', path.join(root, 'vendor/dep/shared.js'))
      const before = await hashes()
      await writeFile(path.join(root, 'vendor/shared.js'), '// shared v2\n')
      expect(moved(before, await hashes())).toEqual([...reaches])
    })

    it("the directory's own node_modules is not its content", async () => {
      const before = await hashes()
      await mkdir(path.join(root, 'vendor/dep/node_modules/x'), { recursive: true })
      await writeFile(path.join(root, 'vendor/dep/node_modules/x/index.js'), '// x\n')
      expect(moved(before, await hashes())).toEqual([])
    })
  })
}
