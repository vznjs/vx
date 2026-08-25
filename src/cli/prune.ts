// `vx prune <project> [--out-dir <dir>] [--docker]` — emit a self-contained
// SUBSET of the workspace containing one project and its transitive
// workspace dependencies, for Docker builds (Turbo `turbo prune` parity,
// comparison gap #10).
//
// What lands in the output:
//   <out>/               the pruned workspace (or <out>/full/ with --docker)
//     package.json         root manifest, copied as-is
//     pnpm-workspace.yaml  REWRITTEN to the exact subset dirs (a glob that
//                          matches dirs absent from the subset would make
//                          pnpm error on install)
//     <lockfile>           copied UNPRUNED — pnpm/bun/npm/yarn all tolerate
//                          a superset lockfile; real lockfile pruning is a
//                          per-format project (Turbo ships a crate per
//                          format) and a wrong pruned lockfile is worse
//                          than a big correct one. Documented, deliberate.
//     vx.workspace.*       copied when present, together with any WORKSPACE
//                          package it imports (a plugin lives in the subset
//                          or `vx run` cannot load the config at all)
//     .npmrc / .nvmrc      copied when present
//     <pkg dirs>           full source of the project + every transitive
//                          workspace dep (node_modules / .git / .vx / .turbo
//                          excluded)
//   <out>/json/          with --docker: manifests only (root files + each
//                          package's package.json) — COPY this layer first
//                          so `pnpm install` caches independently of source
//                          edits, then COPY full/ and build.
//
// Boundaries note: a package dir is copied WHOLE (minus the exclusions).
// vx's own nested-project input exclusions do not apply here — prune
// reproduces the tree, it does not hash it.
//
// RUNNABILITY IS NOT GUARANTEED, and this deliberately does not claim it.
// A config may import any path it likes; only imports that name a workspace
// PACKAGE can be resolved and pulled in. A relative import escaping its own
// package dir (`../../src/index.ts`, the shape this repo's own dogfooding
// configs use) reaches a file prune never copies, and no subset short of the
// whole tree would contain it. Those are reported at prune time — a warning
// the user reads now beats a module-not-found inside a docker build.
// The import scan is STATIC and deliberately simple: it sees `from '…'`,
// `import '…'` and `import('…')`, and nothing computed.

import { cp, mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  buildPackageGraph,
  findWorkspaceRoot,
  loadWorkspace,
  listProjects,
} from '../workspace/index.js'
import { UserError } from '../util/index.js'

interface PruneWorkspaceArgs {
  project?: string
  outDir: string
  docker: boolean
  error?: string
}

export function parsePruneWorkspaceArgs(args: readonly string[]): PruneWorkspaceArgs {
  const out: PruneWorkspaceArgs = { outDir: 'out', docker: false }
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
    if (a.startsWith('-')) return { ...out, error: `unknown flag: ${a}` }
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

export async function pruneWorkspaceCmd(args: readonly string[]): Promise<number> {
  const parsed = parsePruneWorkspaceArgs(args)
  if (parsed.error !== undefined) throw new UserError(`vx prune: ${parsed.error}`)
  if (parsed.project === undefined) {
    throw new UserError('vx prune: <project> required (e.g. vx prune @acme/api)')
  }

  const root = await findWorkspaceRoot(process.cwd())
  const workspace = await loadWorkspace(root)
  const projects = await listProjects(workspace)
  const byName = new Map(projects.map((p) => [p.name, p]))

  const target = byName.get(parsed.project)
  if (target === undefined) {
    const names = [...byName.keys()].sort()
    const q = parsed.project.toLowerCase()
    const near = names.filter((n) => n.toLowerCase().includes(q)).slice(0, 3)
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

  const outAbs = path.resolve(process.cwd(), parsed.outDir)
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

  const emitRoots = async (dest: string): Promise<void> => {
    await writeFile(path.join(dest, 'pnpm-workspace.yaml'), workspaceYaml)
    for (const f of [...ROOT_FILES, ...WORKSPACE_CONFIGS, ...LOCKFILES]) {
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
