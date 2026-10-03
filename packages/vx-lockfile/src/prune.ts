// `vx prune <project...> [--out-dir <dir>] [--docker]`: the workspace cut to
// the named projects and their transitive workspace dependencies, for a
// Docker build that installs and builds only what it ships (`turbo prune`).
// Every lockfile here is cut to what the subset installs, so the copy
// installs with a frozen lockfile and a lockfile line the subset cannot
// reach does not bust the install layer.
//
//   <out>/            the subset (with --docker: <out>/full/)
//     package.json      `workspaces` rewritten to the subset's dirs
//     pnpm-workspace.yaml  `packages` rewritten the same way, the rest as written
//     <lockfile>        pruned
//     vx.workspace.*, the root vx.config.*, install config, patch files
//     <project dirs>    whole, less node_modules / .git / .vx / .turbo
//   <out>/json/       (--docker) the install layer: root install files and
//                     each project's package.json, nothing else

import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  buildPackageGraph,
  listProjectMetas,
  loadWorkspace,
  UserError,
  type CommandContext,
  type PluginCommand,
  type ProjectMeta,
} from '@vzn/vx'
import * as bunLock from './bun.js'
import * as npmLock from './npm.js'
import * as pnpmLock from './pnpm.js'
import * as yarnLock from './yarn.js'
import type { PruneScope } from './scope.js'

const USAGE = 'usage: vx prune <project...> [--out-dir <dir>] [--docker]'

const LOCKFILES: Readonly<Record<string, (text: string, scope: PruneScope) => string>> = {
  'pnpm-lock.yaml': pnpmLock.pruneLockfile,
  'bun.lock': bunLock.pruneLockfile,
  'package-lock.json': npmLock.pruneLockfile,
  'yarn.lock': yarnLock.pruneLockfile,
}

/** Root files an install reads, copied when present (the manifest and workspace file are rewritten). */
const INSTALL_FILES = [
  '.npmrc',
  '.yarnrc.yml',
  '.pnpmfile.cjs',
  'bunfig.toml',
  '.nvmrc',
  '.node-version',
]
const VX_FILES = [
  'vx.workspace.ts',
  'vx.workspace.mts',
  'vx.workspace.js',
  'vx.workspace.mjs',
  'vx.config.ts',
  'vx.config.mts',
  'vx.config.js',
  'vx.config.mjs',
  'vx.config.cts',
  'vx.config.cjs',
]
const COPY_EXCLUDES = new Set(['node_modules', '.git', '.vx', '.turbo'])
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
/** `from '…'`, `import '…'`, `import('…')`: static specifiers only. */
const SPECIFIER_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g

/** One object for all four plugins, so a workspace declaring two still has one `prune`. */
export const pruneCommand: PluginCommand = {
  description: 'copy projects and their workspace deps, lockfile pruned, for a Docker build',
  run: (argv, ctx) => prune(argv, ctx),
}

interface Args {
  readonly projects: readonly string[]
  readonly outDir: string
  readonly docker: boolean
}

function parseArgs(argv: readonly string[]): Args | null {
  const projects: string[] = []
  let outDir = 'out'
  let docker = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--help' || a === '-h') return null
    if (a === '--docker') docker = true
    else if (a === '--out-dir' || a.startsWith('--out-dir=')) {
      const v = a === '--out-dir' ? argv[++i] : a.slice('--out-dir='.length)
      if (v === undefined || v === '')
        throw new UserError(`vx prune: --out-dir needs a path\n${USAGE}`)
      outDir = v
    } else if (a.startsWith('-')) throw new UserError(`vx prune: unknown flag ${a}\n${USAGE}`)
    else projects.push(a)
  }
  if (projects.length === 0) throw new UserError(`vx prune: name at least one project\n${USAGE}`)
  return { projects, outDir, docker }
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  )
}

const posix = (p: string): string => p.split(path.sep).join('/')

/** `a` within `dir`, or `dir` itself. */
const within = (a: string, dir: string): boolean => a === dir || a.startsWith(dir + path.sep)

