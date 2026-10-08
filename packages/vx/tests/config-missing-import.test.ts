// A config's bare import that no node_modules provides is refused BEFORE
// the evaluation (item 239). Left to Bun, a workspace with no node_modules
// anywhere above has the package auto-installed from the npm registry
// before "cannot find" — sixteen connections and 150 ms, measured, and a
// sandbox violation on the macOS job — and a config must never download.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
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

  it('a tsconfig paths or baseUrl alias with a target on disk is provided (D-26)', async () => {
    // Bun resolves `paths` and `baseUrl` from the nearest tsconfig.json,
    // `extends` followed, and loads the target from disk; refusing it
    // refused a config Bun evaluates without the network.
    await mkdir(path.join(dir, 'shared', 'lib'), { recursive: true })
    await writeFile(path.join(dir, 'shared', 'tasks.ts'), 'export const x = 1\n')
    await writeFile(path.join(dir, 'shared', 'lib', 'index.ts'), 'export const y = 1\n')
    await writeFile(
      path.join(dir, 'tsconfig.base.json'),
      `{ // JSONC, as tsc reads it
        "compilerOptions": { "baseUrl": ".", "paths": {
          "@s/*": ["gone/*", "shared/*"], "@lib": ["shared/lib"], "@gone/*": ["gone/*"] } } }`,
    )
    const from = path.join(dir, 'packages', 'app')
    await mkdir(from, { recursive: true })
    await writeFile(path.join(from, 'tsconfig.json'), '{ "extends": "../../tsconfig.base" }')
    const src = `
      import a from '@s/tasks'
      import b from '@lib'
      import c from 'shared/tasks'
      import d from '@gone/x'
      import e from '@s/none'
    `
    expect(unprovidedBareImports(src, from, 'ts')).toEqual(['@gone/x', '@s/none'])
  })

  it('CONTROL: only the NEAREST tsconfig maps — one above it is not read (D-26)', async () => {
    await mkdir(path.join(dir, 'shared'), { recursive: true })
    await writeFile(path.join(dir, 'shared', 'tasks.ts'), 'export const x = 1\n')
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      '{ "compilerOptions": { "paths": { "@s/*": ["./shared/*"] } } }',
    )
    const app = path.join(dir, 'app')
    await mkdir(app)
    expect(unprovidedBareImports("import a from '@s/tasks'", app, 'ts')).toEqual([])
    await writeFile(path.join(app, 'tsconfig.json'), '{ "compilerOptions": {} }')
    expect(unprovidedBareImports("import a from '@s/tasks'", app, 'ts')).toEqual(['@s/tasks'])
  })

  it('a package.json subpath import is never listed (D-28)', async () => {
    // Bun resolves `#tasks` through the package's own `imports` field and
    // never reaches the registry for a `#` name (strace: no connect), so
    // refusing it refused a config Bun evaluates.
    const src = `import { cmd } from '#tasks'\nimport x from '#lib/x.ts'\nimport y from 'nope-pkg'\n`
    expect(unprovidedBareImports(src, dir, 'ts')).toEqual(['nope-pkg'])
  })

  it('a self-reference to the enclosing package with exports is never listed (D-29)', async () => {
    // Bun resolves `@acme/self/tasks` through the nearest package.json
    // when it names that package and has `exports`, and never reaches the
    // registry for it (strace: no connect).
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: '@acme/self', exports: { './tasks': './tasks.ts' } }),
    )
    const from = path.join(dir, 'config')
    await mkdir(from)
    const src = `import a from '@acme/self/tasks'\nimport b from '@acme/other'\n`
    expect(unprovidedBareImports(src, from, 'ts')).toEqual(['@acme/other'])
    // Bun resolves it through a manifest with a byte-order mark too.
    await writeFile(
      path.join(dir, 'package.json'),
      '\uFEFF' + JSON.stringify({ name: '@acme/self', exports: { './tasks': './tasks.ts' } }),
    )
    expect(unprovidedBareImports(src, from, 'ts')).toEqual(['@acme/other'])
  })

  it('CONTROL: a self-name without exports, or past a nearer package.json, is listed (D-29)', async () => {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: '@acme/self' }))
    const src = `import a from '@acme/self/tasks'\n`
    expect(unprovidedBareImports(src, dir, 'ts')).toEqual(['@acme/self/tasks'])
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: '@acme/self', exports: { './tasks': './tasks.ts' } }),
    )
    const inner = path.join(dir, 'inner')
    await mkdir(inner)
    await writeFile(path.join(inner, 'package.json'), JSON.stringify({ name: 'inner' }))
    expect(unprovidedBareImports(src, inner, 'ts')).toEqual(['@acme/self/tasks'])
    expect(unprovidedBareImports(src, dir, 'ts')).toEqual([])
  })

  it('an array `extends` is not followed: Bun reads none of it (D-30)', async () => {
    // Bun follows only a string `extends`; letting an alias only an array
    // maps through sent Bun to the registry (strace: 30 connects).
    await mkdir(path.join(dir, 'shared'), { recursive: true })
    await writeFile(path.join(dir, 'shared', 't.ts'), 'export const x = 1\n')
    await writeFile(
      path.join(dir, 'base.json'),
      '{ "compilerOptions": { "paths": { "@a/*": ["./shared/*"] } } }',
    )
    const app = path.join(dir, 'app')
    await mkdir(app)
    await writeFile(path.join(app, 'tsconfig.json'), '{ "extends": ["../base.json"] }')
    expect(unprovidedBareImports("import a from '@a/t'", app, 'ts')).toEqual(['@a/t'])
    await writeFile(path.join(app, 'tsconfig.json'), '{ "extends": "../base.json" }')
    expect(unprovidedBareImports("import a from '@a/t'", app, 'ts')).toEqual([])
  })

  it('a tsconfig alias maps as Bun maps it, key and base alike (D-30)', async () => {
    // Each case below is one Bun resolves (or refuses) that way, probed:
    // a sweep of the D-26 rules found each unheld.
    await mkdir(path.join(dir, 'shared'), { recursive: true })
    await writeFile(path.join(dir, 'shared', 't.ts'), 'export const x = 1\n')
    const app = path.join(dir, 'app')
    await mkdir(app)
    const at = async (tsconfig: string, spec: string): Promise<string[]> => {
      await writeFile(path.join(app, 'tsconfig.json'), tsconfig)
      return unprovidedBareImports(`import a from '${spec}'`, app, 'ts')
    }
    // `paths` targets resolve against `baseUrl` when it is set.
    const based = '{ "compilerOptions": { "baseUrl": "../shared", "paths": { "@c/*": ["./*"] } } }'
    expect(await at(based, '@c/t')).toEqual([])
    // Inherited `paths` resolve against the child's `baseUrl`: Bun misses.
    await writeFile(
      path.join(dir, 'base.json'),
      '{ "compilerOptions": { "paths": { "@a/*": ["./shared/*"] } } }',
    )
    const inherits = '{ "extends": "../base.json", "compilerOptions": { "baseUrl": "../shared" } }'
    expect(await at(inherits, '@a/t')).toEqual(['@a/t'])
    // A key matches by its head AND its tail, never overlapping.
    const keys =
      '{ "compilerOptions": { "paths": { "@s/*": ["../shared/*"], "@t/*-x": ["../shared/*"], "ab*ba": ["../shared/t.ts"] } } }'
    expect(await at(keys, '@s/t')).toEqual([])
    expect(await at(keys, 'xx/t')).toEqual(['xx/t'])
    expect(await at(keys, '@t/t-y')).toEqual(['@t/t-y'])
    expect(await at(keys, 'aba')).toEqual(['aba'])
    expect(await at(keys, 'abba')).toEqual([])
    // A target that is a directory with no index is no file: Bun downloads.
    await mkdir(path.join(dir, 'shared', 'empty'))
    expect(await at(keys, '@s/empty')).toEqual(['@s/empty'])
    // A jsconfig.json stands in when no tsconfig.json sits beside it.
    await rm(path.join(app, 'tsconfig.json'))
    await writeFile(
      path.join(app, 'jsconfig.json'),
      '{ "compilerOptions": { "paths": { "@j/*": ["../shared/*"] } } }',
    )
    expect(unprovidedBareImports("import a from '@j/t'", app, 'ts')).toEqual([])
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

  it('a dynamic import() of a missing package is reported: a config can download through it too', () => {
    const src = `export default async () => (await import('nope-dyn')).default`
    expect(unprovidedBareImports(src, dir, 'js')).toEqual(['nope-dyn'])
  })

  it('an ABSOLUTE specifier resolves by path, never as a package, beside one that is', () => {
    const src = `import a from '/abs/helper.mjs'\nimport b from 'nope-pkg'`
    expect(unprovidedBareImports(src, dir, 'js')).toEqual(['nope-pkg'])
  })

  it('a RELATIVE specifier resolves by path, never as a package, beside one that is', () => {
    const src = `import a from './helper.mjs'\nimport b from 'nope-pkg'`
    expect(unprovidedBareImports(src, dir, 'js')).toEqual(['nope-pkg'])
  })

  it('is empty for unparseable source even when it names a package: the syntax error is the report', () => {
    // A bare candidate gets it past the textual pass; the scan then throws.
    expect(unprovidedBareImports(`import x from 'nope-pkg'\nimport { from`, dir, 'ts')).toEqual([])
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
    await rm(path.dirname(root), { recursive: true, force: true })
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

  // A level's configs are read together (D-23), so a low ulimit refuses
  // the read, not the file. Read as "no edges", it answered a clean tree:
  // the project importing the changed preset never ran (D-63).
  const refusingConfigRead = (code: string) => {
    const file = Bun.file
    const config = path.join(real, 'app', 'vx.config.ts')
    return spyOn(Bun, 'file').mockImplementation(((p: string, o?: BlobPropertyBag) => {
      const f = file(p, o)
      if (p !== config) return f
      const err = Object.assign(new Error(`${code}: refused, open '${p}'`), { code })
      return Object.assign(Object.create(f), { text: () => Promise.reject(err) })
    }) as typeof Bun.file)
  }

  it('a config read refused for want of descriptors fails the pass, not the edge', async () => {
    const spy = refusingConfigRead('EMFILE')
    try {
      expect(
        await owners(['preset.ts']).then(
          () => 'resolved',
          (e: NodeJS.ErrnoException) => e.code,
        ),
      ).toBe('EMFILE')
    } finally {
      spy.mockRestore()
    }
  })

  it('CONTROL: a config that cannot be read for itself contributes no edges', async () => {
    const spy = refusingConfigRead('EACCES')
    try {
      expect(await owners(['preset.ts'])).toEqual([])
    } finally {
      spy.mockRestore()
    }
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

  it('a REPEAT load is refused too, before the worker evaluates it (D-18)', async () => {
    // A path loaded before re-evaluates in the config worker (`vx watch`,
    // `vx lock`), which is a second door to Bun's auto-install.
    const file = path.join(dir, 'vx.config.mjs')
    const refusal = async (): Promise<string | undefined> => {
      try {
        await loadProjectConfig(file)
      } catch (e) {
        return (e as Error).message
      }
      return undefined
    }
    const want = "cannot find 'nope-pkg' — no node_modules above the config provides it"
    expect(await refusal()).toContain(want)
    expect(await refusal()).toContain(want)
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
