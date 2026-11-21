// Where `tsc` keeps its incremental state. tsc reads its `.tsbuildinfo`
// and re-emits only the files it calls changed. vx empties a task's
// outputs before a miss, so a `tsc -b` whose buildinfo sits outside them
// (rootDir `src`, outDir `dist`: `tsconfig.tsbuildinfo` beside the
// tsconfig) re-emitted the edited file into an empty `dist/`, and vx cached
// that partial `dist/`. Turbo never cleans, so its `dist/` stayed whole; Nx
// infers the buildinfo as an output. A mapped task declares it too.

import { readFileSync, realpathSync } from 'node:fs'
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

/**
 * The file an `extends` entry names, as tsc resolves it: a package through
 * `node_modules`, at its real path. A path in that file is relative to where
 * it really is: plane's `@plane/typescript-config` sets `tsBuildInfoFile`,
 * which taken through the workspace link sat inside each package, so the
 * mapped output crossed the link and every build refused to run.
 */
function extended(read: ReadText, from: string, ext: string): string | null {
  const withJson = (p: string) => (p.endsWith('.json') ? p : `${p}.json`)
  if (ext.startsWith('.') || path.isAbsolute(ext)) return withJson(path.resolve(from, ext))
  for (let dir = from; ; dir = path.dirname(dir)) {
    const base = path.join(dir, 'node_modules', ext)
    for (const f of [withJson(base), path.join(base, 'tsconfig.json')])
      if (read(f) !== null) {
        try {
          return realpathSync(f)
        } catch {
          return f
        }
      }
    if (path.dirname(dir) === dir) return null
  }
}

/** The buildinfo path tsc writes for the project `file` (tsc's `getTsBuildInfoEmitOutputFilePath`). */
function buildInfoOf(read: ReadText, file: string, build: boolean): string | null {
  return projectOf(read, file, build)?.info ?? null
}

/** The buildinfo tsc writes for the project `file`, and its outDir when it names one. */
function projectOf(
  read: ReadText,
  file: string,
  build: boolean,
): { info: string; outDir: string | undefined } | null {
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
  const outDir = opts.outDir as string | undefined
  if (typeof opts.tsBuildInfoFile === 'string') return { info: opts.tsBuildInfoFile, outDir }
  const bare = (p: string) => p.slice(0, p.length - path.extname(p).length)
  if (typeof opts.outFile === 'string') return { info: `${bare(opts.outFile)}.tsbuildinfo`, outDir }
  const config = bare(file)
  const rootDir = opts.rootDir as string | undefined
  const at =
    outDir === undefined
      ? config
      : rootDir === undefined
        ? path.join(outDir, path.basename(config))
        : path.resolve(outDir, path.relative(rootDir, config))
  return { info: `${at}.tsbuildinfo`, outDir }
}

/** A project argument's tsconfig: a directory names its `tsconfig.json`. */
const projectFile = (dir: string, arg: string): string =>
  arg.endsWith('.json') ? path.resolve(dir, arg) : path.resolve(dir, arg, 'tsconfig.json')

/** tsc and the compilers that keep its buildinfo: Vue's, the native preview, ts-patch's. */
const TSC = /^(?:tsc|vue-tsc|tsgo|tspc|ttsc)$/

/** Words that may run `tsc` before it: a runner, or an env assignment. */
const RUNNER = /^(?:npx|bunx|pnpx|pnpm|yarn|npm|bun|exec|run|-y|--yes|--|[A-Za-z_][\w]*=\S*)$/

