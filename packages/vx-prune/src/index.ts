// `vx prune <project> [--out-dir <dir>] [--docker]` — emit a self-contained
// SUBSET of the workspace containing one project and its transitive
// workspace dependencies, for Docker builds (Turbo `turbo prune` parity).
// Two ways in, one body: `bunx @vzn/vx-prune` (its own bin, no workspace
// file needed) and the `prune` verb a workspace gets by declaring the
// plugin (the `commands` seam). Core's own verb until 2026-09-10.
//
// What lands in the output:
//   <out>/               the pruned workspace (or <out>/full/ with --docker)
//     package.json         root manifest, `workspaces` rewritten to the subset
//     pnpm-workspace.yaml  REWRITTEN to the exact subset dirs (a glob that
//                          matches dirs absent from the subset would make
//                          pnpm error on install)
//     <lockfile>           copied UNPRUNED — pnpm/bun/npm/yarn all tolerate
//                          a superset lockfile, and a wrongly pruned one is
//                          worse than a big correct one
//     vx.workspace.*       copied when present
//     <pkg dirs>           each subset package, node_modules/.git/.vx/.turbo
//                          excluded
//   <out>/json/          (--docker) root files + each package's package.json
//                          only — the cacheable install layer

import { cp, mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  buildPackageGraph,
  findWorkspaceRoot,
  listProjectMetas,
  loadWorkspace,
  nearMatches,
  UserError,
  type VxPlugin,
} from '@vzn/vx'

const USAGE = 'usage: vx prune <project> [--out-dir <dir>] [--docker]'
export const PRUNE_PLUGIN = 'vx/prune'

/** The plugin: a workspace that declares it gets `vx prune` from the vx CLI. */
export function prune(): VxPlugin {
  return {
    name: PRUNE_PLUGIN,
    commands: {
      prune: {
        description: 'emit a workspace subset (one project + its deps) for Docker builds',
        run(argv) {
          return pruneWorkspace(argv)
        },
      },
    },
  }
}

export interface PruneArgs {
  project?: string
  outDir: string
  docker: boolean
  error?: string
}

export function parsePruneArgs(args: readonly string[]): PruneArgs {
  const out: PruneArgs = { outDir: 'out', docker: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--out-dir' || a.startsWith('--out-dir=')) {
      const v = a === '--out-dir' ? args[++i] : a.slice('--out-dir='.length)
      if (v === undefined || v === '') return { ...out, error: 'invalid --out-dir: empty' }
      out.outDir = v
      continue
    }
    if (a === '--docker') {
      out.docker = true
      continue
    }
    if (a.startsWith('-')) return { ...out, error: `unknown flag: ${a}\n${USAGE}` }
    if (out.project !== undefined) return { ...out, error: `unexpected argument: ${a}` }
    out.project = a
  }
  return out
}

const COPY_EXCLUDES = new Set(['node_modules', '.git', '.vx', '.turbo'])

/** Root-level files worth carrying into the subset, when they exist. */
const ROOT_FILES = ['package.json', '.npmrc', '.nvmrc']
const WORKSPACE_CONFIGS = [
  'vx.workspace.ts',
  'vx.workspace.mts',
  'vx.workspace.js',
  'vx.workspace.mjs',
]
const LOCKFILES = ['pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock']

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  )
}

async function copyDirFiltered(src: string, dest: string): Promise<void> {
  await cp(src, dest, {
    recursive: true,
    filter: (source) => !COPY_EXCLUDES.has(path.basename(source)),
  })
}

const PROJECT_CONFIGS = ['vx.config.ts', 'vx.config.mts', 'vx.config.js', 'vx.config.mjs']
/** `from '…'`, `import '…'`, `import('…')`. Static specifiers only. */
const SPECIFIER_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g

async function readImports(dir: string, names: readonly string[]): Promise<string[]> {
  for (const f of names) {
    const p = path.join(dir, f)
    if (!(await exists(p))) continue
    const text = await Bun.file(p).text()
    return [...text.matchAll(SPECIFIER_RE)].map((m) => m[1]!)
  }
  return []
}

