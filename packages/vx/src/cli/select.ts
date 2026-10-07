// What a run is asked to run: the projects a `--filter` selects, the
// ones `--affected` touches (with the `workspaceFiles` owners), the project the
// cwd sits in, and the interactive picker. Every read of the workspace
// here goes through the staged load, so the answer is the run's.

import path from 'node:path'
import fs from 'node:fs'
import {
  affectedChanges,
  type AffectedChanges,
  affectedProjects,
  refIsHead,
  applyFilters,
  buildPackageGraph,
  findWorkspaceRoot,
  type LoadReads,
  type FingerprintClaims,
  FROZEN_WITHOUT_LOCK,
  loadProjectConfig,
  loadWorkspace,
  parseFilter,
  type ProjectMeta,
  readLockfile,
} from '../workspace/index.js'
import type { ProjectConfig } from '../config.js'
import type { ProjectEntry } from '../workspace/index.js'
import { parseDependencySpec } from '../graph/index.js'
import { declaresInput } from '../cache/index.js'
import { listed, maskedLine, nearest, UserError } from '../util/index.js'
import {
  claimedAffected,
  fingerprintClaims,
  gitOfDiscovery,
  hasHook,
  isDefaultBuild,
  keepDiscoveryGraph,
} from '../orchestrator/index.js'
import {
  type CliLoadOptions,
  discoverCliProjects,
  loadCliProjects,
  loadCliWorkspace,
} from './workspace-config.js'

/**
 * The projects whose tasks declare a `cache.inputs.workspaceFiles` glob
 * matching a changed path, one inside another project included (item
 * 954): `--affected` selects them, since the glob is that task's input. Through the run
 * path's staged load, so a glob a `project` plugin gave a config-less
 * package counts; evaluated live as a default run does, or read from the
 * lock as a `--frozen` run does. A load that fails drops to the config files that
 * do load, one by one — a broken out-of-scope config does not fail a
 * scoped run, and must not fail its selection either.
 */
export async function workspaceGlobOwners(
  root: string,
  projects: readonly ProjectMeta[],
  changed: readonly string[],
  load: CliLoadOptions = {},
  stagedLoad: () => Promise<ReadonlyMap<string, ProjectEntry>> = () =>
    loadCliProjects(root, projects, 'all', load),
): Promise<string[]> {
  const declaresMatch = (config: ProjectConfig): boolean => {
    for (const task of Object.values(config.tasks ?? {})) {
      const cache = task.cache
      if (cache === undefined) continue
      if (changed.some((rel) => declaresInput(cache, null, rel))) return true
    }
    return false
  }
  try {
    const staged = await stagedLoad()
    return [...staged.values()].filter((p) => declaresMatch(p.config)).map((p) => p.name)
  } catch {
    // Fall through to the per-file sweep.
  }
  // A frozen run with no lock is refused here, before the tolerant sweep
  // below could answer "nothing affected" and exit 0 without ever reaching
  // the run's own refusal. Asked only once the staged load failed: a
  // frozen load that succeeded read the lock, and a second read parsed it
  // again (1,000 projects: a 1.1 MB lock, ~10 ms).
  if (load.frozen === true && (await readLockfile(root)) === null) {
    throw new UserError(FROZEN_WITHOUT_LOCK)
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
    warn: (m: string) => process.stderr.write(`${maskedLine(m)}\n`),
    projects: projects.map((p) => ({ name: p.name, dir: p.dir })),
  }
  return {
    files: new Set(claims.keys()),
    affected: (change) => claimedAffected(claims.get(change.file)!, change, ctx),
  }
}

async function loadWorkspaceProjects(cwd: string): Promise<ProjectMeta[]> {
  const reads: LoadReads = new Map()
  const root = await findWorkspaceRoot(cwd, reads)
  return await discoverCliProjects(await loadWorkspace(root, reads))
}

export async function findCwdProject(cwd: string): Promise<string | null> {
  return (await findCwdSelection(cwd))?.name ?? null
}

/**
 * The project `cwd` is in, and the discovery that found it, for the run to
 * reuse (`RunOptions.discovered`): discovering again ran every `discover`
 * hook twice (`nx()`'s graph load and worktree key among them).
 */
