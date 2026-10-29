// What a run is asked to run: the projects a `--filter` selects, the
// ones `--affected` touches (with the `workspaceFiles` owners), the project the
// cwd sits in, and the interactive picker. Every read of the workspace
// here goes through the staged load, so the answer is the run's.

import path from 'node:path'
import { settingEnv } from '../settings.js'
import fs from 'node:fs'
import {
  affectedChanges,
  type AffectedChanges,
  affectedProjects,
  headBase,
  applyFilters,
  buildPackageGraph,
  configuredBaseBranch,
  defaultAffectedBase,
  findProjectConfigs,
  findWorkspaceRoot,
  type FingerprintClaims,
  lockKey,
  NO_LOCK,
  parseFilter,
  PROJECT_CONFIG_FILENAMES,
  type ProjectMeta,
  readLockfile,
} from '../workspace/index.js'
import type { ProjectConfig } from '../config.js'
import type { ProjectEntry } from '../workspace/index.js'
import { isDefaultBuild, parseDependencySpec } from '../graph/index.js'
import { declaresInput, workspaceFilesReachInto } from '../cache/index.js'
import {
  isUserError,
  listed,
  maskedCommand,
  maskedLine,
  nearest,
  relPosix,
  UserError,
  sayNotice,
  ui,
} from '../util/index.js'
import {
  claimedAffected,
  claimedExtraFiles,
  fingerprintClaims,
  gitOfDiscovery,
  hasHook,
  keepDiscoveryGraph,
} from '../orchestrator/index.js'
import {
  type CliLoadOptions,
  discoverCliProjects,
  loadCliProjects,
  loadCliWorkspace,
  stageCacheDir,
} from './workspace-config.js'

/**
 * The projects whose tasks declare an `inputs.workspaceFiles` glob
 * matching a changed path, one inside another project included (item
 * 954): `--affected` selects them, since the glob is that task's input. Through the run
 * path's staged load, so a glob a `project` plugin gave a config-less
 * package counts; read from the lock as a run does. A load that fails drops to the lock's
 * entries, one by one — a project the lock does not hold does not fail a
 * scoped run, and must not fail its selection either.
 */
export async function workspaceGlobOwners(
  root: string,
  projects: readonly ProjectMeta[],
  changed: readonly string[],
  load: CliLoadOptions = {},
  stagedLoad: () => Promise<ReadonlyMap<string, ProjectEntry>> = () =>
    loadCliProjects(root, projects, 'all', load),
  /** The changed nested repositories (`AffectedChanges.nested`). */
  nested: readonly string[] = [],
): Promise<string[]> {
  const declaresMatch = (config: ProjectConfig): boolean => {
    for (const task of Object.values(config.tasks ?? {})) {
      if (changed.some((rel) => declaresInput(task, null, rel))) return true
      if (nested.some((dir) => workspaceFilesReachInto(task, dir))) return true
    }
    return false
  }
  try {
    const staged = await stagedLoad()
    return [...staged.values()].filter((p) => declaresMatch(p.config)).map((p) => p.name)
  } catch {
    // Fall through to the per-file sweep.
  }
  // No lock is refused here, before the tolerant sweep below could answer
  // "nothing affected" and exit 0 without ever reaching the run's own
  // refusal. The sweep reads each entry from the lock: it never evaluates.
  const lock = await readLockfile(root)
  if (lock === null) throw new UserError(NO_LOCK)
  const owners: string[] = []
  for (const meta of projects) {
    if (meta.configPath === null || meta.configPath === '') continue
    const dir = lockKey(root, meta.dir)
    if (!Object.hasOwn(lock.projects, dir)) continue
    try {
      if (declaresMatch(lock.projects[dir]!.config)) owners.push(meta.name)
    } catch {
      // A hand-edited entry that will not read cannot be shown to declare a
      // matching glob; surfacing it here would fail a run the load tolerates.
    }
  }
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
    cacheDir: stageCacheDir(ws, load),
    warn: (m: string) => ui.say('warn', maskedLine(m)),
    projects: projects.map((p) => ({ name: p.name, dir: p.dir })),
  }
  return {
    files: new Set(claims.keys()),
    affected: (change) => claimedAffected(claims.get(change.file)!, change, ctx),
    extraFiles: (file, bytes) => claimedExtraFiles(claims.get(file)!, file, bytes),
  }
}

async function loadWorkspaceProjects(cwd: string, load: CliLoadOptions): Promise<ProjectMeta[]> {
  return await discoverCliProjects(await findWorkspaceRoot(cwd), load)
}