/** The verb: one project and its closure, copied to `--out-dir` relative to `cwd`. */
export async function pruneWorkspace(
  args: readonly string[],
  cwd = process.cwd(),
): Promise<number> {
  const parsed = parsePruneArgs(args)
  if (parsed.error !== undefined) throw new UserError(`vx prune: ${parsed.error}`)
  if (parsed.project === undefined) {
    throw new UserError('vx prune: <project> required (e.g. vx prune @acme/api)')
  }

  const root = await findWorkspaceRoot(cwd)
  const workspace = await loadWorkspace(root)
  const projects = await listProjectMetas(workspace)
  const byName = new Map(projects.map((p) => [p.name, p]))

  const target = byName.get(parsed.project)
  if (target === undefined) {
    const near = nearMatches(parsed.project, [...byName.keys()].sort())
    throw new UserError(
      `vx prune: no project named "${parsed.project}"` +
        (near.length > 0 ? ` — did you mean ${near.join(', ')}?` : ''),
    )
  }

  const graph = buildPackageGraph(projects)
  const names = new Set([target.name, ...graph.transitiveDeps(target.name)])

  // The workspace config runs BEFORE any task, so a plugin it imports from a
  // workspace package is as load-bearing as a package dependency — without it
  // `vx run` in the container fails to load the config at all. Pull those in
  // (with their own dep closure). The root member is the one that cannot be:
  // copying it would mean copying the whole tree, so it is reported instead.
  const projectFor = (spec: string): (typeof projects)[number] | undefined =>
    projects.find((p) => spec === p.name || spec.startsWith(`${p.name}/`))
  const uncopyable = new Set<string>()
  for (const spec of await readImports(root, WORKSPACE_CONFIGS)) {
    const owner = projectFor(spec)
    if (owner === undefined || names.has(owner.name)) continue
    if (owner.dir === root) {
      uncopyable.add(`${owner.name} (the workspace root itself)`)
      continue
    }
    names.add(owner.name)
    for (const d of graph.transitiveDeps(owner.name)) names.add(d)
  }

  const subset = [...names].map((n) => byName.get(n)!).sort((a, b) => a.name.localeCompare(b.name))

  const outAbs = path.resolve(cwd, parsed.outDir)
  // Three shapes that would eat their own tail: the out dir IS the root
  // (overwrites the workspace), CONTAINS the root (copies land above the
  // repo), or sits INSIDE a package being copied (cp would recurse into
  // its own output). A root-level ./out is fine — only package dirs are
  // copied wholesale, never the root itself.
  if (outAbs === root || root.startsWith(outAbs + path.sep)) {
    throw new UserError('vx prune: --out-dir must not be, or contain, the workspace root')
  }
  for (const p of subset) {
    if (outAbs === p.dir || outAbs.startsWith(p.dir + path.sep)) {
      throw new UserError(
        `vx prune: --out-dir is inside ${p.name}, which is being copied — pick a path outside the pruned packages`,
      )
    }
  }
  const fullDir = parsed.docker ? path.join(outAbs, 'full') : outAbs
  const jsonDir = path.join(outAbs, 'json')
  await mkdir(fullDir, { recursive: true })
  if (parsed.docker) await mkdir(jsonDir, { recursive: true })

  const rels = subset.map((p) => path.relative(root, p.dir).split(path.sep).join('/'))
  // pnpm-workspace.yaml rewritten to the exact subset — globs that match
  // nothing in the subset make installs fail.
  const workspaceYaml = `packages:\n${rels.map((r) => `  - "${r}"\n`).join('')}`

  // package.json's `workspaces` is where bun/npm/yarn read membership, and it
  // needs the SAME rewrite as pnpm-workspace.yaml for the same reason — except
  // the failure is sharper: a GLOB matching nothing is tolerated, but an entry
  // naming an exact dir that the subset does not contain is fatal
  // (`bun install` → `error: Workspace not found "packages/b"`, exit 1), so the
  // emitted context would not install at all. A `.` entry is kept when it was
  // there: it names the root package, whose manifest is copied.
  const rewriteRootManifest = async (dest: string): Promise<boolean> => {
    const src = path.join(root, 'package.json')
    if (!(await exists(src))) return false
    let pkg: Record<string, unknown>
    try {
      pkg = JSON.parse(await Bun.file(src).text()) as Record<string, unknown>
    } catch {
      return false // unparseable: copy it verbatim rather than lose it
    }
    const field = pkg['workspaces']
    const list = Array.isArray(field)
      ? field
      : typeof field === 'object' && field !== null && Array.isArray((field as never)['packages'])
        ? ((field as never)['packages'] as string[])
        : undefined
    if (list === undefined) return false
    const next = (list as string[]).includes('.') ? ['.', ...rels] : [...rels]
    pkg['workspaces'] = Array.isArray(field) ? next : { ...(field as object), packages: next }
    await writeFile(path.join(dest, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
    return true
  }

  const emitRoots = async (dest: string): Promise<void> => {
    await writeFile(path.join(dest, 'pnpm-workspace.yaml'), workspaceYaml)
    const manifestWritten = await rewriteRootManifest(dest)
    for (const f of [...ROOT_FILES, ...WORKSPACE_CONFIGS, ...LOCKFILES]) {
      if (f === 'package.json' && manifestWritten) continue
      const src = path.join(root, f)
      if (await exists(src)) await cp(src, path.join(dest, f))
    }
  }

  await emitRoots(fullDir)
  for (const [i, p] of subset.entries()) {
    await copyDirFiltered(p.dir, path.join(fullDir, rels[i]!))
  }

  if (parsed.docker) {
    await emitRoots(jsonDir)
    for (const [i, p] of subset.entries()) {
      const pkgJson = path.join(p.dir, 'package.json')
      if (await exists(pkgJson)) {
        const destDir = path.join(jsonDir, rels[i]!)
        await mkdir(destDir, { recursive: true })
        await cp(pkgJson, path.join(destDir, 'package.json'))
      }
    }
  }

  // Every copied config is re-read to report what the subset canNOT satisfy:
  // a relative import reaching outside the copied dirs, or a workspace package
  // that is not here. Copied root files (the manifest, the lockfile, the
  // workspace config) count as present — a config importing one of those is
  // fine, and flagging it would be a false alarm.
  const copiedRootFiles = new Set([...ROOT_FILES, ...WORKSPACE_CONFIGS, ...LOCKFILES])
  const escapes: string[] = []
  for (const p of subset) {
    for (const spec of await readImports(p.dir, PROJECT_CONFIGS)) {
      if (spec.startsWith('.')) {
        const resolved = path.resolve(p.dir, spec)
        const inSubset = subset.some(
          (q) => resolved === q.dir || resolved.startsWith(q.dir + path.sep),
        )
        const isCopiedRootFile =
          path.dirname(resolved) === root && copiedRootFiles.has(path.basename(resolved))
        if (!inSubset && !isCopiedRootFile) {
          escapes.push(`${p.name}: ${spec} resolves outside the pruned subset`)
        }
        continue
      }
      const owner = projectFor(spec)
      if (owner !== undefined && !subset.includes(owner)) {
        escapes.push(`${p.name}: imports ${owner.name}, which is not in the subset`)
      }
    }
  }

  process.stdout.write(
    `pruned ${subset.length} package${subset.length === 1 ? '' : 's'} for ${target.name} → ${parsed.outDir}${parsed.docker ? ' (docker layout: json/ + full/)' : ''}\n` +
      subset.map((p) => `  ${p.name}\n`).join(''),
  )
  for (const u of uncopyable) {
    process.stderr.write(
      `vx prune: WARNING the workspace config imports ${u} — it cannot be copied into a subset, so \`vx run\` inside the container will not load it\n`,
    )
  }
  for (const e of escapes) {
    process.stderr.write(`vx prune: WARNING ${e}\n`)
  }
  return 0
}