/** A package manager running a script by name: `pnpm build`, `npm run x`, `bun run x`. */
export const RUNS_SCRIPT =
  /(?:^|[\s;&|(])(?:pnpm|pn|npm|yarn|bun)\s+(?:run(?:-script)?\s+)?([^\s;&|()'"-][^\s;&|()'"]*)/g

/**
 * `command` and every script of the package at `dir` it runs by name, and
 * theirs: payload's `build` is `pnpm build:types && …`, whose `tsc` was
 * never seen, so its buildinfo stayed out of the outputs.
 */
function withScripts(read: ReadText, dir: string, command: string): string {
  const text = read(path.join(dir, 'package.json'))
  let scripts: Record<string, unknown> = {}
  try {
    const v: unknown = text === null ? null : JSON.parse(text)
    const s = (v as { scripts?: unknown } | null)?.scripts
    if (s !== null && typeof s === 'object') scripts = s as Record<string, unknown>
  } catch {}
  const commands = [command]
  const seen = new Set<string>()
  for (let i = 0; i < commands.length; i++)
    for (const m of commands[i]!.matchAll(RUNS_SCRIPT)) {
      const s = Object.hasOwn(scripts, m[1]!) ? scripts[m[1]!] : undefined
      if (typeof s === 'string' && !seen.has(m[1]!)) {
        seen.add(m[1]!)
        commands.push(s)
      }
    }
  return commands.join('\n')
}

/**
 * Each tsconfig `command`'s `tsc` runs compile, the ones a `-b` reaches
 * through `references` too (each built first, with its own buildinfo).
 */
function tscProjects(
  read: ReadText,
  dir: string,
  command: string,
): { file: string; build: boolean }[] {
  const seen: { file: string; build: boolean }[] = []
  for (const segment of withScripts(read, dir, command).split(/&&|\|\||[;|&()\n]/)) {
    const words = segment.trim().split(/\s+/)
    const at = words.findIndex((w) => TSC.test(w))
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
    const queue = [...files]
    const visited = new Set<string>()
    while (queue.length > 0) {
      const file = queue.shift()!
      if (visited.has(file)) continue
      visited.add(file)
      seen.push({ file, build })
      if (!build) continue
      const refs = parse(read, file)?.references
      if (!Array.isArray(refs)) continue
      for (const r of refs) {
        const p = (r as { path?: unknown } | null)?.path
        if (typeof p === 'string') queue.push(projectFile(path.dirname(file), p))
      }
    }
  }
  return seen
}

/**
 * The buildinfo files `command`'s `tsc` runs write, relative to the
 * package `dir` (POSIX); one outside `dir` is another package's.
 */
export function tscBuildInfo(read: ReadText, dir: string, command: string): string[] {
  const out = new Set<string>()
  for (const { file, build } of tscProjects(read, dir, command)) {
    const info = buildInfoOf(read, file, build)
    if (info === null) continue
    const rel = path.relative(dir, info).split(path.sep).join('/')
    if (!rel.startsWith('../') && !path.isAbsolute(rel)) out.add(rel)
  }
  return [...out]
}

type Member = { name: string; dir: string; packageJson: object }

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

/**
 * The TODO for a build whose `tsc -b` reaches, through tsconfig
 * `references`, members `meta` does not reach through its manifests:
 * `^build` orders none of them first, so tsc builds each inside this
 * task, writing its outputs beside its own build (Effect's
 * `@effect/ai-openrouter` referenced `../openai`). Null when none does.
 */
export function undeclaredTscTodo(
  read: ReadText,
  meta: Member,
  members: readonly Member[],
  command: string,
  rootDir: string | undefined,
): string | null {
  // The root's own `tsc -b packages` builds the members by design (nestjs/nest).
  if (meta.dir === rootDir) return null
  const dirs = new Set<string>()
  for (const { file, build } of tscProjects(read, meta.dir, command)) {
    const at = path.dirname(file)
    const rel = path.relative(meta.dir, at)
    if (build && (rel.startsWith('..') || path.isAbsolute(rel))) dirs.add(at)
  }
  if (dirs.size === 0) return null
  const byName = new Map(members.map((m) => [m.name, m]))
  const reach = new Set<string>()
  const queue = [meta.name]
  while (queue.length > 0) {
    const m = byName.get(queue.shift()!)
    if (m === undefined) continue
    // Peers too: pnpm, Bun and npm install a workspace package's peers, and
    // the lockfile plugin's `^build` follows them (Effect's packages peer `effect`).
    for (const field of DEP_FIELDS) {
      const deps = (m.packageJson as Record<string, unknown>)[field]
      if (typeof deps !== 'object' || deps === null) continue
      for (const d of Object.keys(deps)) {
        if (byName.has(d) && !reach.has(d)) {
          reach.add(d)
          queue.push(d)
        }
      }
    }
  }
  const out = new Set<string>()
  for (const dir of dirs) {
    let owner: Member | undefined
    for (const m of members) {
      const inside = dir === m.dir || dir.startsWith(m.dir + path.sep)
      if (inside && (owner === undefined || m.dir.length > owner.dir.length)) owner = m
    }
    // A workspace root is no package to depend on.
    if (owner === undefined || owner === meta || owner.dir === rootDir) continue
    if (!reach.has(owner.name)) out.add(owner.name)
  }
  if (out.size === 0) return null
  const names = [...out].sort()
  const one = names.length === 1
  const list = names.map((n) => `\`${n}\``).join(', ')
  return one
    ? `\`tsc -b\` builds ${list} through tsconfig "references", but this package does not depend on it: that build runs inside this task, writing that package's outputs beside its own build, and this task's key misses its edits; add it to this package's devDependencies (\`workspace:*\`)`
    : `\`tsc -b\` builds ${list} through tsconfig "references", but this package does not depend on them: those builds run inside this task, writing their outputs beside their own build, and this task's key misses their edits; add them to this package's devDependencies (\`workspace:*\`)`
}

/**
 * The buildinfo the package's own `tsconfig.json` keeps and the outDir it
 * emits into, relative to `dir` (POSIX), when it is incremental and both sit
 * inside `dir`. A task whose outputs take that outDir but not the buildinfo,
 * through a command not seen as tsc (remotion: `node tsrs.cjs -d`, which
 * runs tsc), emitted nothing after vx emptied the outputs: tsc called every
 * file unchanged.
 */
export function ownBuildInfo(read: ReadText, dir: string): { info: string; outDir: string } | null {
  const p = projectOf(read, path.join(dir, 'tsconfig.json'), false)
  if (p === null || p.outDir === undefined) return null
  const rel = (f: string) => path.relative(dir, f).split(path.sep).join('/')
  const info = rel(p.info)
  const outDir = rel(p.outDir)
  const inside = (r: string) => r !== '' && !r.startsWith('../') && !path.isAbsolute(r)
  return inside(info) && inside(outDir) ? { info, outDir } : null
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
