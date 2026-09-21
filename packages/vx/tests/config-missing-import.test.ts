// A config's bare import that no node_modules provides is refused BEFORE
// the evaluation (item 239). Left to Bun, a workspace with no node_modules
// anywhere above has the package auto-installed from the npm registry
// before "cannot find" — sixteen connections and 150 ms, measured, and a
// sandbox violation on the macOS job — and a config must never download.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { configImportOwners, unprovidedBareImports } from '../src/workspace/config-imports.js'
import { loadProjectConfig } from '../src/workspace/project-loader.js'

describe('unprovidedBareImports', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-bare-imports-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lists the bare specifiers nothing above provides, once each, and nothing else', async () => {
    await mkdir(path.join(dir, 'node_modules', '@acme', 'preset'), { recursive: true })
    await mkdir(path.join(dir, 'node_modules', 'plain'), { recursive: true })
    const src = `
      import { a } from '@acme/preset'
      import sub from '@acme/preset/deep'
      import p from 'plain'
      import q from 'plain/sub/path'
      import fs from 'node:fs'
      import os from 'os'
      import { Database } from 'bun:sqlite'
      import { defineProject } from '@vzn/vx'
      import x from 'nope-pkg'
      import y from '@nope/scoped'
      import z from 'nope-pkg'
      import rel from './preset.js'
      import type { T } from 'types-only-pkg'
    `
    // Found from a nested directory too: the walk climbs.
    const from = path.join(dir, 'packages', 'app')
    await mkdir(from, { recursive: true })
    expect(unprovidedBareImports(src, from, 'ts')).toEqual(['nope-pkg', '@nope/scoped'])
  })

  it('a missing package in a scope that EXISTS is still reported', async () => {
    // The row above spells `@acme/preset` and provides it, so it cannot
    // tell a lookup of the PACKAGE from a lookup of its SCOPE: wherever
    // any `@acme/*` is installed, `node_modules/@acme` exists too and
    // both answer "provided". This is the case that separates them, and
    // it is the one that matters — `@acme/missing` beside an installed
    // `@acme/present` is exactly what a typo or a half-finished install
    // looks like, and reading the scope as the package hands it to Bun
    // to fetch from the registry, which is the download this guard
    // exists to prevent.
    await mkdir(path.join(dir, 'node_modules', '@acme', 'present'), { recursive: true })
    const src = `
      import a from '@acme/present'
      import b from '@acme/missing'
    `
    expect(unprovidedBareImports(src, dir, 'ts')).toEqual(['@acme/missing'])
  })

  it('a require() bare import reaches the scan — the fast path agrees with it', async () => {
    // `hasBareCandidate` is a textual pre-filter and a source it rejects
    // is never scanned at all, so its regex must not be narrower than
    // what the scan would find. It spells three forms — `from`, `import`
    // and `require(` — and every fixture above uses the first two, so
    // dropping `require` from the regex costs nothing any row can see
    // while making a CommonJS-style config's missing import invisible:
    // the guard returns [] and Bun downloads it.
    const src = `const { preset } = require('nope-pkg')\nmodule.exports = { tasks: {} }\n`
    expect(unprovidedBareImports(src, dir, 'js')).toEqual(['nope-pkg'])
  })

  it('a `@vzn/vx/...` SUBPATH is exempt, like the bare name', () => {
    // Both spellings are served by the core alias inside the compiled
    // binary, where there is no node_modules to find them in. The rows
    // above import `@vzn/vx` only, so the subpath arm of that exemption
    // had no witness and its loss would refuse a config that imports,
    // say, `@vzn/vx/config` — on the compiled binary, always.
    const src = `
      import { defineProject } from '@vzn/vx'
      import { helper } from '@vzn/vx/config'
    `
    expect(unprovidedBareImports(src, dir, 'ts')).toEqual([])
  })

  it('is empty for unparseable source: the evaluation names the syntax error', () => {
    expect(unprovidedBareImports('import { from', dir, 'ts')).toEqual([])
  })
})