export async function findCwdSelection(
  cwd: string,
): Promise<{ name: string; discovered: { root: string; projects: ProjectMeta[] } } | null> {
  const reads: LoadReads = new Map()
  const root = await findWorkspaceRoot(cwd, reads)
  const projects = await discoverCliProjects(await loadWorkspace(root, reads))
  const abs = path.resolve(cwd)
  const within = (dirOf: (p: ProjectMeta) => string): string | null => {
    let best: string | null = null
    let bestLength = -1
    for (const p of projects) {
      const dir = dirOf(p)
      if ((abs === dir || abs.startsWith(dir + path.sep)) && dir.length > bestLength) {
        best = p.name
        bestLength = dir.length
      }
    }
    return best
  }
  // The cwd is a real path (the kernel's), and a member discovery reached
  // through a link keeps the link's (`packages/b -> ../ext/b`, item 987),
  // so inside such a member nothing matched and a run from there was "not
  // inside a project" (item 1025). Only then are the members realpathed:
  // one syscall each, paid only by a run no plain match could place.
  const name =
    within((p) => p.dir) ??
    within((p) => {
      try {
        return fs.realpathSync(p.dir)
      } catch {
        return p.dir
      }
    })
  return name === null ? null : { name, discovered: { root, projects } }
}

export type FilterResolution =
  | {
      names: string[]
      /** An include filter was a git diff (`[ref]`, `--affected`): `RunOptions.selectedByDiff`. */
      byDiff: boolean
      /** The staged load the graph walk needed, for the run to reuse (`RunOptions.staged`). */
      staged?: ReadonlyMap<string, ProjectEntry>
      /** The discovery this pass made, for the run to reuse (`RunOptions.discovered`). */
      discovered: { root: string; projects: ProjectMeta[] }
      /** The `affected` filter's diff, for the run to seed its tasks from (`RunOptions.affected`). */
      affected?: AffectedChanges
      /** What the other includes selected (`RunOptions.selectedOutright`). */
      outright?: string[]
    }
  | { error: string }
  | { empty: string }

/**
 * The cross-project `dependsOn` edges the configs declare, project → the
 * projects it names (`dependsOn: ['app#build']` makes `app` a dependency
 * of the declaring project). Read from the staged load — the same configs
 * the run will use — only when a filter walks the graph (`...`, `^...`).
 * A spec the loader will reject is skipped here; the run reports it.
 */
export async function taskEdges(
  root: string,
  projects: readonly ProjectMeta[],
  load: CliLoadOptions,
): Promise<{ edges: Map<string, string[]>; staged: Map<string, ProjectEntry> }> {
  const staged = await loadCliProjects(root, projects, 'all', load)
  return { edges: taskEdgesFrom(staged), staged }
}

/** The same edges, read from a load the caller already has. */
export function taskEdgesFrom(staged: ReadonlyMap<string, ProjectEntry>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const p of staged.values()) {
    const targets = new Set<string>()
    for (const task of Object.values(p.config.tasks ?? {})) {
      for (const raw of task.dependsOn ?? []) {
        let spec
        try {
          spec = parseDependencySpec(raw)
        } catch {
          continue
        }
        if (spec.kind === 'cross' && !spec.negated && spec.project !== p.name) {
          targets.add(spec.project)
        }
      }
    }
    if (targets.size > 0) out.set(p.name, [...targets].sort())
  }
  return out
}

