// Every run evaluates `.vx/workspace.ts`, and with it every plugin package
// it imports: Bun parses and compiles that TypeScript on each run, and a
// plugin's functions compile again on their first call, while core itself
// runs from the binary's bytecode. On a solid-sized workspace that was
// ~4 ms of a ~60 ms warm run (the `discover` stage alone 9 → 5 ms,
// 2026-10-22). So the config's module graph is bundled once into CommonJS
// with Bun's bytecode under `.vx/cache/compiled/`, and a later run whose
// every input still has the bytes it was built from requires that instead.
//
// The bundle is built from the bytes it records, file by file, and is used
// only while each recorded file still hashes the same and each import still
// resolves to the file it did (a relative one too: `./preset` finds a new
// `preset.ts` before the bundled `preset.js`); anything else loads the
// source as before and builds again. A graph the bundle could run differently is
// never built: an `import.meta` field beyond its location, a `require` or
// `import()` of a computed specifier (relative to the bundle, not the
// file), top-level await, a CommonJS config, a file this process already
// evaluated (a bundled copy would be a second state; run from source, core
// itself). The bundle goes
// into `.vx/cache` only once a run made it, so a reading verb on a fresh
// workspace writes nothing (item 900). `.vx/cache` is trusted as the rest
// of the cache is: what it holds is restored into the tree too.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeExit, memoParts, refuseForeignCacheDir, xxh3hex } from '../util/index.js'

/** Bumped when what a bundle holds, or how it is checked, changes. */
const COMPILED_VERSION = 3