describe('configImportOwners under a NON-CANONICAL workspace root', () => {
  // Two docblocks in this file warn that `Bun.resolveSync` hands back
  // REALPATH'd targets, so a raw root "silently fails every containment
  // check and the scan reports no imports — indistinguishable from a
  // clean tree", and that on darwin a workspace under `os.tmpdir()` lives
  // at `/var/folders/…` while its realpath is `/private/var/folders/…`.
  // Both hazards were documented and neither was tested: on Linux a temp
  // dir IS canonical, so every fixture normalises the difference away and
  // all three `realpath` calls can be deleted without a single row
  // moving.
  //
  // A root reached through a SYMLINK reproduces the darwin shape here, on
  // any platform, which is what makes these rows possible at all.
  let real: string
  let root: string

  beforeEach(async () => {
    real = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-cio-real-')))
    root = path.join(await mkdtemp(path.join(os.tmpdir(), 'vx-cio-link-')), 'ws')
    await symlink(real, root)
    await mkdir(path.join(root, 'app'), { recursive: true })
    await writeFile(path.join(root, 'preset.ts'), 'export const p = 1\n')
    await writeFile(
      path.join(root, 'app', 'vx.config.ts'),
      "import { p } from '../preset.js'\nexport default { tasks: {} , p }\n",
    )
  })
  afterEach(async () => {
    await rm(real, { recursive: true, force: true })
  })

  const owners = async (changed: string[]): Promise<string[]> =>
    [
      ...(await configImportOwners({
        workspaceRoot: root,
        projects: [
          {
            name: 'app',
            dir: path.join(root, 'app'),
            packageJson: { name: 'app' },
            configPath: path.join(root, 'app', 'vx.config.ts'),
          },
        ] as never,
        changed,
        skip: new Set<string>(),
      })),
    ].sort()

  it('a changed preset still selects the project that imports it', async () => {
    // The whole point of the pass. Under a raw root the containment check
    // rejects every realpath'd target, no edge is recorded, and the
    // answer is the empty set — a clean tree, as far as `--affected` can
    // tell, so the project that reads the changed preset never runs.
    expect(await owners(['preset.ts'])).toEqual(['app'])
  })

  it('CONTROL: an unrelated change selects nothing', async () => {
    // Without this the row above would pass just as well on a pass that
    // selected every project unconditionally.
    await writeFile(path.join(root, 'other.ts'), 'export const o = 1\n')
    expect(await owners(['other.ts'])).toEqual([])
  })

  it('a TS config is scanned with the TS loader, so its edges survive its type syntax', async () => {
    // The loader is chosen from the extension, and every fixture's
    // `.ts` config happens to be valid JavaScript too — so the choice
    // never mattered to any row. It matters to real configs: scanning
    // TS-only syntax with the js loader THROWS, `scanLocalImports`
    // catches that and returns no edges, and a config that imports a
    // changed preset then contributes nothing at all. `--affected`
    // reports a clean tree and the task that reads the edited preset
    // never runs — the silent wrong answer this whole channel exists to
    // prevent, reachable by nothing more exotic than a type annotation.
    await writeFile(
      path.join(root, 'app', 'vx.config.ts'),
      "import { p } from '../preset.js'\nconst v: number = p\nexport default { tasks: {}, v }\n",
    )
    expect(await owners(['preset.ts'])).toEqual(['app'])
  })

  it('a config reaching into ANOTHER project records the edge and STOPS there', async () => {
    // The header's second rule, and the one it says "makes the walk
    // affordable at all": a config importing `../core/src/index.ts`
    // records that edge and descends no further, because following it
    // would drag substantially all of core's `src/` into the closure and
    // the containment channel already selects the project that owns it.
    //
    // Two things have to be true for that rule to hold, and neither had a
    // witness: the descend guard itself, and the REALPATH'd directory
    // index it asks — `Bun.resolveSync` returns realpath'd targets, so an
    // index built from raw dirs matches nothing, every file looks unowned
    // and the walk descends through all of them.
    await mkdir(path.join(root, 'core', 'src'), { recursive: true })
    await writeFile(path.join(root, 'core', 'src', 'deep.ts'), 'export const d = 1\n')
    await writeFile(path.join(root, 'core', 'src', 'index.ts'), "export { d } from './deep.js'\n")
    await writeFile(
      path.join(root, 'app', 'vx.config.ts'),
      "import { d } from '../core/src/index.js'\nexport default { tasks: {}, d }\n",
    )
    const projects = [
      {
        name: 'app',
        dir: path.join(root, 'app'),
        packageJson: { name: 'app' },
        configPath: path.join(root, 'app', 'vx.config.ts'),
      },
      {
        name: 'core',
        dir: path.join(root, 'core'),
        packageJson: { name: 'core' },
        configPath: null,
      },
    ] as never
    const ownersOf = async (changed: string[]): Promise<string[]> =>
      [
        ...(await configImportOwners({
          workspaceRoot: root,
          projects,
          changed,
          skip: new Set<string>(),
        })),
      ].sort()

    // The edge itself IS recorded: the file app's config names is a
    // dependency of app.
    expect(await ownersOf(['core/src/index.ts'])).toEqual(['app'])
    // …and the walk stops there. `deep.ts` is core's, reached only by
    // following an owned file's own imports, and containment already
    // selects core for it.
    expect(await ownersOf(['core/src/deep.ts'])).toEqual([])
  })

  it('the config itself changing selects its project', async () => {
    // The `roots` map is keyed by the config's realpath, so this is the
    // arm that fails when only THAT normalisation is dropped: the BFS
    // records the edge correctly and the changed file still matches no
    // root.
    expect(await owners(['app/vx.config.ts'])).toEqual(['app'])
  })
})

