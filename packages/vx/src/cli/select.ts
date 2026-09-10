// What a run is asked to run: the projects a `--filter` selects, the
// ones `--affected` touches (with the orphan-path owners), the project the
// cwd sits in, and the interactive picker. Every read of the workspace
// here goes through the staged load, so the answer is the run's.

import readline from 'node:readline/promises'
import path from 'node:path'
import {
  affectedProjects,
  applyFilters,
  buildPackageGraph,
  findWorkspaceRoot,
  type FingerprintClaims,
  FROZEN_WITHOUT_LOCK,
  listProjects,
  loadProjectConfig,
  loadWorkspace,
  parseFilter,
  type ProjectMeta,
  readLockfile,
  workspaceGlobsMatch,
} from '../workspace/index.js'
import type { ProjectConfig } from '../config.js'
import { nearest, UserError } from '../util/index.js'
import { claimedAffected, fingerprintClaims } from '../orchestrator/index.js'
import { type CliLoadOptions, loadCliProjects, loadCliWorkspace } from './workspace-config.js'

/**
 * The projects whose tasks declare a `cache.inputs.workspaceFiles` glob
 * matching an ORPHAN changed path (one no project owns): `--affected`
 * selects them, since the glob is that task's input. Through the run
 * path's staged load, so a glob a `project` plugin gave a config-less
 * package counts; evaluated live as a default run does, or read from the
 * lock as a `--frozen` run does. A load that fails drops to the config files that
 * do load, one by one — a broken out-of-scope config does not fail a
 * scoped run, and must not fail its selection either.
 */
export async function workspaceGlobOwners(
  root: string,
  projects: readonly ProjectMeta[],
  orphans: readonly string[],
  load: CliLoadOptions = {},
): Promise<string[]> {
  const declaresMatch = (config: ProjectConfig): boolean => {
    for (const task of Object.values(config.tasks ?? {})) {
      const globs = task.cache?.inputs?.workspaceFiles
      if (globs === undefined) continue
      if (orphans.some((rel) => workspaceGlobsMatch(globs, rel))) return true
    }
    return false
  }
  // A frozen run with no lock is refused here, before the tolerant sweep
  // below could answer "nothing affected" and exit 0 without ever reaching
  // the run's own refusal.
  if (load.frozen === true && (await readLockfile(root)) === null) {
    throw new UserError(FROZEN_WITHOUT_LOCK)
  }
  try {
    const staged = await loadCliProjects(root, projects, 'all', load)
    return [...staged.values()].filter((p) => declaresMatch(p.config)).map((p) => p.name)
  } catch {
    // Fall through to the per-file sweep.
  }
  const owners: string[] = []
  await Promise.all(
    projects.map(async (meta) => {
      if (meta.configPath === null || meta.configPath === '') return
      try {
        if (declaresMatch(await loadProjectConfig(meta.configPath))) owners.push(meta.name)
      } catch {
        // A config that will not load cannot be shown to declare a matching
        // glob; surfacing it here would fail a run the loader itself tolerates.
      }
    }),
  )
  return owners
}

/**
 * The fingerprint files the workspace's plugins claim, with each claimant
 * asked through the same host the run uses — so a bad answer is refused by
 * the plugin's name here exactly as it would be at key time.
 */
async function workspaceFingerprintClaims(
  root: string,
  projects: readonly ProjectMeta[],
  load: CliLoadOptions,
): Promise<FingerprintClaims> {
  const ws = await loadCliWorkspace(root)
  const claims = fingerprintClaims(ws.plugins)
  const ctx = {
    workspaceRoot: root,
    cacheDir: load.cacheDir ?? ws.cacheDir,
    warn: (m: string) => process.stderr.write(`${m}\n`),
    projects: projects.map((p) => ({ name: p.name, dir: p.dir })),
  }
  return {
    files: new Set(claims.keys()),
    affected: (change) => claimedAffected(claims.get(change.file)!, change, ctx),
  }
}

export async function loadWorkspaceProjects(cwd: string): Promise<ProjectMeta[]> {
  const root = await findWorkspaceRoot(cwd)
  const ws = await loadWorkspace(root)
  return await listProjects(ws)
}

export async function findCwdProject(cwd: string): Promise<string | null> {
  const projects = await loadWorkspaceProjects(cwd)
  const abs = path.resolve(cwd)
  let best: ProjectMeta | null = null
  for (const p of projects) {
    if (abs === p.dir || abs.startsWith(p.dir + path.sep)) {
      if (!best || p.dir.length > best.dir.length) best = p
    }
  }
  return best?.name ?? null
}

export type FilterResolution = { names: string[] } | { error: string } | { empty: string }