/** What `import.meta` becomes in a bundled file: an identifier no source spells. */
const META = '__vxImportMeta'
const META_FIELDS = new Set(['dir', 'dirname', 'path', 'filename', 'file', 'url', 'main'])
const META_USE = new RegExp(`\\b${META}\\b(\\.[\\w$]+)?`, 'g')
const COMPUTED_LOAD = /\b(?:require|import)\(\s*(?![\s'"])|\brequire\.resolve\b/
// Bun's build and transpiler inline `process.env.NODE_ENV` by default, and a
// bundle's name folds no env: it froze the building run's value. Defined as
// itself, it is read at run time, as the source reads it.
const LIVE_NODE_ENV = { 'process.env.NODE_ENV': 'process.env.NODE_ENV' }

interface Manifest {
  version: number
  /** The config file by real path; its bytes are in the bundle's name, so it is not read again (principle 9). */
  entry: string
  /** Every file the bundle was built from, by real path, and its bytes' hash. */
  inputs: Record<string, string>
  /** Each import: the importing file's directory, the specifier, the real path it resolved to. */
  imports: [string, string, string][]
  /** The graph cannot be bundled faithfully: load the source while the inputs stay as they are. */
  skip?: true
}

function compiledDir(root: string): string {
  return path.join(root, '.vx', 'cache', 'compiled')
}

/** A bundle's name: the config by path and bytes; its imports are checked by the manifest. */
const NAME_PARTS = memoParts<{ configPath: string; bytes: Uint8Array }>({
  configPath: (configPath) => configPath,
  bytes: (bytes) => xxh3hex(bytes),
})

function nameOf(configPath: string, bytes: Uint8Array): string {
  return `workspace-${NAME_PARTS.token(`${COMPILED_VERSION}\0${Bun.revision}`, { configPath, bytes })!}`
}

function fresh(manifest: Manifest, configPath: string): boolean {
  // Built through a link: retargeted at a file of the same bytes, the config's
  // relative imports are other files. A config reached by its real path pays
  // no realpath for this.
  if (manifest.entry !== configPath) {
    try {
      if (realpathSync(configPath) !== manifest.entry) return false
    } catch {
      return false
    }
  }
  for (const [file, hash] of Object.entries(manifest.inputs)) {
    if (file === manifest.entry) continue
    let bytes: Uint8Array
    try {
      bytes = readFileSync(file)
    } catch {
      return false
    }
    if (xxh3hex(bytes) !== hash) return false
  }
  for (const [from, spec, to] of manifest.imports) {
    try {
      if (realpathSync(Bun.resolveSync(spec, from)) !== to) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * The workspace config's module namespace from its bundle: `undefined` when
 * there is none for these bytes or an input moved (`build` then makes one),
 * `null` when the graph is one no bundle runs faithfully.
 */
export function loadCompiled(
  root: string,
  configPath: string,
  bytes: Uint8Array,
): { default?: unknown } | null | undefined {
  // A repeat load in this process (the run after the CLI's selection pass,
  // a `vx watch` cycle) of the same bytes: the loader already refused an
  // import edited since the first, so the answer stands (principle 9).
  const seen = answered.get(configPath)
  if (seen !== undefined && Buffer.from(seen.bytes).equals(bytes)) return seen.ns
  const name = nameOf(configPath, bytes)
  const dir = compiledDir(root)
  let manifest: Manifest
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8')) as Manifest
  } catch {
    return undefined
  }
  if (manifest.version !== COMPILED_VERSION || !fresh(manifest, configPath)) return undefined
  const ns =
    manifest.skip === true
      ? null
      : (createRequire(path.join(dir, 'index.js'))(path.join(dir, `${name}.js`)) as {
          default?: unknown
        })
  answered.set(configPath, { bytes, ns })
  return ns
}

/** What `loadCompiled` answered for each config, by the bytes it was asked with. */
const answered = new Map<string, { bytes: Uint8Array; ns: { default?: unknown } | null }>()

/**
 * The files this process has evaluated as modules. One the config imports
 * by path (run from source, core's own `src/index.ts`) is shared with the
 * process, and a bundle would run a second copy of its state.
 */
export function loadedModules(root: string): Set<string> {
  return new Set(Object.keys(createRequire(path.join(root, 'index.js')).cache))
}

/** The loader Bun reads `file` with, or null for a file the bundle must not hold. */
function loaderOf(file: string): 'ts' | 'tsx' | 'js' | 'jsx' | null {
  const ext = path.extname(file)
  if (ext === '.ts' || ext === '.mts') return 'ts'
  if (ext === '.tsx') return 'tsx'
  if (ext === '.js' || ext === '.mjs') return 'js'
  if (ext === '.jsx') return 'jsx'
  return null
}

let builds = 0

/**
 * Bundle the workspace config's graph for the next run, off the run's
 * path: awaited here, the build was ~30 ms of `workspace config` on the
 * run after a cold one, which had no `.vx/cache` yet and so built nothing
 * (solid's restore 100 ms after a cold run against 67 after a restore,
 * 2026-11-11). It starts now when `.vx/cache` is there, overlapping the
 * run, and otherwise once the verb has answered, if the run made it.
 * Either way the process waits for it before exiting (`beforeExit`). A
 * speed-up only: every failure leaves the next run loading the source.
 */
export function buildCompiled(
  root: string,
  configPath: string,
  bytes: Uint8Array,
  /** `loadedModules()` before the config's source load. */
  loaded: ReadonlySet<string>,
  /** What that load evaluated: a repeat load in this process gets it, not a bundle or a second build. */
  ns: { default?: unknown },
): void {
  answered.set(configPath, { bytes, ns })
  const cacheDir = path.dirname(compiledDir(root))
  if (existsSync(cacheDir)) {
    // Before the first write there: the cache's own open, which refuses a
    // `.vx/cache` linked to the home directory, comes after this load.
    refuseForeignCacheDir(cacheDir, root)
    const started = build(root, configPath, bytes, loaded)
    beforeExit(() => started)
    return
  }
  beforeExit(async () => {
    // A reading verb makes no `.vx/cache`, so it still writes nothing (item 900).
    if (!existsSync(cacheDir)) return
    try {
      refuseForeignCacheDir(cacheDir, root)
    } catch {
      return
    }
    await build(root, configPath, bytes, loaded)
  })
}

async function build(
  root: string,
  configPath: string,
  bytes: Uint8Array,
  loaded: ReadonlySet<string>,
): Promise<void> {
  const dir = compiledDir(root)
  const name = nameOf(configPath, bytes)
  const inputs: Record<string, string> = {}
  let faithful = true
  const transpilers = new Map<string, Bun.Transpiler>()
  // Two builds of one process may now overlap (a `vx watch` cycle's edit).
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${++builds}`)
  try {
    const entryFile = realpathSync(configPath)
    mkdirSync(tmp, { recursive: true })
    // Ignored by git under a cache dir elsewhere, where no `.vx/.gitignore` is written.
    try {
      writeFileSync(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' })
    } catch {
      // there already: the user's or an earlier run's
    }
    const built = await Bun.build({
      entrypoints: [configPath],
      target: 'bun',
      format: 'cjs',
      bytecode: true,
      external: ['@vzn/vx'],
      define: LIVE_NODE_ENV,
      outdir: tmp,
      naming: `${name}.js`,
      metafile: true,
      throw: false,
      plugins: [
        {
          name: 'vx-config-bytecode',
          setup(build) {
            build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
              const file = realpathSync(args.path)
              if (loaded.has(file)) {
                faithful = false
                inputs[file] = xxh3hex(await Bun.file(file).bytes())
                return { contents: '', loader: 'js' }
              }
              const loader = loaderOf(file)
              const source = file === entryFile ? bytes : await Bun.file(file).bytes()
              inputs[file] = xxh3hex(source)
              if (loader === null || /\.c[jt]s$/.test(file)) {
                faithful = false
                return { contents: source, loader: loader ?? 'js' }
              }
              const fileDir = path.dirname(file)
              let t = transpilers.get(file)
              if (t === undefined) {
                t = new Bun.Transpiler({
                  loader,
                  define: {
                    ...LIVE_NODE_ENV,
                    'import.meta': META,
                    __dirname: JSON.stringify(fileDir),
                    __filename: JSON.stringify(file),
                  },
                })
                transpilers.set(file, t)
              }
              const js = t.transformSync(new TextDecoder().decode(source))
              for (const m of js.matchAll(META_USE)) {
                if (m[1] !== undefined && !META_FIELDS.has(m[1].slice(1))) faithful = false
              }
              if (COMPUTED_LOAD.test(js)) faithful = false
              const meta = {
                dir: fileDir,
                dirname: fileDir,
                path: file,
                filename: file,
                file: path.basename(file),
                url: Bun.pathToFileURL(file).href,
                main: false,
              }
              return { contents: `const ${META} = ${JSON.stringify(meta)};\n${js}`, loader: 'js' }
            })
          },
        },
      ],
    })
    const out = path.join(tmp, `${name}.js`)
    const bytecode = built.success && Bun.file(`${out}.jsc`).size > 0
    const manifest: Manifest = {
      version: COMPILED_VERSION,
      entry: entryFile,
      inputs,
      imports: importsOf(built.metafile),
      ...(faithful && bytecode ? {} : { skip: true as const }),
    }
    // The metafile names every input; one no onLoad saw (a JSON import) is
    // bytes the manifest does not check.
    for (const [input, entry] of Object.entries(built.metafile?.inputs ?? {})) {
      const file = realpathSync(path.resolve(input))
      if (inputs[file] === undefined) manifest.skip = true
      // A CommonJS config's export is `module.exports`, not a namespace's `default`.
      if (file === entryFile && entry.format === 'cjs') manifest.skip = true
    }
    for (const old of readdirSync(dir)) {
      if (old.startsWith('workspace-')) rmSync(path.join(dir, old), { force: true })
    }
    if (manifest.skip !== true) {
      renameSync(`${out}.jsc`, path.join(dir, `${name}.js.jsc`))
      renameSync(out, path.join(dir, `${name}.js`))
    }
    // Last: a manifest names a bundle already in place.
    await writeFile(path.join(tmp, 'manifest.json'), JSON.stringify(manifest))
    renameSync(path.join(tmp, 'manifest.json'), path.join(dir, `${name}.json`))
  } catch {
    // A read-only cache directory, a full disk, a graph Bun cannot bundle:
    // the next run loads the source, as this one did.
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function importsOf(metafile: Bun.BuildMetafile | undefined): [string, string, string][] {
  const out: [string, string, string][] = []
  for (const [input, entry] of Object.entries(metafile?.inputs ?? {})) {
    const from = path.dirname(realpathSync(path.resolve(input)))
    for (const imp of entry.imports) {
      const spec = imp.original
      if (imp.external === true || spec === undefined) continue
      out.push([from, spec, realpathSync(path.resolve(imp.path))])
    }
  }
  return out
}
