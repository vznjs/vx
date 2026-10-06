// Compile the standalone binary for one target, as every release and
// check builds it:
//
//   bun scripts/compile.ts <target> <outfile>     (target: linux-x64, …)
//
// The CLI's `bun build --compile` flags, plus the plugin packages in
// baked-plugins.ts compiled in: `src/cli/baked.ts`, empty in source, is
// replaced by a table of their entries, and each one's
// `definePlugin(import.meta, …)` reads the origin `registerBakedPlugins`
// sets, because a bundled module's `import.meta.dir` is the bundle's
// (`/$bunfs/root`), where no package.json names it.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { BAKED_PLUGINS } from './baked-plugins.ts'

const CORE = path.resolve(import.meta.dir, '..')
const BAKED_TABLE = path.join(CORE, 'src', 'cli', 'baked.ts')

interface Baked {
  readonly specifier: string
  readonly dir: string
  readonly entry: string
}

function baked(): Baked[] {
  return BAKED_PLUGINS.map((name) => {
    const dir = path.resolve(CORE, '..', name)
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      name: string
      main: string
    }
    return { specifier: pkg.name, dir, entry: path.join(dir, pkg.main) }
  })
}

const ORIGIN = 'definePlugin(import.meta,'

/** `source` with its `definePlugin(import.meta, …)` reading `specifier`'s baked origin. */
function rewriteOrigin(source: string, specifier: string, file: string): string {
  const uses = source.split('import.meta').length - 1
  const origins = source.split(ORIGIN).length - 1
  if (uses !== origins) {
    throw new Error(
      `${file}: import.meta outside definePlugin(import.meta, …) — a baked plugin has no files beside it`,
    )
  }
  return source.replaceAll(
    ORIGIN,
    `definePlugin(globalThis[Symbol.for('vx.baked-origin')].get(${JSON.stringify(specifier)}),`,
  )
}

export async function compile(target: string, outfile: string): Promise<void> {
  const plugins = baked()
  const table =
    'export const BAKED_PLUGINS = {\n' +
    plugins
      .map((p) => `  ${JSON.stringify(p.specifier)}: () => import(${JSON.stringify(p.entry)}),\n`)
      .join('') +
    '}\n'
  const result = await Bun.build({
    entrypoints: [path.join(CORE, 'src', 'bin.ts')],
    compile: {
      target: `bun-${target}` as Bun.Build.CompileTarget,
      outfile,
      autoloadDotenv: false,
      autoloadPackageJson: true,
    },
    minify: true,
    bytecode: true,
    plugins: [
      {
        name: 'vx-bake',
        setup(build) {
          build.onLoad({ filter: /\.ts$/ }, async (args) => {
            if (args.path === BAKED_TABLE) return { contents: table, loader: 'ts' }
            const owner = plugins.find((p) => args.path.startsWith(p.dir + path.sep))
            if (owner === undefined) return undefined
            const source = await Bun.file(args.path).text()
            return { contents: rewriteOrigin(source, owner.specifier, args.path), loader: 'ts' }
          })
        },
      },
    ],
  })
  if (!result.success) {
    throw new AggregateError(result.logs, `compile ${target} failed`)
  }
}

if (import.meta.main) {
  const [target, outfile] = process.argv.slice(2)
  if (target === undefined || outfile === undefined) {
    console.error('usage: bun scripts/compile.ts <target> <outfile>')
    process.exit(2)
  }
  await compile(target, path.resolve(outfile))
}