export async function resolveFilters(
  cwd: string,
  raw: string[],
  load: CliLoadOptions = {},
): Promise<FilterResolution> {
  const root = await findWorkspaceRoot(cwd)
  const projects = await loadWorkspaceProjects(cwd)
  const graph = buildPackageGraph(projects)
  const parsed = raw.map((r) => parseFilter(r, root))

  // Resolve every `[<since>]` filter against git before the pure
  // applyFilters pass runs. One spawn per distinct ref — usually
  // there's only one anyway.
  const affectedByFilter = new Map<(typeof parsed)[number], Set<string>>()
  for (const f of parsed) {
    if (f.gitSince === undefined) continue
    try {
      const names = await affectedProjects({
        workspaceRoot: root,
        since: f.gitSince,
        projects,
        workspaceGlobOwners: (orphans) => workspaceGlobOwners(root, projects, orphans, load),
        fingerprintClaims: () => workspaceFingerprintClaims(root, projects, load),
      })
      affectedByFilter.set(f, names)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: msg }
    }
  }

  const unmatched: string[] = []
  const selected = applyFilters({
    filters: parsed,
    projects,
    graph,
    affectedByFilter,
    // A `[<since>]` selector matching nothing is the ordinary "nothing
    // changed" outcome, reported below; only a name/path pattern that
    // matched nothing is worth flagging as a probable typo.
    onNoMatch: (f) => {
      if (f.gitSince === undefined) unmatched.push(f.raw)
    },
  })
  if (selected.size === 0) {
    // "Nothing changed" is a legitimate outcome, not a typo — a docs-only
    // commit must not red `vx run … --affected=origin/main`. Only report an
    // error when the user named something concrete that failed to resolve.
    const includes = parsed.filter((f) => !f.negate)
    if (includes.length > 0 && includes.every((f) => f.gitSince !== undefined)) {
      const refs = includes.map((f) => f.gitSince).join(', ')
      return { empty: `nothing affected since ${refs}` }
    }
    // One line, not a warning per pattern and then an error saying the same:
    // the patterns are in the error, and the nearest project name is the
    // hint a typo needs.
    return {
      error: `no projects matched filter(s): ${raw.join(', ')}${didYouMeanProject(unmatched, projects)}`,
    }
  }
  // Something matched, so the run proceeds; a pattern that matched nothing
  // alongside it is still worth a line — it is probably a typo.
  for (const f of unmatched) process.stderr.write(`vx: filter "${f}" matched no projects\n`)
  return { names: [...selected].sort() }
}

export interface PickedTask {
  project: string
  task: string
  description?: string
}

export async function pickTask(
  cwd: string,
  io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
  load: CliLoadOptions = {},
): Promise<PickedTask | null> {
  const projects = await loadWorkspaceProjects(cwd)
  // The staged load: a task a `project` plugin gave a config-less package
  // is on the menu, as it is in a run.
  const staged = await loadCliProjects(await findWorkspaceRoot(cwd), projects, 'all', load)
  const entries: PickedTask[] = []
  for (const meta of projects) {
    const config = staged.get(meta.name)?.config
    if (config === undefined) continue
    const taskNames = Object.keys(config.tasks ?? {}).sort()
    for (const t of taskNames) {
      const desc = config.tasks?.[t]?.description
      entries.push({ project: meta.name, task: t, ...(desc ? { description: desc } : {}) })
    }
  }
  if (entries.length === 0) {
    process.stderr.write(`vx run: no tasks declared in any project\n`)
    return null
  }
  const out = io.output ?? process.stdout
  const numW = String(entries.length).length
  const idW = Math.max(...entries.map((e) => `${e.project}#${e.task}`.length))
  out.write('Tasks:\n')
  entries.forEach((e, i) => {
    const n = String(i + 1).padStart(numW, ' ')
    const id = `${e.project}#${e.task}`.padEnd(idW)
    const desc = e.description ? `  ${e.description}` : ''
    out.write(`  ${n}. ${id}${desc}\n`)
  })
  const rl = readline.createInterface({
    input: io.input ?? process.stdin,
    output: io.output ?? process.stdout,
  })
  try {
    const answer = (await rl.question(`Pick a task [1-${entries.length}]: `)).trim()
    const n = Number(answer)
    if (!Number.isInteger(n) || n < 1 || n > entries.length) {
      process.stderr.write(`vx run: invalid selection: ${answer}\n`)
      return null
    }
    return entries[n - 1] ?? null
  } finally {
    rl.close()
  }
}

/** `. Did you mean @acme/app?` for the first unmatched pattern within two edits of a project name. */
function didYouMeanProject(
  unmatched: readonly string[],
  projects: Iterable<{ name: string }>,
): string {
  const names = [...projects].map((p) => p.name)
  for (const pattern of unmatched) {
    const best = nearest(pattern.replace(/^!|\.\.\.$|^\.\.\.|\^/g, ''), names)
    if (best !== undefined) return `. Did you mean ${best}?`
  }
  return ''
}