/** `//#task`, Turbo's root package, as the root project's id: the name discovery gives it (D-39). */
export async function rootSpelled(root: string, target: string): Promise<string> {
  if (!target.startsWith('//#')) return target
  const name = await discoverCliProjects(root).then(
    (metas) => metas.find((m) => m.dir === root)?.name,
    () => undefined,
  )
  return name === undefined ? target : `${name}#${target.slice(3)}`
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
  load: CliLoadOptions = {},
): Promise<{ name: string; discovered: { root: string; projects: ProjectMeta[] } } | null> {
  const root = await findWorkspaceRoot(cwd)
  const projects = await discoverCliProjects(root, load)
  const abs = path.resolve(cwd)
  const within = (dirOf: (p: ProjectMeta) => string): { name: string; dir: string } | null => {
    let best: { name: string; dir: string } | null = null
    for (const p of projects) {
      const dir = dirOf(p)
      if ((abs === dir || abs.startsWith(dir + path.sep)) && dir.length > (best?.dir.length ?? -1))
        best = { name: p.name, dir }
    }
    return best
  }
  // The cwd is a real path (the kernel's), and a member discovery reached
  // through a link keeps the link's (`packages/b -> ../ext/b`, item 987),
  // so inside such a member nothing matched and a run from there was "not
  // inside a project" (item 1025). Only then are the members realpathed:
  // one syscall each, paid only by a run no plain match could place.
  const found =
    within((p) => p.dir) ??
    within((p) => {
      try {
        return fs.realpathSync(p.dir)
      } catch {
        return p.dir
      }
    })
  await refuseUnlockedConfig(root, abs, found?.dir ?? null)
  return found === null ? null : { name: found.name, discovered: { root, projects } }
}

/**
 * A config `vx lock` would find between the cwd and the project placing it
 * (the root, when none does): a config written after the lock is no project
 * yet, so a run from its directory ran the locked project above it (the
 * root's `build` for a new member) or said "not inside a project". One
 * readdir per directory between them, none from a project's own; the
 * listing that judges a config found is paid only when one is.
 */
async function refuseUnlockedConfig(
  root: string,
  abs: string,
  placed: string | null,
): Promise<void> {
  const top = placed ?? root
  if (abs !== top && !abs.startsWith(top + path.sep)) return
  for (let dir = abs; ; dir = path.dirname(dir)) {
    if (dir === placed) return
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      names = []
    }
    const file = PROJECT_CONFIG_FILENAMES.find((n) => names.includes(n))
    if (file !== undefined) {
      const { configs } = await findProjectConfigs(root)
      const config = configs.find((c) => c.dir === dir)
      if (config !== undefined) {
        throw new UserError(
          `${relPosix(root, config.configPath)} is not in the lock yet — run \`vx lock\``,
        )
      }
    }
    if (dir === root || dir === path.dirname(dir)) return
  }
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
  | Refusal
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

/** A refusal a resolver returns; `code` is the thrown one's own, when it has one. */
type Refusal = { error: string; code?: string }

function refusalOf(err: unknown): Refusal {
  if (!(err instanceof Error)) return { error: String(err) }
  return isUserError(err) && err.code !== 'VX_E_REFUSED'
    ? { error: err.message, code: err.code }
    : { error: err.message }
}

/**
 * The filter `--affected[=<base>]` stands for: `...[<base>]`, the changed
 * projects and their dependents. An empty base is `VX_AFFECTED_BASE`'s,
 * else a plugin's (`setBranch`: a pull request's base commit), else the
 * merge base with `baseBranch`.
 */
export async function affectedFilterFor(
  cwd: string,
  affected: string,
  /** What the verb does instead on the base branch (`defaultAffectedBase`). */
  instead?: string,
): Promise<string | Refusal> {
  const root = await findWorkspaceRoot(cwd)
  let base = affected || ((settingEnv('affectedBase') as string | undefined) ?? '')
  if (base === '') {
    const ws = await loadCliWorkspace(root)
    try {
      base =
        ws.branch.base ??
        (await defaultAffectedBase(root, configuredBaseBranch(ws.workspaceConfig), instead))
    } catch (err) {
      if (!isUserError(err)) throw err
      return refusalOf(err)
    }
  }
  return `...[${base}]`
}

