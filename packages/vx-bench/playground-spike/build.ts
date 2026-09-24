// W9 spike (item 676): bundle the planner for the browser and report what
// the bundle costs and what it reaches for.
//
//   bun packages/vx-bench/playground-spike/build.ts     → playground-spike/dist/ (gitignored)
//
// `Bun.build({ target: 'browser' })` — the JS form of `bun build
// --target=browser`, needed for the aliasing plugin. Every `node:*` / `bun:*`
// specifier the graph asks for is recorded; the three the plan reads are
// aliased to the VFS-backed shims, and `node:path` is left to Bun's own
// browser polyfill. `Bun` and `process` are rewritten to the shim objects.
// Prints raw and gzipped sizes, the specifiers, any `Bun.` / `process.`
// left in the output, and the per-module byte split (largest first).

import path from 'node:path'
import type { BunPlugin } from 'bun'

const here = import.meta.dir
const outdir = path.join(here, 'dist')
const shim = (f: string): string => path.join(here, 'shim', f)

const ALIASES: Record<string, string> = {
  'node:fs': shim('node-fs.ts'),
  fs: shim('node-fs.ts'),
  'node:fs/promises': shim('node-fs-promises.ts'),
  'fs/promises': shim('node-fs-promises.ts'),
  'bun:sqlite': shim('bun-sqlite.ts'),
}

// Left to Bun's browser polyfill: pure string work, no platform behind it.
const POLYFILLED = new Set(['node:path', 'path'])

const requested = new Map<string, Set<string>>()
const stubbed = new Set<string>()

// A specifier the plan never calls into but some module on the static
// import graph names (the executor, the sandbox runtime, the config
// evaluator). Bun resolves every static and dynamic import before it
// tree-shakes, so each needs a module to link against: one whose export
// NAMES are the real module's, read here at build time. A DATA export
// (`node:module`'s `builtinModules`, read at load by config-imports.ts) is
// inlined with its build-time value; every other export throws when used.
const stubFrom = new Map<string, string>()
const inlined: string[] = []

function asData(v: unknown): string | null {
  if (typeof v === 'function' || v === undefined) return null
  try {
    const json = JSON.stringify(v)
    return json === undefined || json.length > 20_000 ? null : json
  } catch {
    return null
  }
}

async function stubSource(spec: string): Promise<string> {
  const real = (await import(stubFrom.get(spec) ?? spec)) as Record<string, unknown>
  const names = Object.keys(real).filter((n) => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n))
  const lines = [
    `const unavailable = (name) => { const f = () => { throw new Error('playground: ' + name + ' is not available (the plan should not reach it)') }; return new Proxy(f, { get: (_t, k) => k === 'then' ? undefined : unavailable(name + '.' + String(k)) }) }`,
  ]
  for (const n of names) {
    const data = asData(real[n])
    if (data !== null) inlined.push(`${spec} ${n}`)
    lines.push(`export const ${n} = ${data ?? `unavailable(${JSON.stringify(`${spec} ${n}`)})`}`)
  }
  lines.push(`export default unavailable(${JSON.stringify(spec)})`)
  return lines.join('\n')
}

const platformPlugin: BunPlugin = {
  name: 'vx-playground-platform',
  setup(build) {
    build.onResolve(
      {
        filter:
          /^(node:|bun:|fs$|fs\/promises$|path$|os$|crypto$|child_process$|@anthropic-ai\/sandbox-runtime$)/,
      },
      (args) => {
        const importer = path.relative(path.join(here, '../..'), args.importer)
        const set = requested.get(args.path) ?? new Set<string>()
        set.add(importer)
        requested.set(args.path, set)
        const alias = ALIASES[args.path]
        if (alias !== undefined) return { path: alias }
        if (POLYFILLED.has(args.path)) return undefined
        stubbed.add(args.path)
        if (!stubFrom.has(args.path)) {
          stubFrom.set(args.path, Bun.resolveSync(args.path, path.dirname(args.importer)))
        }
        return { path: args.path, namespace: 'vx-stub' }
      },
    )
    build.onLoad({ filter: /.*/, namespace: 'vx-stub' }, async (args) => ({
      contents: await stubSource(args.path),
      loader: 'js',
    }))
  },
}

function treatment(spec: string): string {
  if (ALIASES[spec] !== undefined) return `VFS shim ${path.basename(ALIASES[spec]!)}`
  if (POLYFILLED.has(spec)) return 'bun browser polyfill'
  return 'link-only stub (throws if called)'
}

const result = await Bun.build({
  entrypoints: [path.join(here, 'entry.ts')],
  outdir,
  target: 'browser',
  format: 'esm',
  minify: true,
  sourcemap: 'none',
  metafile: true,
  define: { Bun: '__vxBun', process: '__vxProcess' },
  plugins: [platformPlugin],
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const out = result.outputs.find((o) => o.path.endsWith('.js'))!
const bytes = new Uint8Array(await out.arrayBuffer())
const text = new TextDecoder().decode(bytes)
const gzipped = Bun.gzipSync(bytes, { level: 9 })

// A free `Bun` / `process` the define missed, as code: preceded by an
// operator or bracket. The shim's own messages ("… Bun.spawn is not
// available") are strings, preceded by a space or a quote.
const leftovers = new Set<string>()
for (const m of text.matchAll(/(?<=[=(,;!{}?:&|[+-])\s*(Bun|process)\.[A-Za-z_$][\w$]*/g)) {
  leftovers.add(m[0].trim())
}
const rewritten = {
  __vxBun: text.split('__vxBun').length - 1,
  __vxProcess: text.split('__vxProcess').length - 1,
}
const externals = new Set<string>()
for (const m of text.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)) externals.add(m[1]!)

const inputs = Object.entries(
  (
    result.metafile as {
      outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>
    }
  ).outputs,
)
  .flatMap(([, o]) => Object.entries(o.inputs))
  .map(([file, v]) => [file.replace(/^.*packages\//, ''), v.bytesInOutput] as const)
  .sort((a, b) => b[1] - a[1])

const byModule = new Map<string, number>()
for (const [file, n] of inputs) {
  const key = file.startsWith('vx/src/')
    ? file.split('/').slice(0, 3).join('/')
    : file.startsWith('vx-bench/')
      ? 'playground shim + entry'
      : file.includes('node_modules') || !file.includes('/')
        ? 'bun browser polyfills'
        : file
  byModule.set(key, (byModule.get(key) ?? 0) + n)
}

console.log(
  JSON.stringify(
    {
      bun: Bun.version,
      output: path.relative(process.cwd(), out.path),
      rawBytes: bytes.byteLength,
      gzipBytes: gzipped.byteLength,
      requestedPlatformSpecifiers: Object.fromEntries(
        [...requested].map(([spec, importers]) => [
          spec,
          { treatment: treatment(spec), importers: [...importers].sort() },
        ]),
      ),
      bunOrProcessReferencesLeft: [...leftovers].sort(),
      referencesRewrittenToShim: rewritten,
      stubbedSpecifiers: [...stubbed].sort(),
      stubDataInlined: inlined.filter((n) => n.startsWith('node:')).sort(),
      importsLeftInBundle: [...externals].sort(),
      bytesByModule: Object.fromEntries([...byModule].sort((a, b) => b[1] - a[1])),
      largestInputs: inputs.slice(0, 15),
    },
    null,
    2,
  ),
)