export async function resolveFilters(
  cwd: string,
  raw: string[],
  load: CliLoadOptions = {},
  /** The raw filter `--affected` became: its diff is kept per path for the run. */
  affected?: string,
): Promise<FilterResolution> {
  const root = await findWorkspaceRoot(cwd)
  const projects = await loadWorkspaceProjects(cwd)
  let parsed: ReturnType<typeof parseFilter>[]
  try {
    parsed = raw.map((r) => parseFilter(r, root))
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  const walksGraph = parsed.some((f) => f.withDeps || f.withDependents || f.onlyDeps)
  // A filter that diffs against git starts the run's whole-tree walk now:
  // the diff reads its untracked files from it (one walk where it spawned
  // its own), and the run reuses it with the discovery (I-26).
  const git = parsed.some((f) => f.gitSince !== undefined) ? gitOfDiscovery(projects) : undefined
  void git?.start()
  // Every reader of the staged configs in this pass — the `pkg#task`
  // edge walk, the `workspaceFiles` owners of a changed path — shares
  // ONE load, and the run reuses it (`RunOptions.staged`): the `project`
  // stage runs once per project per run.
  let stagedPromise: Promise<Map<string, ProjectEntry>> | undefined
  const stagedOnce = (): Promise<Map<string, ProjectEntry>> =>
    (stagedPromise ??= loadCliProjects(root, projects, 'all', load))
  let edges: Map<string, string[]> | undefined
  if (walksGraph) {
    try {
      edges = taskEdgesFrom(await stagedOnce())
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }
  // A tag lives in the config, so a `tag:` selector needs the staged load
  // (a `project` plugin may have given or edited the tags).
  let tags: Map<string, readonly string[]> | undefined
  if (parsed.some((f) => f.tag === true)) {
    try {
      tags = new Map([...(await stagedOnce()).values()].map((p) => [p.name, p.config.tags ?? []]))
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }
  const graph = buildPackageGraph(projects, edges)
  // The graph a run reusing this discovery builds is this one when no task
  // edge went into it.
  if (edges === undefined) keepDiscoveryGraph(projects, graph)

  // Resolve every `[<since>]` filter against git before the pure
  // applyFilters pass runs. One spawn per distinct ref — usually
  // there's only one anyway.
  const affectedByFilter = new Map<(typeof parsed)[number], Set<string>>()
  let changes: AffectedChanges | undefined
  for (const f of parsed) {
    if (f.gitSince === undefined) continue
    try {
      const args = {
        workspaceRoot: root,
        since: f.gitSince,
        projects,
        workspaceGlobOwners: (changed: readonly string[]) =>
          workspaceGlobOwners(root, projects, changed, load, stagedOnce),
        fingerprintClaims: () => workspaceFingerprintClaims(root, projects, load),
        taskEdges: async () => edges ?? taskEdgesFrom(await stagedOnce()),
        ...(git !== undefined ? { untracked: async () => (await git.start()).untracked } : {}),
      }
      let names: Set<string>
      if (f.raw === affected) {
        changes = await affectedChanges(args)
        names = changes.projects
        // A `graph` plugin may tie any task to a changed path (an edge, an
        // input), and the run alone builds that graph: every project is a
        // candidate, and the run keeps the tasks its final graph reaches.
        if (
          changes.changed.length > 0 &&
          hasHook((await loadCliWorkspace(root)).plugins, 'graph')
        ) {
          names = new Set(projects.map((p) => p.name))
        }
      } else {
        names = await affectedProjects(args)
      }
      affectedByFilter.set(f, names)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { error: msg }
    }
  }

  const unmatched: string[] = []
  const emptyWalks: string[] = []
  const selected = applyFilters({
    filters: parsed,
    projects,
    graph,
    affectedByFilter,
    ...(tags !== undefined ? { tags } : {}),
    // A `[<since>]` selector matching nothing is the ordinary "nothing
    // changed" outcome, reported below; only a name/path pattern that
    // matched nothing is worth flagging as a probable typo.
    onNoMatch: (f) => {
      if (f.gitSince === undefined) unmatched.push(f.raw)
    },
    // A pattern that matched, with nothing on the walk it asked for: the
    // fact to say, where "no projects matched" read as a typo (item 1030).
    onEmptyWalk: (f, matched) => {
      if (f.negate || f.gitSince !== undefined) return
      const which = matched.join(', ')
      emptyWalks.push(
        f.onlyDeps
          ? `filter "${f.raw}" matched ${which}, which depends on no project`
          : `filter "${f.raw}" matched ${which}, and no project depends on it`,
      )
    },
  })
  if (selected.size === 0) {
    // "Nothing changed" is a legitimate outcome, not a typo — a docs-only
    // commit must not red `vx run … --affected=origin/main`. Only report an
    // error when the user named something concrete that failed to resolve.
    const includes = parsed.filter((f) => !f.negate)
    if (includes.length > 0 && includes.every((f) => f.gitSince !== undefined)) {
      const refs = includes.map((f) => f.gitSince).join(', ')
      // A base that IS HEAD (a single-branch clone whose `origin/HEAD` is
      // the branch under test) can never mark anything affected, and this
      // exit-0 note was the only sign (CI persona, 2026-09-16). Say so.
      const self = includes.find((f) => refIsHead(root, f.gitSince!))
      const hint =
        self === undefined
          ? ''
          : ` — ${self.gitSince} is HEAD itself: compare with the branch you merge into (--affected=origin/main) or the previous commit (--affected=HEAD~1)`
      return { empty: `nothing affected since ${refs}${hint}` }
    }
    if (unmatched.length === 0 && emptyWalks.length > 0) {
      return { error: `no projects selected: ${emptyWalks.join('; ')}` }
    }
    // Every pattern matched and an exclusion took them all back: "no
    // projects matched filter(s): one, !one" read as a typo of `one`.
    const negations = parsed.filter((f) => f.negate).map((f) => f.raw)
    if (unmatched.length === 0 && negations.length > 0) {
      return {
        error: `no projects selected: ${negations.join(', ')} excluded every project the other filters matched`,
      }
    }
    // One line, not a warning per pattern and then an error saying the same:
    // the patterns are in the error, and the nearest project name is the
    // hint a typo needs.
    return {
      error: `no projects matched filter(s): ${raw.join(', ')}${didYouMean(unmatched, projects, tags)}`,
    }
  }
  // Something matched, so the run proceeds; a pattern that matched nothing
  // alongside it is still worth a line — it is probably a typo.
  for (const f of unmatched)
    process.stderr.write(
      `vx: filter "${f}" matched no projects${didYouMean([f], projects, tags)}\n`,
    )
  // Each include is a union: what `--filter other` selected runs its tasks
  // whether or not the `--affected` diff reaches them, and an exclude
  // still removes it (X-10).
  const others = parsed.filter((f) => f.negate || f.raw !== affected)
  const outright =
    changes !== undefined && others.some((f) => !f.negate)
      ? [
          ...applyFilters({
            filters: others,
            projects,
            graph,
            affectedByFilter,
            ...(tags !== undefined ? { tags } : {}),
          }),
        ].filter((n) => selected.has(n))
      : []
  let staged: Map<string, ProjectEntry> | undefined
  if (stagedPromise !== undefined) {
    try {
      staged = await stagedPromise
    } catch {
      // The owners walk fell through to its per-file sweep; the run loads for itself.
      staged = undefined
    }
  }
  return {
    names: [...selected].sort(),
    byDiff: parsed.some((f) => !f.negate && f.gitSince !== undefined),
    ...(staged !== undefined ? { staged } : {}),
    discovered: { root, projects },
    ...(changes !== undefined ? { affected: changes } : {}),
    ...(outright.length > 0 ? { outright: outright.sort() } : {}),
  }
}

export interface PickedTask {
  project: string
  task: string
  description?: string
}

/**
 * The task the user picks from a numbered menu; null when nothing was
 * picked (said on stderr), `'interrupted'` for a Ctrl-C at the prompt.
 */
export async function pickTask(
  cwd: string,
  io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
  load: CliLoadOptions = {},
): Promise<PickedTask | null | 'interrupted'> {
  const projects = await loadWorkspaceProjects(cwd)
  // The staged load: a task a `project` plugin gave a config-less package
  // is on the menu, as it is in a run.
  const staged = await loadCliProjects(await findWorkspaceRoot(cwd), projects, 'all', load)
  const entries: PickedTask[] = []
  for (const meta of projects) {
    const config = staged.get(meta.name)?.config
    if (config === undefined) continue
    const taskNames = Object.keys(config.tasks ?? {})
      .filter((t) => !isDefaultBuild(config.tasks?.[t]))
      .sort()
    for (const t of taskNames) {
      const desc = config.tasks?.[t]?.description
      entries.push({ project: meta.name, task: t, ...(desc ? { description: desc } : {}) })
    }
  }
  if (entries.length === 0) {
    process.stderr.write(
      'vx run: no tasks declared in any project; declare one under `tasks` in a vx.config, or run `vx init` to write them from package.json scripts\n',
    )
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
  // Imported here, the picker's one use: a run that never asks paid ~0.7 ms
  // for it at every start, past the stdout stream it shares code with.
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({
    input: io.input ?? process.stdin,
    output: io.output ?? process.stdout,
  })
  // On a terminal readline takes Ctrl-C and Ctrl-D itself, raw, and
  // rejects the pending question with an AbortError — which reached the
  // user as `vx: AbortError: Aborted with Ctrl+C` and a stack, exit 1.
  // A SIGINT listener tells the two apart: Ctrl-C is an interrupt (exit 130,
  // as a run's), Ctrl-D an answer that never came.
  const abort = new AbortController()
  let interrupted = false
  rl.on('SIGINT', () => {
    interrupted = true
    abort.abort()
  })
  try {
    let answer: string
    try {
      answer = (
        await rl.question(`Pick a task [1-${entries.length}]: `, { signal: abort.signal })
      ).trim()
    } catch (err) {
      if (!(err instanceof Error) || err.name !== 'AbortError') throw err
      if (interrupted) return 'interrupted'
      out.write('\n')
      process.stderr.write(`vx run: no task picked\n`)
      return null
    }
    const n = Number(answer)
    if (!Number.isInteger(n) || n < 1 || n > entries.length) {
      process.stderr.write(
        `vx run: invalid selection: ${answer} (type a number from 1 to ${entries.length})\n`,
      )
      return null
    }
    return entries[n - 1] ?? null
  } finally {
    rl.close()
  }
}

/** The hint for the first unmatched pattern: a near tag for a `tag:` one, else a near project name. */
function didYouMean(
  unmatched: readonly string[],
  projects: Iterable<{ name: string }>,
  tags: ReadonlyMap<string, readonly string[]> | undefined,
): string {
  const first = unmatched[0]?.replace(/^!|\.\.\.$|^\.\.\.|\^/g, '')
  if (first?.startsWith('tag:') !== true) return didYouMeanProject(unmatched, projects)
  const known = [...new Set([...(tags?.values() ?? [])].flat())].sort()
  if (known.length === 0) return '. No project declares tags'
  const best = nearest(first.slice(4), known)
  return best !== undefined ? `. Did you mean tag:${best}?` : `. Tags: ${listed(known)}`
}

/** `. Did you mean @acme/app?` for the first unmatched pattern within two edits of a project name. */
function didYouMeanProject(
  unmatched: readonly string[],
  projects: Iterable<{ name: string }>,
): string {
  const names = [...projects].map((p) => p.name)
  // A scoped name typed without its scope (`vx-mcp` for `@vzn/vx-mcp`) is
  // many edits from the whole name and none from the part after the `/`.
  const byBare = new Map<string, string[]>()
  for (const n of names) {
    const bare = n.slice(n.indexOf('/') + 1)
    if (bare !== n) byBare.set(bare, [...(byBare.get(bare) ?? []), n])
  }
  for (const pattern of unmatched) {
    const typed = pattern.replace(/^!|\.\.\.$|^\.\.\.|\^/g, '')
    // Two edits from any two-letter name: `--filter //` hinted `ui` (X-13).
    if (typed === '//') {
      return ". `//` is Turbo's root package, but the workspace root is no project here: give it a package.json name and a vx.config"
    }
    const best = nearest(typed, names)
    if (best !== undefined) return `. Did you mean ${best}?`
    const bare = byBare.has(typed) ? typed : nearest(typed, byBare.keys())
    const scoped = bare === undefined ? undefined : byBare.get(bare)
    if (scoped?.length === 1) return `. Did you mean ${scoped[0]}?`
  }
  return names.length === 0 ? '' : `. Projects: ${listed(names)}`
}
