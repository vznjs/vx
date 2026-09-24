#!/usr/bin/env bun
// The playground's planner bundle: vx's own planner source behind the
// browser shim (src/playground/), built by Bun rather than the site's Vite,
// so the file core's parity rows test is the file the site ships
// (design/playground-spike-2026-09.md § W9 decisions).
//
//   bun scripts/build-playground.ts   → public/playground/planner.js (gitignored)
//
// `@vzn/vx-docs#build.playground` runs this; `buildPlayground()` is what
// `packages/vx/tests/playground-parity.unsafe.test.ts` and this package's
// `tests/playground-bundle.test.ts` call, so no copy of the options exists.
//
// `Bun.build({ target: 'browser' })` is the JS form of `bun build
// --target=browser`, needed for the aliasing plugin. The three platform
// specifiers the plan reads are aliased to the VFS-backed shims,
// `node:path` is left to Bun's browser polyfill, every other one the graph
// names links against a stub, and `Bun` / `process` are rewritten to the
// shim's objects.
//
// One fixed file name, not a content hash: the task's output is that name
// exactly, so a cache hit restores it and a rebuild never leaves an old
// hashed sibling in `public/` to ship; and GitHub Pages serves every file,
// the pages included, with the same short max-age, so a hash buys no
// long-lived caching.

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BunPlugin } from 'bun'

/** Where the bundle sits under `public/`, and so under the built site's root. */
export const PLANNER_FILE = 'playground/planner.js'

const here = import.meta.dir
const packagesDir = path.resolve(here, '../..')
const shim = (f: string): string => path.resolve(here, '../src/playground/shim', f)

const ALIASES: Record<string, string> = {
  'node:fs': shim('node-fs.ts'),
  fs: shim('node-fs.ts'),
  'node:fs/promises': shim('node-fs-promises.ts'),
  'fs/promises': shim('node-fs-promises.ts'),
  'bun:sqlite': shim('bun-sqlite.ts'),
}

// Left to Bun's browser polyfill: pure string work, no platform behind it.
const POLYFILLED = new Set(['node:path', 'path'])

type Treatment = 'shim' | 'polyfill' | 'stub'

export interface PlaygroundBuild {
  bytes: Uint8Array<ArrayBuffer>
  /** Each platform specifier the import graph asked for, how it was met, and by whom. */
  specifiers: Map<string, { treatment: Treatment; importers: Set<string> }>
  metafile: unknown
}

// The one stubbed export the plan reads for its VALUE: config-imports.ts
// builds its set of builtins from `builtinModules` at load, so it is inlined
// as the build's Bun has it. Only this one: the spike inlined every export
// that was JSON under 20 KB, and an export's value is the building process's
// state. `node:module`'s `_cache` is its module cache, data in a script and
// over the limit inside `bun test`, so the stub became a call instead, which
// tree-shaking keeps, and the same sources built 27 bytes apart (item 695).
const INLINED = new Set(['node:module builtinModules'])

export async function buildPlayground(): Promise<PlaygroundBuild> {
  const specifiers: PlaygroundBuild['specifiers'] = new Map()
  const stubFrom = new Map<string, string>()

  // A specifier the plan never calls into but some module on the static
  // import graph names (the executor, the sandbox runtime, the config
  // evaluator). Bun resolves every static and dynamic import before it
  // tree-shakes, so each needs a module to link against: one whose export
  // NAMES are the real module's, read here at build time. Every export but
  // INLINED is a proxy that throws when called, marked pure so that an
  // export nothing reads is shaken out.
  async function stubSource(spec: string): Promise<string> {
    const real = (await import(stubFrom.get(spec) ?? spec)) as Record<string, unknown>
    const names = Object.keys(real).filter((n) => n !== 'default' && /^[A-Za-z_$][\w$]*$/.test(n))
    const unavailable = (name: string): string =>
      `/* @__PURE__ */ unavailable(${JSON.stringify(name)})`
    const lines = [
      `const unavailable = (name) => { const f = () => { throw new Error('playground: ' + name + ' is not available (the plan should not reach it)') }; return new Proxy(f, { get: (_t, k) => k === 'then' ? undefined : unavailable(name + '.' + String(k)) }) }`,
    ]
    for (const n of names) {
      const value = INLINED.has(`${spec} ${n}`)
        ? JSON.stringify(real[n])
        : unavailable(`${spec} ${n}`)
      lines.push(`export const ${n} = ${value}`)
    }
    lines.push(`export default ${unavailable(spec)}`)
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
          const alias = ALIASES[args.path]
          const treatment: Treatment =
            alias !== undefined ? 'shim' : POLYFILLED.has(args.path) ? 'polyfill' : 'stub'
          const seen = specifiers.get(args.path) ?? { treatment, importers: new Set<string>() }
          seen.importers.add(path.relative(packagesDir, args.importer))
          specifiers.set(args.path, seen)
          if (alias !== undefined) return { path: alias }
          if (treatment === 'polyfill') return undefined
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

  const result = await Bun.build({
    entrypoints: [path.resolve(here, '../src/playground/entry.ts')],
    target: 'browser',
    format: 'esm',
    minify: true,
    sourcemap: 'none',
    metafile: true,
    define: { Bun: '__vxBun', process: '__vxProcess' },
    plugins: [platformPlugin],
  })
  if (!result.success) {
    throw new AggregateError(result.logs, 'playground: Bun.build failed')
  }
  const [out] = result.outputs
  return {
    bytes: new Uint8Array(await out!.arrayBuffer()),
    specifiers,
    metafile: result.metafile,
  }
}

if (import.meta.main) {
  const { bytes } = await buildPlayground()
  const file = path.resolve(here, '../public', PLANNER_FILE)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, bytes)
  console.log(
    `${path.relative(process.cwd(), file)}: ${bytes.byteLength} B, ${Bun.gzipSync(bytes, { level: 9 }).byteLength} B gzip`,
  )
}
