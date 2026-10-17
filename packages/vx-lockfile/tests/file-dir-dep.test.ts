// A `file:` directory dependency: pnpm and bun copy the directory into
// node_modules at install, npm links it, and their lockfiles record only
// its path. An edit inside it changed what a task reads while no key
// moved, so the hit replayed output built from the old copy (Growth,
// file-dir-dep-stale.sh). The lockfile texts are the ones pnpm 10.28,
// bun 1.4 and npm 10.9 wrote for `"dep": "file:../../vendor/dep"` in
// packages/lib.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
} as const

for (const pm of ['pnpm', 'bun', 'npm'] as const) {
  describe(`${pm}(): a \`file:\` directory dependency`, () => {
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
        await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
        await writeFile(path.join(dir, 'src', 'index.js'), `// ${name}\n`)
        await writeFile(path.join(dir, 'vx.config.mjs'), BUILD)
      }
      await writeFile(path.join(root, LOCKS[pm].file), LOCKS[pm].text)
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

    it('an edit inside the directory re-keys and selects only the project reaching it', async () => {
      commitAll(root)
      const before = await hashes()
      // CONTROL: nothing changed, nothing moves.
      expect(moved(before, await hashes())).toEqual([])
      await writeFile(path.join(root, 'vendor/dep/index.js'), '// dep v2\n')
      expect(moved(before, await hashes())).toEqual(['lib#build'])
      expect(affectedIds(root, 'build')).toEqual(['lib#build'])
    })

    it('a file added to the directory re-keys the project reaching it', async () => {
      const before = await hashes()
      await writeFile(path.join(root, 'vendor/dep/extra.js'), '// new\n')
      expect(moved(before, await hashes())).toEqual(['lib#build'])
    })

    it("the directory's own node_modules is not its content", async () => {
      const before = await hashes()
      await mkdir(path.join(root, 'vendor/dep/node_modules/x'), { recursive: true })
      await writeFile(path.join(root, 'vendor/dep/node_modules/x/index.js'), '// x\n')
      expect(moved(before, await hashes())).toEqual([])
    })
  })
}