export async function resolveFilters(
  cwd: string,
  raw: string[],
  load: CliLoadOptions = {},
  /** The raw filter `--affected` became: its diff is kept per path for the run. */
  affected?: string,
  /** The verb a warning names: `vx show` and `vx watch` select as a run does. */
  verb: 'run' | 'show' | 'watch' = 'run',
): Promise<FilterResolution> {
  const root = await findWorkspaceRoot(cwd)
  const projects = await loadWorkspaceProjects(cwd, load)
  let parsed: ReturnType<typeof parseFilter>[]
  try {
    parsed = raw.map((r) => parseFilter(r, root))
  } catch (err) {
    return refusalOf(err)
  }
  // `sinceViaDeps` (`e2e...[main]`) walks the changed projects' dependents.
  const walksGraph = parsed.some(
    (f) => f.withDeps || f.withDependents || f.onlyDeps || f.sinceViaDeps === true,
  )
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
      return refusalOf(err)
    }
  }
  // A tag lives in the config, so a `tag:` selector needs the staged load
  // (a `project` plugin may have given or edited the tags).
  let tags: Map<string, readonly string[]> | undefined
  if (parsed.some((f) => f.tag === true)) {
    try {
      tags = new Map([...(await stagedOnce()).values()].map((p) => [p.name, p.config.tags ?? []]))
    } catch (err) {
      return refusalOf(err)
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
        workspaceGlobOwners: (changed: readonly string[], nested: readonly string[]) =>
          workspaceGlobOwners(root, projects, changed, load, stagedOnce, nested),
        fingerprintClaims: () => workspaceFingerprintClaims(root, projects, load),
        ...(git !== undefined
          ? {
              untracked: async () => (await git.start()).untracked,
              // A scoped enumeration lists only its projects: null asks git.
              links: async () => {
                const g = await git.start()
                if (!g.scopes.includes('.')) return null
                const out: string[] = []
                for (const [rel, oid] of g.trusted) if (oid.startsWith('120000:')) out.push(rel)
                return out
              },
            }
          : {}),
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
      return refusalOf(err)
    }
  }

  const unmatched: string[] = []
  const emptyWalks: string[] = []
  // The `[<since>]` includes whose diff itself matched nothing: only then is
  // "nothing affected" the fact. A diff that matched, then lost every
  // project to an exclusion or an empty walk, says which (X-146).
  const emptyDiffs = new Set<(typeof parsed)[number]>()
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
      else emptyDiffs.add(f)
    },
    // A pattern that matched, with nothing on the walk it asked for: the
    // fact to say, where "no projects matched" read as a typo (item 1030).
    onEmptyWalk: (f, matched) => {
      if (f.negate) return
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
    // Every pattern matched and an exclusion took them all back: "no
    // projects matched filter(s): one, !one" read as a typo of `one`.
    const negations = parsed.filter((f) => f.negate).map((f) => f.raw)
    // With no include the base is every project: there is no "other filter".
    const excluded = `${negations.join(', ')} excluded every project${includes.length > 0 ? ' the other filters matched' : ''}`
    if (includes.length > 0 && includes.every((f) => f.gitSince !== undefined)) {
      if (includes.every((f) => emptyDiffs.has(f))) {
        const refs = [...new Set(includes.map((f) => f.gitSince))].join(', ')
        // A base that IS HEAD (a single-branch clone whose `origin/HEAD` is
        // the branch under test) can never mark anything affected, and this
        // exit-0 note was the only sign (CI persona, 2026-09-16). Say so.
        const self = includes.map((f) => headBase(root, f.gitSince!)).find((b) => b !== undefined)
        const hint =
          self === undefined
            ? ''
            : ` — ${self} is HEAD itself: compare with the branch you merge into (--affected=origin/main) or the previous commit (--affected=HEAD~1)`
        return { empty: `nothing affected since ${refs}${hint}` }
      }
      // The diff matched and a walk or an exclusion left nothing: still the
      // exit-0 outcome (`--affected --filter '!docs'` on a docs-only change
      // must not red CI), said as what happened (X-146).
      return {
        empty: `no projects selected: ${emptyWalks.length > 0 ? emptyWalks.join('; ') : excluded}`,
      }
    }
    if (unmatched.length === 0 && emptyWalks.length > 0) {
      return { error: `no projects selected: ${emptyWalks.join('; ')}` }
    }
    if (unmatched.length === 0 && negations.length > 0) {
      return { error: `no projects selected: ${excluded}` }
    }
    // One line, not a warning per pattern and then an error saying the same:
    // the patterns are in the error, and the nearest project name is the
    // hint a typo needs. Only the ones that matched nothing: `app !app apq` named
    // app, and `--affected` a `...[<base>]` nobody typed.
    const hint =
      (await unlockedHint(root, parsed, unmatched)) ?? didYouMean(unmatched, projects, tags)
    return { error: `no projects matched filter(s): ${unmatched.join(', ')}${hint}` }
  }
  // Something matched, so the run proceeds; a pattern that matched nothing
  // alongside it is still worth a line — it is probably a typo.
  for (const f of unmatched)
    sayNotice(
      'warn',
      `vx ${verb}`,
      `filter "${f}" matched no projects${(await unlockedHint(root, parsed, [f])) ?? didYouMean([f], projects, tags)}`,
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

interface PickedTask {
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
  /** The projects `--filter` / `--affected` selected; every project when absent. */
  only?: ReadonlySet<string>,
): Promise<PickedTask | null | 'interrupted'> {
  const projects = await loadWorkspaceProjects(cwd, load)
  // The staged load: a task a `project` plugin gave a config-less package
  // is on the menu, as it is in a run.
  const staged = await loadCliProjects(await findWorkspaceRoot(cwd), projects, 'all', load)
  const entries: PickedTask[] = []
  for (const meta of projects) {
    if (only !== undefined && !only.has(meta.name)) continue
    const config = staged.get(meta.name)?.config
    if (config === undefined) continue
    const taskNames = Object.keys(config.tasks ?? {})
      .filter((t) => !isDefaultBuild(config.tasks?.[t]))
      .sort()
    for (const t of taskNames) {
      const task = config.tasks?.[t]
      const desc =
        task?.description === undefined
          ? undefined
          : maskedCommand(task.description, task.exec?.env)
      entries.push({ project: meta.name, task: t, ...(desc ? { description: desc } : {}) })
    }
  }
  if (entries.length === 0 && only !== undefined) {
    sayNotice(
      'error',
      'vx run',
      `no tasks declared in the selected projects (${[...only].sort().join(', ')})`,
    )
    return null
  }
  if (entries.length === 0) {
    sayNotice(
      'error',
      'vx run',
      'no tasks declared in any project. Declare one under `tasks` in a vx.config, or run `vx init` to write them from package.json scripts, then `vx lock`',
    )
    return null
  }
  // The menu is a conversation with the terminal, not the run's output: on
  // stdout, `vx run > out.txt` put it in the file and asked a blank screen.
  const out = io.output ?? process.stderr
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
    output: out,
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
      sayNotice('info', 'vx run', 'no task picked')
      return null
    }
    const n = Number(answer)
    if (!Number.isInteger(n) || n < 1 || n > entries.length) {
      sayNotice(
        'error',
        'vx run',
        `invalid selection: ${answer} (type a number from 1 to ${entries.length})`,
      )
      return null
    }
    return entries[n - 1] ?? null
  } finally {
    rl.close()
  }
}