describe('a config importing what no node_modules provides', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-missing-import-'))
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      "import { preset } from 'nope-pkg'\nexport default { tasks: { build: { exec: { command: 'true' }, ...preset } } }\n",
    )
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('an .mts config is refused too — the loader is chosen for every TS extension', async () => {
    // The refusal reads the source with a loader chosen from the
    // extension, and `vx.config.mts` is a DISCOVERED config name
    // (workspace.ts's CONFIG_FILENAMES lists .ts, .mts, .js, .mjs). Every
    // fixture spells `.mjs` or `.ts`, so the `[cm]?` in that pattern had
    // no witness — and losing it does not merely mislabel the file, it
    // turns the guard OFF: scanning TS syntax with the js loader throws,
    // `unprovidedBareImports` catches that and returns nothing missing,
    // and the config is handed to Bun, which auto-installs the package
    // from the registry. The download this guard exists to prevent,
    // reachable by renaming a config.
    //
    // 539 found the same "loader from the extension" rule unheld in
    // `configImportOwners`; this is its second copy, one file over.
    const mts = path.join(dir, 'vx.config.mts')
    await writeFile(
      mts,
      "import { preset } from 'nope-pkg'\nconst v: number = 1\nexport default { tasks: { build: { exec: { command: 'true' }, ...preset } }, v }\n",
    )
    let err: Error | undefined
    try {
      await loadProjectConfig(mts)
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toContain(
      "cannot find 'nope-pkg' — no node_modules above the config provides it",
    )
  })

  it('is refused before the evaluation, naming the install', async () => {
    // No node_modules anywhere above (the temp dir): the shape Bun would
    // auto-install. The refusal is vx's own — its suffix is the proof it
    // came before the import, where Bun's says only "cannot find".
    let err: Error | undefined
    try {
      await loadProjectConfig(path.join(dir, 'vx.config.mjs'))
    } catch (e) {
      err = e as Error
    }
    expect(err?.message).toContain(
      "cannot find 'nope-pkg' — no node_modules above the config provides it",
    )
    expect(err?.message).toContain('install the workspace')
  })

  it('CONTROL: a provided package evaluates', async () => {
    const pkg = path.join(dir, 'node_modules', 'nope-pkg')
    await mkdir(pkg, { recursive: true })
    await writeFile(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'nope-pkg', main: 'index.js' }),
    )
    await writeFile(
      path.join(pkg, 'index.js'),
      "export const preset = { description: 'from the package' }\n",
    )
    const config = await loadProjectConfig(path.join(dir, 'vx.config.mjs'))
    expect(config.tasks?.['build']?.description).toBe('from the package')
  })
})
