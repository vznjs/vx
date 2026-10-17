// Where `tsc` keeps its incremental state. tsc reads its `.tsbuildinfo`
// and re-emits only the files it calls changed. vx empties a task's
// outputs before a miss, so a `tsc -b` whose buildinfo sits outside them
// (rootDir `src`, outDir `dist`: `tsconfig.tsbuildinfo` beside the
// tsconfig) re-emitted the edited file into an empty `dist/`, and vx cached
// that partial `dist/`. Turbo never cleans, so its `dist/` stayed whole; Nx
// infers the buildinfo as an output. A mapped task declares it too.

import { readFileSync } from 'node:fs'
import path from 'node:path'

/** A file's text, or null when it cannot be read. */
export type ReadText = (file: string) => string | null

interface Options {
  composite?: unknown
  incremental?: unknown
  tsBuildInfoFile?: unknown
  outDir?: unknown
  rootDir?: unknown
  outFile?: unknown
}

interface TsConfig {
  extends?: unknown
  references?: unknown
  compilerOptions?: Options
}

function parse(read: ReadText, file: string): TsConfig | null {
  const text = read(file)
  if (text === null) return null
  try {
    const v = Bun.JSONC.parse(text)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as TsConfig) : null
  } catch {
    return null
  }
}

/** The file an `extends` entry names, as tsc resolves it (a package through `node_modules`). */
function extended(read: ReadText, from: string, ext: string): string | null {
  const withJson = (p: string) => (p.endsWith('.json') ? p : `${p}.json`)
  if (ext.startsWith('.') || path.isAbsolute(ext)) return withJson(path.resolve(from, ext))
  for (let dir = from; ; dir = path.dirname(dir)) {
    const base = path.join(dir, 'node_modules', ext)
    for (const f of [withJson(base), path.join(base, 'tsconfig.json')])
      if (read(f) !== null) return f
    if (path.dirname(dir) === dir) return null
  }
}

/** The buildinfo path tsc writes for the project `file` (tsc's `getTsBuildInfoEmitOutputFilePath`). */
function buildInfoOf(read: ReadText, file: string, build: boolean): string | null {
  const configDir = path.dirname(file)
  const opts: { [K in keyof Options]?: string | boolean } = {}
  const seen = new Set<string>()
  // The nearest file that states a field decides it; a path is relative to that file.
  const visit = (at: string, depth: number): void => {
    if (depth > 16 || seen.has(at)) return
    seen.add(at)
    const cfg = parse(read, at)
    if (cfg === null) return
    const o = cfg.compilerOptions ?? {}
    for (const k of ['composite', 'incremental'] as const)
      if (opts[k] === undefined && typeof o[k] === 'boolean') opts[k] = o[k]
    for (const k of ['tsBuildInfoFile', 'outDir', 'rootDir', 'outFile'] as const) {
      const v = o[k]
      if (opts[k] !== undefined || typeof v !== 'string') continue
      opts[k] = v.startsWith('${configDir}')
        ? path.join(configDir, v.slice('${configDir}'.length))
        : path.resolve(path.dirname(at), v)
    }
    // A later entry of an `extends` array wins over an earlier one.
    const exts = typeof cfg.extends === 'string' ? [cfg.extends] : cfg.extends
    if (!Array.isArray(exts)) return
    for (const e of [...exts].reverse()) {
      const next = typeof e === 'string' ? extended(read, path.dirname(at), e) : null
      if (next !== null) visit(next, depth + 1)
    }
  }
  visit(file, 0)
  // No project there: tsc fails, and writes nothing.
  if (parse(read, file) === null) return null
  // tsc 5.6+ writes a buildinfo for every project `-b` builds.
  if (!build && opts.incremental !== true && opts.composite !== true) return null
  if (typeof opts.tsBuildInfoFile === 'string') return opts.tsBuildInfoFile
  const bare = (p: string) => p.slice(0, p.length - path.extname(p).length)
  if (typeof opts.outFile === 'string') return `${bare(opts.outFile)}.tsbuildinfo`
  const config = bare(file)
  const outDir = opts.outDir as string | undefined
  const rootDir = opts.rootDir as string | undefined
  const at =
    outDir === undefined
      ? config
      : rootDir === undefined
        ? path.join(outDir, path.basename(config))
        : path.resolve(outDir, path.relative(rootDir, config))
  return `${at}.tsbuildinfo`
}

/** A project argument's tsconfig: a directory names its `tsconfig.json`. */
const projectFile = (dir: string, arg: string): string =>
  arg.endsWith('.json') ? path.resolve(dir, arg) : path.resolve(dir, arg, 'tsconfig.json')

/** Words that may run `tsc` before it: a runner, or an env assignment. */
const RUNNER = /^(?:npx|bunx|pnpx|pnpm|yarn|npm|bun|exec|run|-y|--yes|--|[A-Za-z_][\w]*=\S*)$/

/**
 * The buildinfo files `command`'s `tsc` runs write, relative to the
 * package `dir` (POSIX); one outside `dir` is another package's.
 */
export function tscBuildInfo(read: ReadText, dir: string, command: string): string[] {
  const out = new Set<string>()
  for (const segment of command.split(/&&|\|\||[;|&()\n]/)) {
    const words = segment.trim().split(/\s+/)
    const at = words.indexOf('tsc')
    if (at < 0 || !words.slice(0, at).every((w) => RUNNER.test(w))) continue
    const args = words.slice(at + 1)
    if (args.some((a) => /^(?:-w|--watch|--clean)$/.test(a))) continue
    const build = args[0] === '-b' || args[0] === '--build'
    const files: string[] = []
    if (build) {
      const named = args.slice(1).filter((a) => !a.startsWith('-'))
      files.push(...(named.length > 0 ? named : ['.']).map((a) => projectFile(dir, a)))
    } else {
      const p = args.findIndex((a) => a === '-p' || a === '--project')
      files.push(projectFile(dir, p >= 0 && args[p + 1] !== undefined ? args[p + 1]! : '.'))
    }
    // `-b` builds each referenced project first, each with its own buildinfo.
    const queue = [...files]
    const visited = new Set<string>()
    while (queue.length > 0) {
      const file = queue.shift()!
      if (visited.has(file)) continue
      visited.add(file)
      const info = buildInfoOf(read, file, build)
      if (info !== null) {
        const rel = path.relative(dir, info).split(path.sep).join('/')
        if (!rel.startsWith('../') && !path.isAbsolute(rel)) out.add(rel)
      }
      if (!build) continue
      const refs = parse(read, file)?.references
      if (!Array.isArray(refs)) continue
      for (const r of refs) {
        const p = (r as { path?: unknown } | null)?.path
        if (typeof p === 'string') queue.push(projectFile(path.dirname(file), p))
      }
    }
  }
  return [...out]
}

/** A reader that reads each file once, and the texts it read (a mapping's cache key). */
export function onceReader(): { read: ReadText; texts: Map<string, string | null> } {
  const texts = new Map<string, string | null>()
  const read: ReadText = (file) => {
    if (!texts.has(file)) {
      let text: string | null = null
      try {
        text = readFileSync(file, 'utf8')
      } catch {}
      texts.set(file, text)
    }
    return texts.get(file)!
  }
  return { read, texts }
}