/**
 * `. packages/c/vx.config.ts is not in the lock yet — run \`vx lock\``
 * for an unmatched `./dir` filter naming a directory `vx lock` would make
 * a project: a config written after the lock is none yet, and "Projects:
 * …" without it read as a typo of the path. Asked on the refusal's path only.
 */
async function unlockedHint(
  root: string,
  parsed: readonly ReturnType<typeof parseFilter>[],
  unmatched: readonly string[],
): Promise<string | undefined> {
  const dirs = parsed
    .filter((f) => f.isPath && f.pathGlob === undefined && unmatched.includes(f.raw))
    .map((f) => f.matcher)
  if (dirs.length === 0) return undefined
  const { configs } = await findProjectConfigs(root)
  const config = configs.find((c) => dirs.includes(c.dir))
  if (config === undefined) return undefined
  return `. ${relPosix(root, config.configPath)} is not in the lock yet — run \`vx lock\``
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
  // A scoped name typed without its scope (`vx-otel` for `@vzn/vx-otel`) is
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
      return '. `//` is the workspace root, which is no project here: add a vx.config there and run `vx lock`'
    }
    // Nx's `--projects=a,b`: the edit distance hinted the first name alone.
    const parts = pattern.split(',').filter((p) => p !== '')
    if (parts.length > 1) {
      return `. A filter is one pattern: ${parts.map((p) => `--filter ${p}`).join(' ')}`
    }
    const best = nearest(typed, names)
    if (best !== undefined) return `. Did you mean ${best}?`
    const bare = byBare.has(typed) ? typed : nearest(typed, byBare.keys())
    const scoped = bare === undefined ? undefined : byBare.get(bare)
    if (scoped?.length === 1) return `. Did you mean ${scoped[0]}?`
  }
  return names.length === 0 ? '' : `. Projects: ${listed(names)}`
}