async function prune(argv: readonly string[], ctx: CommandContext): Promise<number> {
  const args = parseArgs(argv)
  if (args === null) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const root = ctx.workspaceRoot
  const projects = (await listProjectMetas(await loadWorkspace(root))).filter((p) => p.dir !== root)
  const byName = new Map(projects.map((p) => [p.name, p]))
  const unknown = args.projects.filter((n) => !byName.has(n))
  if (unknown.length > 0) {
    throw new UserError(
      `vx prune: no project named ${unknown.map((n) => JSON.stringify(n)).join(', ')} (the root is always kept; name the projects under it)`,
    )
  }
  const graph = buildPackageGraph(projects)
  const names = new Set<string>()
  const add = (name: string): void => {
    if (names.has(name) || !byName.has(name)) return
    names.add(name)
    for (const d of graph.transitiveDeps(name)) add(d)
  }
  for (const n of args.projects) add(n)
  // A vx config runs before any task, so a workspace package it imports (a
  // local plugin) is as load-bearing as a dependency: without it `vx run`
  // in the image cannot load the config. Pulled in with its closure, until
  // no config names another.
  const owner = (spec: string): ProjectMeta | undefined =>
    projects.find((p) => spec === p.name || spec.startsWith(`${p.name}/`))
  const escapes: string[] = []
  const scanned = new Set<string>()
  const scan = async (dir: string, label: string): Promise<void> => {
    for (const f of VX_FILES) {
      const file = path.join(dir, f)
      if (!(await exists(file))) continue
      for (const [, spec] of (await Bun.file(file).text()).matchAll(SPECIFIER_RE)) {
        if (spec!.startsWith('.')) {
          const target = path.resolve(dir, spec!)
          const kept =
            [...names].some((n) => within(target, byName.get(n)!.dir)) ||
            path.dirname(target) === root
          if (!kept) escapes.push(`${label}: ${spec} resolves outside the subset`)
        } else {
          const p = owner(spec!)
          if (p !== undefined) add(p.name)
        }
      }
    }
  }
  await scan(root, 'the workspace root')
  for (let grew = true; grew;) {
    grew = false
    for (const n of [...names]) {
      if (scanned.has(n)) continue
      scanned.add(n)
      grew = true
      await scan(byName.get(n)!.dir, n)
    }
  }
  const subset = [...names].map((n) => byName.get(n)!).sort((a, b) => a.name.localeCompare(b.name))
  const rels = subset.map((p) => posix(path.relative(root, p.dir)))

  const out = path.resolve(process.cwd(), args.outDir)
  if (within(root, out)) {
    throw new UserError(`vx prune: --out-dir ${args.outDir} is or contains the workspace root`)
  }
  for (const p of subset) {
    if (within(out, p.dir)) {
      throw new UserError(
        `vx prune: --out-dir ${args.outDir} is inside ${p.name}, which the subset copies — pick a path outside it`,
      )
    }
  }
  const held = await readdir(out).then(
    (entries) => entries.length > 0,
    (err: NodeJS.ErrnoException) => err.code !== 'ENOENT',
  )
  if (held) {
    throw new UserError(
      `vx prune: --out-dir ${args.outDir} already has content — remove it or name an empty directory`,
    )
  }

  const rootManifest = JSON.parse(await Bun.file(path.join(root, 'package.json')).text()) as Record<
    string,
    unknown
  >
  const field = rootManifest['workspaces']
  const listed = Array.isArray(field)
    ? (field as string[])
    : ((field as { packages?: string[] } | undefined)?.packages ?? undefined)
  const workspaces = listed?.includes('.') ? ['.', ...rels] : rels
  if (listed !== undefined) {
    rootManifest['workspaces'] = Array.isArray(field)
      ? workspaces
      : { ...(field as object), packages: workspaces }
  }

  const manifests = new Map<string, ReadonlyMap<string, string>>()
  type Deps = Partial<Record<(typeof DEP_FIELDS)[number], Record<string, string>>>
  const depsOf = (pkg: Deps): ReadonlyMap<string, string> =>
    new Map(DEP_FIELDS.flatMap((f) => Object.entries(pkg[f] ?? {})))
  manifests.set('.', depsOf(rootManifest as Deps))
  for (const [i, p] of subset.entries()) manifests.set(rels[i]!, depsOf(p.packageJson))
  const scope: PruneScope = {
    dirs: new Set(['.', ...rels]),
    members: new Set(projects.map((p) => posix(path.relative(root, p.dir)))),
    workspaces,
    manifests,
  }

  if (
    (await exists(path.join(root, 'bun.lockb'))) &&
    !(await exists(path.join(root, 'bun.lock')))
  ) {
    throw new UserError(
      'vx prune: bun.lockb is binary and cannot be pruned — `bun install --save-text-lockfile` writes bun.lock',
    )
  }
  const written = new Map<string, string>()
  for (const [file, pruneLock] of Object.entries(LOCKFILES)) {
    const src = path.join(root, file)
    if (!(await exists(src))) continue
    try {
      written.set(file, pruneLock(await Bun.file(src).text(), scope))
    } catch (err) {
      throw new UserError(`vx prune: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const workspaceYaml = path.join(root, 'pnpm-workspace.yaml')
  if (await exists(workspaceYaml)) {
    written.set(
      'pnpm-workspace.yaml',
      rewriteWorkspaceYaml(await Bun.file(workspaceYaml).text(), rels),
    )
  }
  // A manifest with no `workspaces` (pnpm's) is copied byte for byte.
  if (listed !== undefined)
    written.set('package.json', `${JSON.stringify(rootManifest, null, 2)}\n`)
  const installFiles = [
    ...(listed === undefined ? ['package.json'] : []),
    ...INSTALL_FILES,
    ...(await namedFiles(root, rootManifest)),
  ]

  const emit = async (dest: string, extra: readonly string[]): Promise<void> => {
    await mkdir(dest, { recursive: true })
    for (const [file, text] of written) await writeFile(path.join(dest, file), text)
    for (const f of [...installFiles, ...extra]) {
      const src = path.join(root, f)
      if (!(await exists(src))) continue
      await mkdir(path.dirname(path.join(dest, f)), { recursive: true })
      await cp(src, path.join(dest, f), { recursive: true })
    }
  }
  const full = args.docker ? path.join(out, 'full') : out
  await emit(full, VX_FILES)
  for (const [i, p] of subset.entries()) {
    await cp(p.dir, path.join(full, rels[i]!), {
      recursive: true,
      filter: (src) => !COPY_EXCLUDES.has(path.basename(src)),
    })
  }
  if (args.docker) {
    const json = path.join(out, 'json')
    await emit(json, [])
    for (const rel of rels) {
      await mkdir(path.join(json, rel), { recursive: true })
      await cp(path.join(root, rel, 'package.json'), path.join(json, rel, 'package.json'))
    }
  }

  const lockfiles = Object.keys(LOCKFILES).filter((f) => written.has(f))
  process.stdout.write(
    `vx prune: ${subset.length} project${subset.length === 1 ? '' : 's'} → ${args.outDir}` +
      `${args.docker ? ' (json/ + full/)' : ''}` +
      `${lockfiles.length > 0 ? `, ${lockfiles.join(', ')} pruned` : ''}\n` +
      subset.map((p, i) => `  ${p.name} (${rels[i]})\n`).join(''),
  )
  for (const e of escapes) process.stderr.write(`vx prune: warning: ${e}\n`)
  return 0
}

/** `packages:` cut to the subset's dirs; every other key as written. */
function rewriteWorkspaceYaml(text: string, rels: readonly string[]): string {
  const lines = text.split('\n')
  const list = ['packages:', ...rels.map((r) => `  - ${JSON.stringify(r)}`)]
  const at = lines.findIndex((l) => /^packages\s*:/.test(l))
  if (at === -1) return [...list, ...lines].join('\n')
  let end = at + 1
  if (/^packages\s*:\s*$/.test(lines[at]!)) {
    while (end < lines.length && (lines[end] === '' || /^[\s-]/.test(lines[end]!))) end++
    while (end > at + 1 && lines[end - 1]!.trim() === '') end--
  }
  return [...lines.slice(0, at), ...list, ...lines.slice(end)].join('\n')
}

/**
 * Root files the install config names: patch files (bun's and pnpm's
 * `patchedDependencies`, in the manifest or pnpm-workspace.yaml) and
 * Yarn's `yarnPath` and plugins. A path outside the root is not the
 * workspace's to copy.
 */
async function namedFiles(root: string, manifest: Record<string, unknown>): Promise<string[]> {
  const values = (v: unknown): unknown[] =>
    v !== null && typeof v === 'object' ? Object.values(v as Record<string, unknown>) : []
  const named: unknown[] = [
    ...values(manifest['patchedDependencies']),
    ...values((manifest['pnpm'] as Record<string, unknown> | undefined)?.['patchedDependencies']),
  ]
  const yaml = async (file: string): Promise<Record<string, unknown>> => {
    const p = path.join(root, file)
    if (!(await exists(p))) return {}
    const doc: unknown = Bun.YAML.parse(await Bun.file(p).text())
    return doc !== null && typeof doc === 'object' && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : {}
  }
  named.push(...values((await yaml('pnpm-workspace.yaml'))['patchedDependencies']))
  const yarnrc = await yaml('.yarnrc.yml')
  named.push(yarnrc['yarnPath'])
  for (const p of Array.isArray(yarnrc['plugins']) ? yarnrc['plugins'] : []) {
    named.push(typeof p === 'string' ? p : (p as Record<string, unknown> | null)?.['path'])
  }
  return named.filter(
    (f): f is string =>
      typeof f === 'string' && !path.isAbsolute(f) && !path.normalize(f).startsWith('..'),
  )
}
