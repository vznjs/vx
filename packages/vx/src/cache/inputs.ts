// Resolve declared inputs into what the key folds: input files (hashed) and
// `inputs.env` values (undefined when unset). `inputs.env` tracks the key;
// `exec.env` decides what reaches the child.
//
// File enumeration defers to git (git-inputs.ts), so every ignore rule applies;
// `inputs.files` globs filter that set. A git work tree is required.

import path from 'node:path'
import {
  chmodSync,
  type Dirent,
  lstatSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { rm, rmdir } from 'node:fs/promises'
import type { InputsConfig, TaskConfig } from '../config.js'
import {
  appendTail,
  createTail,
  literalPath,
  anyTaskGlob,
  tailText,
  asTrees,
  isExecutableMissing,
  isInstalledPath,
  isLiteralPattern,
  normalizeGlob,
  outputMatcher,
  outputExcluded,
  realpathOf,
  relPosix,
  restorableOutput,
  shellArgv,
  slashBraceExpansions,
  braceAlternatives,
  ESSENTIAL_ENV,
  ownEnv,
  POST_EXIT_DRAIN_MS,
  splitNegations,
  staticPrefix,
  treeRoot,
  stripTrailingSlash,
  taskGlob,
  UserError,
  writableUnder,
  withoutWorkspaceBins,
} from '../util/index.js'
import {
  GitFilesCache,
  listingEnv,
  lstatOrAbsent,
  newFilesIgnoredIn,
  runGitLsFiles,
} from './git-inputs.js'
import { FILE_HASH_RACY_MS, racyWindowMs } from '../memo/index.js'

// git-inputs.ts's surface, re-exported for readers that reach it through here.
export {
  GitFilesCache,
  populateGitFilesCache,
  runGitLsFiles,
  startGitEnumeration,
  applyGitEnumeration,
  gitPathspecs,
  autocrlfConverts,
  gitStatWeakened,
  attributeFilesOutsideTree,
  type GitEnumeration,
} from './git-inputs.js'

// vx's own files are never task inputs, or a re-lock would move every `**`
// reader's key. Relative to the project, so only where vx writes them: a
// project's own `src/.vx/` stays an input. `node_modules` is not listed: the
// enumeration drops untracked files under one, and a tracked one is a source.
const ALWAYS_IGNORE = [
  // A backstop: git never reports a path under `.git`, so this keeps a
  // repository's object store out of a key only if an enumeration ever stops
  // going through git.
  '.git/**',
  // vx's machine-local state; the workspace config beside it is a source.
  '.vx/cache/**',
  '.vx/projects.lock.json',
  // `vx lock`'s review copy: the config is keyed already.
  'vx.lock.json',
  // What `vx lock` and `vx init` write beside the lock: a re-lock must not
  // select every `**` reader under --affected.
  '.vx/.gitattributes',
  '.vx/.gitignore',
  // `vx lock`'s record of edges and digests: the key folds the digests through
  // `fingerprint`.
  '.vx/dependencies.lock.json',
  // Where restores stage (archive.ts): vx's own, never an input.
  '.vx/tmp/**',
  // The temps a lock write renames from: a killed write leaves one.
  '.vx/projects.lock.json.tmp-*',
  '.vx/dependencies.lock.json.tmp-*',
  'vx.lock.json.tmp-*',
]

/**
 * `ALWAYS_IGNORE` relative to the workspace root, for `inputs.workspaceFiles`,
 * whose globs cross into other projects.
 */
const WORKSPACE_ALWAYS_IGNORE = [...ALWAYS_IGNORE, '**/vx.lock.json', '**/vx.lock.json.tmp-*']

const DEFAULT_FILE_GLOBS: readonly string[] = ['**/*']

export interface ResolvedInputs {
  files: string[]
  /** What `files` was filtered from, for {@link addedInput}. */
  listings: InputListing[]
  envValues: Array<[name: string, value: string | undefined]>
  runtimeValues: Array<[command: string, output: string]>
  workspaceRuntimeValues: Array<[command: string, output: string]>
}

export interface ResolveInputsArgs {
  projectDir: string
  workspaceRoot: string
  envSource: NodeJS.ProcessEnv
  inputs: InputsConfig | undefined
  /** Project-relative output globs to exclude from inputs. */
  ownOutputs: readonly string[]
  /**
   * Root-relative `outputs.workspaceFiles` to exclude from
   * `inputs.workspaceFiles`: a task cannot invalidate itself.
   */
  ownWorkspaceOutputs?: readonly string[]
  /** Absolute dirs of nested projects (cross-boundary isolation). */
  nestedProjectDirs: string[]
  /** Per-run memo of a project's `git ls-files`, asked once per task. */
  gitFilesCache?: GitFilesCache
  /**
   * Run-scoped memo of `inputs.runtime` answers by `projectDir + '\0' +
   * command`. Sound ONLY because every probe runs in one environment, never a
   * task's `exec.env` (`runRuntimeCommand`); threading the task env in would
   * have to widen this key.
   */
  runtimeCache?: Map<string, Promise<string>>
  /** Run-scoped memo of `inputs.workspaceRuntime`, by command alone. */
  workspaceRuntimeCache?: Map<string, Promise<string>>
  /**
   * Answer this task's probes apart in both memos: they may read what its
   * upstream wrote this run. The task id.
   */
  runtimeScope?: string
  /**
   * Run-scoped memo of `inputs.workspaceFiles` by declaration, valid for one
   * enumeration snapshot: a Turbo-mapped workspace gives every task the same
   * `globalDependencies` (930 ms of a 3.0 s no-op, unmemoized).
   */
  workspaceFilesCache?: WorkspaceFilesCache
  /** Per-run memo for `inputs.files`; see `ProjectFilesCache`. */
  projectFilesCache?: ProjectFilesCache
  /** Resolve no files: the caller folds them from a `filesToken` memo. */
  skipFiles?: boolean
}

export type WorkspaceFilesCache = Map<
  string,
  { snapshot: readonly string[]; result: Promise<string[]> }
>

/**
 * Per-run memo of `inputs.files` resolution by project and DECLARATION: tasks
 * of one project declaring the same inputs and outputs resolve alike. Reuse
 * needs the git snapshot to be the SAME ARRAY the entry was built from: a
 * mid-run re-enumeration replaces it, so a task whose inputs an earlier task
 * rewrote walks again.
 */
export type ProjectFilesCache = Map<
  string,
  { snapshot: readonly string[]; result: readonly string[] }
>

/**
 * What a task's input files fold to is a function of this token when it is
 * git's records alone: the project's partition holds only files with a trusted
 * index OID, and the declaration reaches no gitignored path or workspace file.
 * Undefined when only resolving the files can say.
 */
export function filesToken(
  args: Pick<
    ResolveInputsArgs,
    | 'projectDir'
    | 'workspaceRoot'
    | 'inputs'
    | 'ownOutputs'
    | 'ownWorkspaceOutputs'
    | 'nestedProjectDirs'
    | 'gitFilesCache'
  >,
): string | undefined {
  const cache = args.gitFilesCache
  if (cache === undefined) return undefined
  const ws = workspaceFilesToken(args.workspaceRoot, args.inputs?.workspaceFiles, cache)
  if (ws === undefined) return undefined
  const plan = filesPlan(args.inputs?.files, args.ownOutputs)
  if (plan === null) {
    // Only workspace files: a project fold of none.
    return ws === ''
      ? undefined
      : `${args.workspaceRoot}\0${filesMemoKey(args.projectDir, { positive: [], negative: [] }, args.ownOutputs, args.ownWorkspaceOutputs ?? [], args.nestedProjectDirs)}\0-${ws}`
  }
  const snapshot = cache.snapshotFor(args.projectDir, plan.positiveGlobs)
  if (snapshot === undefined) return undefined
  const digest = cache.filesDigest(args.projectDir, snapshot)
  if (
    digest === undefined ||
    ignoredReach(plan, snapshot, { dir: args.projectDir, cache }).length > 0
  )
    return undefined
  return `${args.workspaceRoot}\0${filesMemoKey(args.projectDir, plan, args.ownOutputs, args.ownWorkspaceOutputs ?? [], args.nestedProjectDirs)}\0${digest}${ws}`
}

/**
 * The `workspaceFiles` half of {@link filesToken}: '' for none, undefined when
 * git cannot vouch for what it lists, else the declaration and a digest of
 * every workspace path its globs may take in. A path git answers nothing for is
 * read from disk (`ignoredReach`), which no digest covers.
 */
function workspaceFilesToken(
  workspaceRoot: string,
  declared: readonly string[] | undefined,
  cache: GitFilesCache,
): string | undefined {
  if (declared === undefined || declared.length === 0) return ''
  const key = JSON.stringify(declared)
  let plan = wsPlans.get(key)
  if (plan === undefined) {
    const positive = declared.filter((e) => !e.startsWith('!'))
    const isPositive = throughLinks(positive, anyTaskGlob(asTrees(positive)))
    const mayHold = mayHoldMatch(positive)
    plan = {
      positive,
      globs: asTrees(positive).map(globFor),
      reach: reachOf(positive),
      takes: (rel) => isPositive(rel) || mayHold(rel),
      heads: headsOf(positive),
    }
    wsPlans.set(key, plan)
  }
  // No positive entry lists no workspace file (`resolveWorkspaceFiles`).
  if (plan.positive.length === 0) return ''
  const snapshot = workspaceSnapshot(workspaceRoot, plan.globs, cache).files
  if (ignoredReach(plan.reach, snapshot, { dir: workspaceRoot, cache }).length > 0) return undefined
  const digest = cache.declarationDigest(workspaceRoot, snapshot, key, plan.takes, plan.heads)
  return digest === undefined ? undefined : `\0ws\0${key}\0${digest}`
}

const wsPlans = new Map<
  string,
  {
    positive: string[]
    globs: Bun.Glob[]
    reach: { prefixes: string[]; literals: string[] }
    takes: (rel: string) => boolean
    heads: string[] | undefined
  }
>()

/**
 * Each entry's fixed head: every path it takes in lies at, under or above one.
 * Undefined for a leading `**`.
 */
function headsOf(positive: readonly string[]): string[] | undefined {
  const heads: string[] = []
  for (const glob of asTrees(positive.flatMap(braceAlternatives))) {
    const fixed = isLiteralPattern(glob) ? normalizeGlob(glob) : staticPrefix(glob)
    const head = fixed.replace(/\/+$/, '')
    // An escape names a character the path spells bare: walked whole.
    if (
      head === '' ||
      head === '.' ||
      head === '..' ||
      head.startsWith('../') ||
      head.includes('\\') ||
      path.isAbsolute(head)
    )
      return undefined
    heads.push(head)
  }
  return heads
}

/** Everything below the git snapshot that decides `resolveFiles`' result. */
function filesMemoKey(
  projectDir: string,
  plan: Pick<FilesPlan, 'positive' | 'negative'>,
  ownOutputs: readonly string[],
  ownWorkspaceOutputs: readonly string[],
  nestedProjectDirs: readonly string[],
): string {
  return `${projectDir}\0${plan.positive.join('\u0001')}\0${plan.negative.join('\u0001')}\0${ownOutputs.join('\u0001')}\0${ownWorkspaceOutputs.join('\u0001')}\0${nestedProjectDirs.join('\u0001')}`
}

export async function resolveInputs(args: ResolveInputsArgs): Promise<ResolvedInputs> {
  const projectRel =
    args.skipFiles === true
      ? ''
      : path.relative(args.workspaceRoot, args.projectDir).split(path.sep).join('/')
  const { files: projectFiles, listing } =
    args.skipFiles === true
      ? { files: [], listing: undefined }
      : await resolveFiles({
          projectDir: args.projectDir,
          workspaceRoot: args.workspaceRoot,
          files: args.inputs?.files,
          ownOutputs: args.ownOutputs,
          ownWorkspaceOutputs: args.ownWorkspaceOutputs ?? [],
          projectRel,
          nestedProjectDirs: args.nestedProjectDirs,
          ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
          ...(args.projectFilesCache !== undefined
            ? { projectFilesCache: args.projectFilesCache }
            : {}),
        })
  let files = projectFiles
  const listings = listing === undefined ? [] : [listing]
  const wsDecl = args.inputs?.workspaceFiles
  if (wsDecl !== undefined && wsDecl.length > 0 && args.skipFiles !== true) {
    const ws = resolveWorkspaceFiles({
      workspaceRoot: args.workspaceRoot,
      workspaceFiles: wsDecl,
      ownWorkspaceOutputs: args.ownWorkspaceOutputs ?? [],
      ownOutputs: args.ownOutputs,
      projectRel,
      ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
      ...(args.workspaceFilesCache !== undefined ? { memo: args.workspaceFilesCache } : {}),
    })
    if (ws !== undefined) listings.push(ws.listing)
    const wsFiles = ws === undefined ? [] : await ws.files
    // Dedupe: with the project at the workspace root, a path can arrive through
    // both lists and must fold once.
    if (wsFiles.length > 0) files = mergeSorted(projectFiles, wsFiles)
  }
  // A task declaring neither skips the fan-out.
  const runtimeDecl = args.inputs?.runtime ?? []
  const wsRuntimeDecl = args.inputs?.workspaceRuntime ?? []
  const [runtimeValues, workspaceRuntimeValues] =
    runtimeDecl.length === 0 && wsRuntimeDecl.length === 0
      ? [[], []]
      : await Promise.all([
          resolveRuntimeValues(
            runtimeDecl,
            args.projectDir,
            projectBinDirs(args.projectDir, args.workspaceRoot),
            args.workspaceRoot,
            args.runtimeCache,
            args.runtimeScope === undefined
              ? `${args.projectDir}\0`
              : `${args.projectDir}\0${args.runtimeScope}\0`,
            'runtime',
          ),
          resolveRuntimeValues(
            wsRuntimeDecl,
            args.workspaceRoot,
            [path.join(args.workspaceRoot, 'node_modules', '.bin')],
            args.workspaceRoot,
            args.workspaceRuntimeCache,
            args.runtimeScope === undefined ? '' : `\0${args.runtimeScope}\0`,
            'workspaceRuntime',
          ),
        ])
  return {
    files,
    listings,
    envValues: resolveEnvValues(args.inputs?.env ?? [], args.envSource),
    runtimeValues,
    workspaceRuntimeValues,
  }
}

/**
 * The workspace partition `globs` may read: the run's snapshot, or one
 * `git ls-files` at the root once a write dropped it. The key and its
 * fold memo token read the same listing, so a task after an unsandboxed
 * one still remembers its key (`declarationDigest` vouches for each path
 * by its stat when no index OID does).
 */
function workspaceSnapshot(
  root: string,
  globs: readonly Bun.Glob[],
  cache: GitFilesCache | undefined,
): { files: readonly string[]; undecodable: ReadonlySet<string> | undefined } {
  const files = cache?.snapshotFor(root, globs)
  if (files !== undefined) return { files, undecodable: cache!.undecodableNames }
  const ls = runGitLsFiles(root)
  cache?.set(root, ls.files)
  return { files: ls.files, undecodable: noteUndecodable(cache, root, ls.undecodable) }
}

/**
 * Resolve `inputs.workspaceFiles` against the workspace-wide git file set. No
 * project-boundary rule: this is the documented way to declare shared root
 * inputs. The boundary applies to `files` globs only.
 */
function resolveWorkspaceFiles(args: {
  workspaceRoot: string
  workspaceFiles: readonly string[]
  ownWorkspaceOutputs: readonly string[]
  /** The task's project-relative `outputs.files`, and its project's root-relative directory. */
  ownOutputs: readonly string[]
  projectRel: string
  gitFilesCache?: GitFilesCache
  memo?: WorkspaceFilesCache
}): { files: Promise<string[]>; listing: InputListing } | undefined {
  const positive: string[] = []
  const negative: string[] = []
  for (const entry of args.workspaceFiles) {
    if (entry.startsWith('!')) negative.push(entry.slice(1))
    else positive.push(entry)
  }
  if (positive.length === 0) return undefined

  // A path the task's own outputs take back with `!` stays an input.
  const ownOutput = outputMatcher(args.ownWorkspaceOutputs)
  // Its project outputs too, which a root-anchored glob reaches: left in, its
  // own build moved its key and nothing was ever saved.
  let ownProjectOutput: ((rel: string) => boolean) | undefined
  const ownProject = (rel: string): boolean =>
    (ownProjectOutput ??= underProject(args.projectRel, outputMatcher(args.ownOutputs)))(rel)
  const positiveGlobs = asTrees(positive).map(globFor)
  // Workspace-wide partition, keyed by the root; populated up-front when any
  // task declares workspaceFiles, else spawned on demand.
  const { files: gitFiles, undecodable } = workspaceSnapshot(
    args.workspaceRoot,
    positiveGlobs,
    args.gitFilesCache,
  )
  // Valid for one snapshot: a task that wrote workspace outputs replaces the
  // partition.
  let isExcluded: ((rel: string) => boolean) | undefined
  let isPositive: ((rel: string) => boolean) | undefined
  let mayHold: ((rel: string) => boolean) | undefined
  const excludedByDeclaration = (rel: string): boolean =>
    (isExcluded ??= anyTaskGlob([...WORKSPACE_ALWAYS_IGNORE, ...asTrees(negative)]))(rel)
  // A committed file stays an input whatever output reaches it (`committedFiles`).
  let committed: ((abs: string) => boolean) | undefined
  const own = (rel: string): boolean =>
    (ownOutput(rel) || ownProject(rel)) &&
    !(committed ??= committedFiles(args.gitFilesCache, args.workspaceRoot))(
      path.join(args.workspaceRoot, rel),
    )
  const listing: InputListing = {
    root: args.workspaceRoot,
    workspaceRoot: args.workspaceRoot,
    listed: gitFiles,
    isInput: (rel) =>
      (isPositive ??= throughLinks(positive, anyTaskGlob(asTrees(positive))))(rel) &&
      !excludedByDeclaration(rel) &&
      !own(rel),
    linked: (rel) =>
      (mayHold ??= mayHoldMatch(positive))(rel) &&
      !excludedBeneath(excludedByDeclaration, rel) &&
      !own(rel),
    nested: () => false,
    ...reachOf(positive),
  }
  // Two levels: the declaration's files over the snapshot, shared by every task
  // declaring it, then the task's outputs taken out. Keyed by project too,
  // 2,000 tasks sharing one list each scanned the 4,000 files it matched.
  const declared = JSON.stringify([positive, negative])
  let base: Promise<string[]> | undefined
  const hit = args.memo?.get(declared)
  if (hit !== undefined && hit.snapshot === gitFiles) base = hit.result
  if (base === undefined) {
    isPositive ??= throughLinks(positive, anyTaskGlob(asTrees(positive)))
    base = resolveWorkspaceFilesOver(args, gitFiles, positive, isPositive, excludedByDeclaration)
    args.memo?.set(declared, { snapshot: gitFiles, result: base })
  }
  const ownsAny =
    splitNegations(args.ownWorkspaceOutputs).positive.length > 0 ||
    splitNegations(args.ownOutputs).positive.length > 0
  const reach = ignoredReach(reachOf(positive), gitFiles, {
    dir: args.workspaceRoot,
    cache: args.gitFilesCache,
  })
  const files = base.then((all) => {
    const kept = ownsAny ? all.filter((abs) => !own(relPosix(args.workspaceRoot, abs))) : all
    refuseUndecodable(kept, undecodable, args.workspaceRoot, 'workspaceFiles')
    if (reach.length === 0) return kept
    // Outside the memo: an ignored file written mid-run leaves the snapshot as
    // it was.
    isPositive ??= throughLinks(positive, anyTaskGlob(asTrees(positive)))
    const accept = isPositive
    const extra = ignoredInputs(
      args.workspaceRoot,
      reach,
      (rel) => accept(rel) && !excludedByDeclaration(rel) && !own(rel),
      listing.linked,
      args.gitFilesCache?.vxDirs,
    )
    return extra.length === 0 ? kept : mergeSorted(kept, extra)
  })
  return { files, listing }
}

async function resolveWorkspaceFilesOver(
  args: { workspaceRoot: string; gitFilesCache?: GitFilesCache },
  gitFiles: readonly string[],
  positive: readonly string[],
  isPositive: (rel: string) => boolean,
  excluded: (rel: string) => boolean,
): Promise<string[]> {
  const candidates: string[] = []
  // A clean tracked file exists on disk.
  const oids = args.gitFilesCache?.oidsFor(args.workspaceRoot)
  const mayHold = mayHoldMatch(positive)
  for (const rel of gitFiles) {
    if (isPositive(rel) && !excluded(rel)) candidates.push(path.resolve(args.workspaceRoot, rel))
    else if (mayHold(rel) && !excludedBeneath(excluded, rel)) {
      const abs = path.resolve(args.workspaceRoot, rel)
      if (dirLinkInput(abs, oids)) candidates.push(abs)
    }
  }
  return candidates
    .filter((abs) => oids?.has(abs) === true || inputOnDisk(abs, args.gitFilesCache))
    .sort()
}

/**
 * The sorted union of two sorted, distinct lists in one merge (a Set and sort
 * was 3.7 s of an astro plan). A side out of order takes the general path.
 */
function mergeSorted(a: readonly string[], b: readonly string[]): string[] {
  if (a.length === 0 && isStrictlySorted(b)) return b as string[]
  if (!isStrictlySorted(a) || !isStrictlySorted(b)) return [...new Set([...a, ...b])].sort()
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const x = a[i]!
    const y = b[j]!
    if (x <= y) {
      out.push(x)
      i++
      if (x === y) j++
    } else {
      out.push(y)
      j++
    }
  }
  while (i < a.length) out.push(a[i++]!)
  while (j < b.length) out.push(b[j++]!)
  return out
}

function isStrictlySorted(list: readonly string[]): boolean {
  for (let i = 1; i < list.length; i++) if (!(list[i - 1]! < list[i]!)) return false
  return true
}

/** A project-relative matcher asked of root-relative paths: false outside the project. */
function underProject(
  projectRel: string,
  matches: (rel: string) => boolean,
): (rel: string) => boolean {
  if (projectRel === '') return matches
  const prefix = `${projectRel}/`
  return (rel) => rel.startsWith(prefix) && matches(rel.slice(prefix.length))
}

/** A root-relative matcher asked of project-relative paths. */
function inProject(
  projectRel: string,
  matches: (rel: string) => boolean,
): (rel: string) => boolean {
  return projectRel === '' ? matches : (rel) => matches(`${projectRel}/${rel}`)
}

/** Anything at the path — file, directory, symlink to anything or to nothing. */
function existsOnDisk(abs: string): boolean {
  try {
    lstatSync(abs)
    return true
  } catch {
    return false
  }
}

/**
 * An input is a regular file or a symlink to anything or nothing (its target
 * STRING folds, as in git). Not a directory: git lists a submodule at its path
 * and `**\/*` matches it. `Bun.file().exists()` was false for links to
 * directories and dangling links, dropping them from the key. lstat
 * synchronously: only paths without a trusted OID get here.
 */
function isInputOnDisk(abs: string): boolean {
  try {
    const st = lstatSync(abs)
    return st.isFile() || st.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * `isInputOnDisk` from the run's stat of the path (`statOf`), not a stat per
 * declaration.
 */
function inputOnDisk(abs: string, run: GitFilesCache | undefined): boolean {
  if (run === undefined) return isInputOnDisk(abs)
  let st
  try {
    st = run.statOf(abs)
  } catch {
    return false
  }
  return st !== undefined && (st.isFile() || st.isSymbolicLink())
}

/** vx's values of `ESSENTIAL_ENV`: the one environment every probe gets. */
function probeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of ESSENTIAL_ENV) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/** The task's `node_modules/.bin` directories, as `taskBinDirs` gives its PATH. */
function projectBinDirs(projectDir: string, workspaceRoot: string): string[] {
  const own = path.join(projectDir, 'node_modules', '.bin')
  const root = path.join(workspaceRoot, 'node_modules', '.bin')
  return own === root ? [own] : [own, root]
}

/**
 * One runtime probe answered here as a key folds it: `inputs.runtime` in
 * `projectDir`, or `workspaceRuntime` in `workspaceRoot`. For an executor that
 * checks probes where a task runs.
 */
export function answerRuntime(
  command: string,
  projectDir: string,
  workspaceRoot: string,
  workspace = false,
): Promise<string> {
  return workspace
    ? runRuntimeCommand(
        command,
        workspaceRoot,
        [path.join(workspaceRoot, 'node_modules', '.bin')],
        workspaceRoot,
        undefined,
        'workspaceRuntime',
      )
    : runRuntimeCommand(
        command,
        projectDir,
        projectBinDirs(projectDir, workspaceRoot),
        workspaceRoot,
        undefined,
        'runtime',
      )
}

function resolveEnvValues(
  names: readonly string[],
  source: NodeJS.ProcessEnv,
): Array<[string, string | undefined]> {
  return [...names].sort().map((name) => {
    const value = ownEnv(source, name)
    // Bun decodes the environment lossily, so Latin-1 é and è both read as
    // U+FFFD and would key alike; a value holding U+FFFD is refused with them.
    // Never shown: it may be a secret.
    if (value?.includes('�') === true) {
      throw new UserError(
        `inputs.env ${name} holds U+FFFD: its value is not UTF-8, or holds that character, ` +
          `and a lossy decode keys every invalid byte alike. Set it as UTF-8.`,
      )
    }
    return [name, value]
  })
}

/**
 * Run one runtime-input command via `sh -c` and return trimmed stdout+stderr; a
 * non-zero exit is a UserError naming it.
 *
 * The probe sees only the essential env every task sees, never `exec.env` and
 * never the rest of vx's: an unsandboxed task could read vx's secrets from the
 * probe's `/proc/<pid>/environ`. One env for every probe lets the memo key on
 * (projectDir, command).
 *
 * Its PATH leads with the task's `node_modules/.bin` directories, as the task's
 * does, so `tsc --version` keys the tsc the task runs.
 */
async function runRuntimeCommand(
  command: string,
  cwd: string,
  binDirs: readonly string[],
  workspaceRoot: string,
  owner: RuntimeMemo | undefined,
  field: RuntimeField,
): Promise<string> {
  const probe = `inputs.${field} probe`
  // As a task's (exec/env.ts): no member's bin inherited from `npm run`.
  const ambient = withoutWorkspaceBins(process.env['PATH'] ?? '', workspaceRoot)
  // As the task's PATH: a dir holding the delimiter splits into a relative
  // entry.
  const PATH = [...binDirs.filter((dir) => !dir.includes(path.delimiter)), ambient]
    .filter((entry) => entry)
    .join(path.delimiter)
  let proc
  try {
    // vx's own `sh`, resolved before the probe's PATH, which leads with the
    // project's `.bin`: a dependency's `sh` bin would run every probe.
    proc = Bun.spawn(shellArgv(command), {
      cwd,
      env: { ...probeEnv(), PATH },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      // Its own group, so the probe's tree goes down with vx
      // (`killProbesOnExit`).
      detached: true,
    })
  } catch (err) {
    // A box without sh names the shell, not the command.
    if (isExecutableMissing(err)) {
      throw new UserError(
        `${probe} could not run: vx runs it with sh -c and 'sh' is not on PATH (command: ${command}, cwd: ${cwd}). Install a POSIX sh and re-run.`,
      )
    }
    throw new UserError(`${probe} failed to spawn: ${command} (cwd: ${cwd})`)
  }
  liveProbes.add(proc)
  let mine: Set<ReturnType<typeof Bun.spawn>> | undefined
  if (owner !== undefined) {
    mine = probesOf.get(owner) ?? new Set()
    probesOf.set(owner, mine)
    mine.add(proc)
  }
  killProbesOnExit()
  let stdout, stderr, exitCode
  const ac = new AbortController()
  try {
    const streams = Promise.all([
      probeBytes(proc.stdout, ac.signal),
      probeBytes(proc.stderr, ac.signal),
    ])
    exitCode = await proc.exited
    // A child holding the pipes (`sleep 6 & echo x`) would keep the run
    // waiting. As a task's: a short drain, then the reads stop and the group
    // goes. What the shell printed is the answer.
    let timer: ReturnType<typeof setTimeout> | undefined
    const cut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, POST_EXIT_DRAIN_MS)
    })
    await Promise.race([streams, cut])
    clearTimeout(timer)
    ac.abort()
    killGroup(proc.pid)
    ;[stdout, stderr] = await streams
  } finally {
    liveProbes.delete(proc)
    mine?.delete(proc)
  }
  if (exitCode !== 0) {
    const lossy = new TextDecoder()
    // Capped like a persistent task's log, tail kept: the failure is usually
    // last.
    const tail = createTail()
    appendTail(tail, `${lossy.decode(stdout)}${lossy.decode(stderr)}`.trim())
    const shown = tailText(tail)
    const lost = tail.dropped === 0 ? '' : `… ${tail.dropped} earlier characters dropped\n`
    throw new UserError(
      `${probe} exited ${exitCode}: ${command} (cwd: ${cwd})` + (shown ? `\n${lost}${shown}` : ''),
    )
  }
  let out: string
  let err: string
  try {
    out = FATAL_UTF8.decode(stdout)
    err = FATAL_UTF8.decode(stderr)
  } catch {
    // A lossy decode would key Latin-1 é and è alike.
    throw new UserError(
      `${probe} printed bytes that are not UTF-8: ${command} (cwd: ${cwd}). ` +
        `Pipe it through a hash or od.`,
    )
  }
  return probeOutput(out, err)
}

/**
 * The probe's output as folded. Plain concatenation keyed stdout `ab` and
 * stdout `a` + stderr `b` alike: an output with stderr or a NUL is framed with
 * a leading NUL and stdout's length.
 */
function probeOutput(stdout: string, stderr: string): string {
  const out = stdout.trim()
  const err = stderr.trim()
  if (err === '' && !out.includes('\0')) return out
  return `\0${out.length}\0${out}${err}`
}

/**
 * Runtime probes still running. Each is its own group, and those still listed
 * at exit are SIGKILLed with their trees, so a stopped run leaves none under
 * init. A `kill -9` of vx runs no hook.
 */
const liveProbes = new Set<ReturnType<typeof Bun.spawn>>()
let probeExitHooked = false

type RuntimeMemo = Map<string, Promise<string>>
/** The field a probe is declared under, as its errors name it. */
type RuntimeField = 'runtime' | 'workspaceRuntime'
/** The probes each run started, by the run's memo: one run's stop is not another's. */
const probesOf = new WeakMap<RuntimeMemo, Set<ReturnType<typeof Bun.spawn>>>()

/**
 * Kill every probe these memos started, with its tree, on a run's stop: a
 * Ctrl-C would otherwise wait for it. Its caller reads it aborted. Another run
 * in the process keeps its own.
 */
export function stopRuntimeProbes(...memos: readonly RuntimeMemo[]): void {
  for (const memo of memos) {
    for (const p of probesOf.get(memo) ?? []) {
      killGroup(p.pid)
    }
  }
}
/** SIGKILL a probe's group, its own since the spawn (`detached`). */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // the group is gone
  }
}

/**
 * A probe's stream, read to its end or until `signal`, which cancels the read
 * and returns what came: `Response.bytes()` cannot be left while a leftover
 * child holds the pipe.
 */
async function probeBytes(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const onAbort = (): void => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', onAbort, { once: true })
  const parts: Uint8Array[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      parts.push(value)
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
  return Buffer.concat(parts)
}

function killProbesOnExit(): void {
  if (probeExitHooked) return
  probeExitHooked = true
  process.on('exit', () => {
    for (const p of liveProbes) {
      killGroup(p.pid)
    }
  })
}

/**
 * Resolve runtime-input commands to sorted [command, output] pairs, deduped
 * through `memo` (one promise per key). `memoKeyPrefix` separates project and
 * workspace scopes. Distinct commands run concurrently.
 */
async function resolveRuntimeValues(
  commands: readonly string[],
  cwd: string,
  binDirs: readonly string[],
  workspaceRoot: string,
  memo: Map<string, Promise<string>> | undefined,
  memoKeyPrefix: string,
  field: RuntimeField,
): Promise<Array<[string, string]>> {
  if (commands.length === 0) return []
  const unique = [...new Set(commands)].sort()
  return Promise.all(
    unique.map(async (cmd) => {
      const key = `${memoKeyPrefix}${cmd}`
      let p = memo?.get(key)
      if (p === undefined) {
        p = runRuntimeCommand(cmd, cwd, binDirs, workspaceRoot, memo, field)
        memo?.set(key, p)
      }
      return [cmd, await p] as [string, string]
    }),
  )
}

/**
 * What a walk of output globs leaves out: `outputExcluded` (a `**\/*.js` output
 * must not clean installed `.js` under `node_modules`) and the `!` entries.
 */
function outputExcludes(
  positive: readonly string[],
  negative: readonly string[],
  scope: 'project' | 'workspace',
): (rel: string) => boolean {
  const excluded = outputExcluded(positive, scope)
  const back = anyTaskGlob(asTrees(negative))
  return (rel) => excluded(rel) || back(rel)
}

/** A task's `inputs` and the directories they anchor at, for `refuseLinkedIntoInputs`. */
export interface OwnInputs {
  projectDir: string
  workspaceRoot: string
  declared: InputsConfig | undefined
}

/**
 * Resolve project-relative output globs to produced files. An output directory
 * linked out of the project is refused by name, never silently saved empty.
 */
export async function resolveOutputs(args: {
  projectDir: string
  outputs: readonly string[]
  nestedProjectDirs: string[]
  inputs?: OwnInputs | undefined
}): Promise<string[]> {
  return (await scanOutputs(args)).files
}

/** Whether `resolveOutputs` takes `rel`, decided without the walk. */
export function outputWalkTakes(
  projectDir: string,
  outputs: readonly string[],
  nestedProjectDirs: string[],
): (rel: string) => boolean {
  const restorable = restorableOutput(outputs)
  const nested = inNestedProject(projectDir, nestedProjectDirs)
  return (rel) => restorable(rel) && !nested(rel)
}

/**
 * `resolveOutputs` plus the empty directories the globs match, which a save
 * keeps (as Turbo and Nx do).
 */
export async function resolveOutputTree(args: {
  projectDir: string
  outputs: readonly string[]
  nestedProjectDirs: string[]
  /** The task's own inputs: an output directory linked into them is refused. */
  inputs?: OwnInputs | undefined
  /**
   * Also list FIFOs, sockets and devices: a save refuses them, a clean removes
   * them. `'later'` hands `findSpecial` for a walk that needs them only if it
   * restores.
   */
  special?: boolean | 'later'
  /** The walk feeds a clean or a restore (`refuseUndecodableOutput`). */
  clearing?: boolean
}): Promise<OutputTree> {
  const emptyDirs = new Set<string>()
  const probe: SpecialProbe | undefined =
    args.special === undefined || args.special === false ? undefined : {}
  const { files } = await scanOutputs(args, emptyDirs, probe)
  return treeOf(args.projectDir, files, emptyDirs, args.special, probe)
}

/** What `resolveOutputTree` and its workspace twin return. */
type OutputTree = {
  files: string[]
  emptyDirs: string[]
  special: string[]
  findSpecial?: () => string[]
}

function treeOf(
  root: string,
  files: string[],
  emptyDirs: Set<string>,
  asked: boolean | 'later' | undefined,
  probe: SpecialProbe | undefined,
): OutputTree {
  const findSpecial = (): string[] =>
    probe?.find === undefined ? [] : containedIn(root, probe.find()).sort()
  const tree: OutputTree = {
    files,
    emptyDirs: containedIn(root, [...emptyDirs]).sort(),
    special: asked === true ? findSpecial() : [],
  }
  if (asked === 'later') tree.findSpecial = findSpecial
  return tree
}

async function scanOutputs(
  args: {
    projectDir: string
    outputs: readonly string[]
    nestedProjectDirs: string[]
    inputs?: OwnInputs | undefined
    clearing?: boolean
  },
  emptyDirs?: Set<string>,
  special?: SpecialProbe,
): Promise<{ files: string[] }> {
  const { positive, negative } = splitNegations(args.outputs)
  if (positive.length === 0) return { files: [] }
  const excluded = outputExcludes(positive, negative, 'project')
  const trees = asTrees(positive)
  const absent = refuseDirLinkedOut(args.projectDir, trees, 'project', args.inputs)
  const scanned = [
    ...(await scanUnion(
      trees,
      excluded,
      args.projectDir,
      inNestedProject(args.projectDir, args.nestedProjectDirs),
      emptyDirs,
      special,
      absent,
      args.clearing,
    )),
  ]
  // Containment enforced HERE, not only at the loader: `cleanOutputs` deletes
  // what this returns, and `Bun.Glob.scan` walks `..` out of its cwd. Any
  // caller reaching the resolver by another route is contained.
  const contained = containedIn(args.projectDir, scanned)
  return { files: outsideNested(args.nestedProjectDirs, contained).sort() }
}

/**
 * Whether git tracks a file under `dir`. No clean deletes a committed or staged
 * file; the task may rewrite it, and it stays in the key.
 */
export function committedFiles(
  cache: GitFilesCache | undefined,
  dir: string,
): (abs: string) => boolean {
  return (cache ?? new GitFilesCache()).committedIn(dir)
}

/**
 * The literal head of each output glob, walked: the scan follows a link there
 * (`dist -> ../elsewhere`) and only there; a link below is an output, kept as a
 * link. Refused in either scope: a head linked into `.git` or `.vx` (a clean
 * through `dist -> .git` deleted the repository), out of the root, or onto an
 * entry of the task's own `inputs` (`dist -> src` would clean every untracked
 * source).
 */
function refuseDirLinkedOut(
  root: string,
  trees: readonly string[],
  scope: 'project' | 'workspace',
  inputs?: OwnInputs,
): Set<string> {
  // The heads found absent: the scan skips them without asking again.
  const absent = new Set<string>()
  let realRoot: string | undefined
  for (const tree of trees) {
    let at = root
    for (const part of staticPrefix(tree).split('/')) {
      if (part === '' || part === '.') continue
      at = path.join(at, part)
      if (!isInside(root, at)) break
      let st
      try {
        st = lstatSync(at, { throwIfNoEntry: false })
      } catch {
        break
      }
      if (st === undefined) {
        absent.add(at)
        break
      }
      if (!st.isSymbolicLink()) continue
      let real: string
      try {
        real = realpathSync(at)
        if (!statSync(real).isDirectory()) break
      } catch {
        break
      }
      realRoot ??= realOr(root)
      if (!isInside(realRoot, real)) {
        throw new UserError(
          `${at} is a symbolic link to ${real}, outside ${root} — vx never cleans, saves ` +
            `or restores declared outputs through a link that leaves the ${scope}. Remove the ` +
            'link and re-run, or stop declaring outputs under it.',
        )
      }
      if (inMetadata(real, realRoot)) {
        throw new UserError(
          `${at} is a symbolic link to ${real}, Git's or vx's metadata — vx never cleans, ` +
            'saves or restores declared outputs through a link into .git or .vx. Remove the ' +
            'link and re-run, or stop declaring outputs under it.',
        )
      }
      if (inputs !== undefined) refuseLinkedIntoInputs(at, real, inputs)
    }
  }
  return absent
}

/**
 * Throws when an entry of `inputs` can match a path under the real directory
 * `real`. A link to an ancestor of the anchor holds every entry. Negations are
 * not subtracted.
 */
function refuseLinkedIntoInputs(at: string, real: string, inputs: OwnInputs): void {
  const holds = (anchor: string, globs: readonly string[] | undefined): boolean => {
    const { positive } = splitNegations(globs ?? [])
    if (positive.length === 0) return false
    const realAnchor = realOr(anchor)
    const rel = relPosix(realAnchor, real)
    if (rel === '..' || rel.startsWith('../')) return isInside(real, realAnchor)
    const dir = rel === '' ? [] : rel.split('/')
    return asTrees(positive).some((g) => reachesBelow(g.split('/'), dir))
  }
  if (
    !holds(inputs.projectDir, inputs.declared?.files) &&
    !holds(inputs.workspaceRoot, inputs.declared?.workspaceFiles)
  )
    return
  throw new UserError(
    `${at} is a symbolic link into ${real}, which the task's own inputs read — vx removes a ` +
      `task's outputs before it runs, so the task would delete its own sources. Remove the ` +
      'link and re-run, or stop declaring outputs under it.',
    'VX_E_INPUT_IS_OUTPUT',
  )
}

/**
 * Whether the glob in `segments` can match below `dir`: each of `dir`'s names
 * matches its segment and the glob goes on, or a `**` comes first.
 */
function reachesBelow(segments: readonly string[], dir: readonly string[]): boolean {
  for (let i = 0; i < dir.length; i++) {
    const seg = segments[i]
    if (seg === undefined) return false
    if (seg === '**') return true
    if (!globFor(seg).match(dir[i]!)) return false
  }
  return segments.length > dir.length
}

/**
 * Whether `real` is in a `.git` or `.vx` under `realRoot`. Asked only where a
 * link landed: a build's own `dist/.git/**` is an output.
 */
function inMetadata(real: string, realRoot: string): boolean {
  if (!writableUnder(real, realRoot)) return true
  return (
    real
      .slice(realRoot.length + 1)
      .split(path.sep, 1)[0]!
      .toLowerCase() === '.vx'
  )
}

function realOr(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Keep only paths REALLY inside `root`, lexically and after resolving symlinks:
 * since Bun 1.4.0 the scan descends into linked directories, so `dist ->
 * ../victim` yields `dist/precious.txt`, lexically inside, and the caller
 * deletes what this returns.
 *
 * Directories are what matter: `rm` on a linked FILE unlinks the link. One
 * syscall per distinct directory. A directory that will not resolve is refused:
 * unresolvable means leave it alone.
 */
function containedIn(root: string, paths: readonly string[]): string[] {
  // One `path.dirname` per path, kept: recomputing it was the dominant cost on
  // a wide tree.
  const lexical: string[] = []
  const lexDirs: string[] = []
  for (const p of paths) {
    if (!isInside(root, p)) continue
    lexical.push(p)
    lexDirs.push(path.dirname(p))
  }
  if (lexical.length === 0) return []
  // Sync: a realpath is microseconds, the promise round trip was most of the
  // cost.
  const realRoot = realOrNull(root) ?? root
  const uniqueDirs = [...new Set(lexDirs)]
  const resolved = uniqueDirs.map(realOrNull)
  const contained = new Set<string>()
  for (const [i, dir] of uniqueDirs.entries()) {
    const real = resolved[i]
    if (real !== null && real !== undefined && isInside(realRoot, real)) contained.add(dir)
  }
  return lexical.filter((_p, i) => contained.has(lexDirs[i]!))
}

/**
 * `committed` is also asked by each path's real directory: through a followed
 * `public -> static` link, `static/logo.txt` is the only name git lists, and a
 * committed file must not be cleaned.
 */
function committedPastLinks(
  root: string,
  committed: (abs: string) => boolean,
): (abs: string) => boolean {
  let realRoot: string | undefined
  const canonical = new Map<string, string | null>()
  return (abs) => {
    if (committed(abs)) return true
    const dir = path.dirname(abs)
    let canon = canonical.get(dir)
    if (canon === undefined) {
      const real = realOrNull(dir)
      realRoot ??= realOrNull(root) ?? root
      canon =
        real === null || !isInside(realRoot, real)
          ? null
          : path.join(root, path.relative(realRoot, real))
      canonical.set(dir, canon)
    }
    return canon !== null && canon !== dir && committed(path.join(canon, path.basename(abs)))
  }
}

/**
 * Drop files whose real directory is in a nested project: a followed link may
 * land there.
 */
function outsideNested(nestedDirs: readonly string[], files: string[]): string[] {
  if (nestedDirs.length === 0 || files.length === 0) return files
  const realNested = nestedDirs.map((d) => realOrNull(d) ?? d)
  const verdict = new Map<string, boolean>()
  return files.filter((f) => {
    const dir = path.dirname(f)
    let ok = verdict.get(dir)
    if (ok === undefined) {
      const real = realOrNull(dir) ?? dir
      ok = !realNested.some((n) => isInside(n, real))
      verdict.set(dir, ok)
    }
    return ok
  })
}

/** Is `abs` the directory `dir` itself or something beneath it? */
function isInside(dir: string, abs: string): boolean {
  if (abs === dir) return true
  return abs.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)
}

/**
 * Remove every file the output globs match now, before a hit's restore (so the
 * tree ends as cached) and before a miss's run (no stragglers). A file in a
 * declared output path is the task's, by declaration. Nested projects are
 * excluded, as in `resolveOutputs`.
 */
export async function cleanOutputs(args: {
  projectDir: string
  outputs: readonly string[]
  nestedProjectDirs: string[]
  inputs?: OwnInputs | undefined
  committed?: (abs: string) => boolean
  /**
   * What `resolveOutputs` returned for the same arguments with no await since:
   * a stale hit already walked the tree.
   */
  resolved?: readonly string[] | undefined
  /**
   * The command runs next: a directory of this user's the clean opened stays
   * open, or a kept `chmod 555 dist` refuses the command's own write.
   */
  beforeRun?: boolean
  /** Filled with the committed files it found and left (absolute). */
  kept?: string[]
}): Promise<string[]> {
  const committed = committedPastLinks(
    args.projectDir,
    args.committed ?? committedFiles(undefined, args.projectDir),
  )
  sweepRestoreTemps(args.projectDir, args.outputs, committed)
  // An empty directory under the outputs goes too (a save keeps it), and a
  // FIFO, socket or device: writing a FIFO's path blocks forever.
  const tree =
    args.resolved === undefined
      ? await resolveOutputTree({ ...args, special: true, clearing: true })
      : { files: args.resolved, emptyDirs: [], special: [] }
  const matched = tree.files
  // `force: true` tolerates ENOENT from overlapping globs. A symlink is
  // unlinked, never followed.
  const removed = await removeAll(
    [...matched, ...tree.special].filter((f) => !keptCommitted(f, committed, args.kept)),
    args.projectDir,
    args.beforeRun,
  )
  await pruneEmptiedDirs(
    args.projectDir,
    removed,
    pruneScope(args.projectDir, args.outputs),
    undefined,
    tree.emptyDirs,
    args.beforeRun,
  )
  // Project-relative paths the outputs reach, for
  // `GitFilesCache.markOutputsChanged`: a committed one kept here is the task's
  // to rewrite, so its index OID no longer vouches for it.
  return matched.map((f) => relPosix(args.projectDir, f))
}

/**
 * Remove restore temps (`.vx-tmp-<pid>-<n>`) a killed run left beside an
 * exact-file output. A restore writes one there only across filesystems
 * (EXDEV), and `out/a.txt` reaches no sibling, so it would stay forever. A temp
 * whose writer is alive is left.
 */
export function sweepRestoreTemps(
  base: string,
  outputs: readonly string[],
  committed: (abs: string) => boolean = () => false,
): void {
  const dirs = new Set<string>()
  for (const g of outputs) {
    if (g.startsWith('!') || !isLiteralPattern(g)) continue
    dirs.add(path.dirname(path.resolve(base, stripTrailingSlash(normalizeGlob(g)))))
  }
  // A directory resolving out of `base` is not the outputs': a delete never
  // follows a link out.
  let realBase: string | undefined
  for (const dir of dirs) {
    const real = realOrNull(dir)
    if (real === null || !isInside((realBase ??= realOrNull(base) ?? base), real)) continue
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const m = /^\.vx-tmp-([0-9a-z]+)-[0-9a-z]+$/.exec(name)
      if (m === null) continue
      const pid = Number.parseInt(m[1]!, 36)
      if (pid === process.pid || writerAlive(pid)) continue
      // vx never deletes a committed file, whatever its name.
      if (committed(path.join(dir, name))) continue
      rmSync(path.join(dir, name), { force: true })
    }
  }
}

/**
 * Empty `.vx/tmp/` of the staging directories a killed run left, once per run;
 * a live writer's is left.
 */
export function sweepStaging(workspaceRoot: string): void {
  const top = path.join(workspaceRoot, '.vx', 'tmp')
  let names: string[]
  try {
    names = readdirSync(top)
  } catch {
    return
  }
  for (const name of names) {
    const m = /^([0-9a-z]+)-[0-9a-z]+$/.exec(name)
    if (m === null) continue
    const pid = Number.parseInt(m[1]!, 36)
    if (pid === process.pid || writerAlive(pid)) continue
    rmSync(path.join(top, name), { recursive: true, force: true })
  }
}

function writerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Remove exactly these paths, an ADDITIVE task's recorded rows, never a glob,
 * which would take the upstream files it adds beside. Emptied directories are
 * pruned only inside the declared outputs, stopping at one the upstream still
 * fills.
 */
export async function cleanOutputPaths(args: {
  projectDir: string
  rels: readonly string[]
  outputs: readonly string[]
  committed?: (abs: string) => boolean
  /** Directories the prune leaves standing even when emptied (absolute). */
  keep?: ReadonlySet<string>
  /** Empty directories to remove too (project-relative). */
  emptyDirs?: readonly string[]
}): Promise<void> {
  const committed = args.committed ?? committedFiles(undefined, args.projectDir)
  const files = args.rels.map((r) => path.resolve(args.projectDir, r)).filter((f) => !committed(f))
  await pruneEmptiedDirs(
    args.projectDir,
    await removeAll(files, args.projectDir),
    pruneScope(args.projectDir, args.outputs),
    args.keep,
    args.emptyDirs?.map((r) => path.resolve(args.projectDir, r)),
  )
}

/**
 * A file's identity for the additive diff, as `isOutputsCurrent` trusts it:
 * inode and ctime, which no task sets back, beside size and mtime.
 */
export interface OutputStamp {
  size: number
  mtimeMs: number
  ino: number
  ctimeMs: number
}

/**
 * The stamps of every file the outputs select, taken BEFORE an additive task
 * runs, so its additions and changes can be told from what it found.
 */
export async function stampOutputs(args: {
  projectDir: string
  outputs: readonly string[]
  nestedProjectDirs: string[]
  inputs?: OwnInputs | undefined
}): Promise<Map<string, OutputStamp>> {
  return stampFiles(await resolveOutputs(args))
}

/** `stampOutputs` for root-anchored `outputs.workspaceFiles`. */
export async function stampWorkspaceOutputs(args: {
  workspaceRoot: string
  outputs: readonly string[]
  inputs?: OwnInputs | undefined
}): Promise<Map<string, OutputStamp>> {
  return stampFiles(await resolveWorkspaceOutputs(args))
}

/**
 * The stamps of the committed files among `files`. No clean deletes one, so a
 * failed attempt's change stays for the retry: `committedMoved` tells.
 */
export function stampCommitted(
  files: readonly string[],
  committed: (abs: string) => boolean,
): Map<string, OutputStamp> {
  return stampFiles(files.filter(committed))
}

/** Whether a committed file among `files` was added, removed or touched since `before` (`stampCommitted`). */
export function committedMoved(
  files: readonly string[],
  committed: (abs: string) => boolean,
  before: ReadonlyMap<string, OutputStamp>,
): boolean {
  const changed = changedSince(files.filter(committed), before)
  return changed === undefined || changed.length > 0
}

function stampFiles(files: readonly string[]): Map<string, OutputStamp> {
  const out = new Map<string, OutputStamp>()
  for (const f of files) {
    try {
      const st = lstatSync(f)
      out.set(f, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, ctimeMs: st.ctimeMs })
    } catch {
      // Gone between the walk and the stat: not a file the task found.
    }
  }
  return out
}

/**
 * The files an additive task ADDED or CHANGED under its outputs: not in
 * `before`, or with a moved stamp, the proof the hit path already trusts. A
 * rewrite with identical bytes counts (its ctime moved). A file left as found
 * is its own too when `mine` says a save or restore of this task left it so (an
 * incremental emitter keeps unchanged files).
 *
 * Undefined when the run REMOVED a file it found: an artifact holds what a run
 * wrote, never what it took away, so no entry reproduces that run.
 */
export async function ownOutputsSince(
  args: {
    projectDir: string
    outputs: readonly string[]
    nestedProjectDirs: string[]
    inputs?: OwnInputs | undefined
  },
  before: ReadonlyMap<string, OutputStamp>,
  mine?: (abs: string) => boolean,
): Promise<string[] | undefined> {
  return changedSince(await resolveOutputs(args), before, mine)
}

/** `ownOutputsSince` for root-anchored `outputs.workspaceFiles`. */
export async function ownWorkspaceOutputsSince(
  args: { workspaceRoot: string; outputs: readonly string[]; inputs?: OwnInputs | undefined },
  before: ReadonlyMap<string, OutputStamp>,
  mine?: (abs: string) => boolean,
): Promise<string[] | undefined> {
  return changedSince(await resolveWorkspaceOutputs(args), before, mine)
}

function changedSince(
  after: readonly string[],
  before: ReadonlyMap<string, OutputStamp>,
  mine?: (abs: string) => boolean,
): string[] | undefined {
  const own: string[] = []
  let kept = 0
  for (const f of after) {
    const was = before.get(f)
    if (was === undefined) {
      own.push(f)
      continue
    }
    try {
      const st = lstatSync(f)
      kept++
      if (
        st.size !== was.size ||
        st.mtimeMs !== was.mtimeMs ||
        st.ino !== was.ino ||
        st.ctimeMs !== was.ctimeMs ||
        mine?.(f) === true
      )
        own.push(f)
    } catch {
      // Vanished since the walk: removed, as one the walk missed is.
    }
  }
  return kept < before.size ? undefined : own
}

/**
 * Up to this many paths a clean removes synchronously: the pool round trip per
 * `rm` cost more than the unlink. Past a few hundred the parallel removal wins.
 */
const SYNC_CLEAN_MAX = 128

/**
 * A declared output the process cannot remove (another user's `dist/`, a
 * read-only checkout) is the environment's failure, not an internal error.
 *
 * A directory of this user's that withholds its own write (`chmod 555 dist/ro`,
 * which a hit restores too) gets owner write and search for the remove and its
 * mode back after, as a restore's write does, or the task could never run or
 * restore again. `keepOpen`: the command runs next and gets no mode back.
 */
async function removeAll(
  all: readonly string[],
  root: string,
  keepOpen = false,
): Promise<string[]> {
  const files = insideRoot(all, root)
  const reopened: Reopened = new Map()
  const reopen = (dir: string): boolean => reopenDir(dir, reopened)
  const refused = (f: string, err: NodeJS.ErrnoException): UserError => {
    const rel = relPosix(root, f)
    return new UserError(
      `cannot remove declared output ${rel}: ${err.code ?? err.message} — vx clears a task's ` +
        `declared outputs before it runs and before a restore; make the path removable ` +
        `by this user, or stop declaring it as an output`,
    )
  }
  const denied = (err: unknown, f: string): boolean =>
    (err as NodeJS.ErrnoException).code === 'EACCES' && reopen(path.dirname(f))
  try {
    if (files.length <= SYNC_CLEAN_MAX) {
      for (const f of files) {
        try {
          rmSync(f, { force: true })
        } catch (err) {
          if (!denied(err, f)) throw refused(f, err as NodeJS.ErrnoException)
          try {
            rmSync(f, { force: true })
          } catch (again) {
            throw refused(f, again as NodeJS.ErrnoException)
          }
        }
      }
      return files
    }
    await Promise.all(
      files.map((f) =>
        rm(f, { force: true })
          .catch((err: NodeJS.ErrnoException) => {
            if (!denied(err, f)) throw err
            return rm(f, { force: true })
          })
          .catch((err: NodeJS.ErrnoException) => {
            throw refused(f, err)
          }),
      ),
    )
    return files
  } finally {
    if (!keepOpen) giveBack(reopened)
  }
}

/** Directories given missing owner bits for a remove or a walk, with the mode each had. */
type Reopened = Map<string, number>

/** Whether `dir` is now open: this user's, given the owner `bits` it lacked. */
function reopenDir(dir: string, reopened: Reopened, bits = 0o300): boolean {
  if (reopened.has(dir)) return true
  const st = lstatSync(dir, { throwIfNoEntry: false })
  if (st?.isDirectory() !== true || st.uid !== process.getuid?.()) return false
  if ((st.mode & bits) === bits) return false
  reopened.set(dir, st.mode & 0o7777)
  chmodSync(dir, (st.mode & 0o7777) | bits)
  return true
}

function giveBack(reopened: Reopened): void {
  for (const [dir, mode] of reopened) {
    try {
      chmodSync(dir, mode)
    } catch {
      // gone since (the prune removed it): nothing to give back
    }
  }
}

/**
 * The paths whose directory resolves inside `root`. A link inside the project
 * is followed, as the save follows it (turborepo#13042); one leaving the
 * project, or into `.git` or `.vx`, is never deleted through.
 */
function insideRoot(files: readonly string[], root: string): string[] {
  // Resolved only once a directory exists to compare: after a clean (the common
  // restore) none does.
  let realRoot: string | undefined
  const own = new Map<string, boolean>()
  return files.filter((f) => {
    const dir = path.dirname(f)
    let ok = own.get(dir)
    if (ok === undefined) {
      // A directory already gone has nothing to delete through; its path stays
      // so the prune reaches its parents.
      const r = realOrNull(dir)
      if (r === null) ok = true
      else {
        realRoot ??= realOrNull(root) ?? root
        // Where no link moved it, a `.git` is the build's own (inMetadata).
        ok =
          isInside(realRoot, r) &&
          (path.relative(realRoot, r) === path.relative(root, dir) || !inMetadata(r, realRoot))
      }
      own.set(dir, ok)
    }
    return ok
  })
}

/**
 * Remove the directories a clean emptied, and the `emptyDirs` it found,
 * bottom-up, never `root`: a directory where the entry holds a FILE of that
 * name blocks the restore's rename. One holding a stray stays; the restore
 * names it if in the way. With a `scope`, only directories inside it.
 */
async function pruneEmptiedDirs(
  root: string,
  removed: readonly string[],
  scope?: PruneScope,
  keep?: ReadonlySet<string>,
  emptyDirs: readonly string[] = [],
  keepOpen = false,
): Promise<void> {
  const rootResolved = path.resolve(root)
  // LEVEL ORDER: a parent is tried only after all its children, so the last
  // child empties it, at ONE rmdir per directory rather than one per directory
  // per child.
  let level = new Set([...removed.map((f) => path.dirname(f)), ...emptyDirs])
  // A subdirectory of a read-only directory of this user's is removed as
  // `removeAll` removes a file there.
  const reopened: Reopened = new Map()
  const gone = (err: NodeJS.ErrnoException): boolean => err.code === 'ENOENT'
  const denied = (err: NodeJS.ErrnoException, dir: string): boolean =>
    err.code === 'EACCES' && reopenDir(path.dirname(dir), reopened)
  try {
    while (level.size > 0) {
      const parents = new Set<string>()
      const dirs = [...level].filter(
        (dir) =>
          dir !== rootResolved &&
          dir.startsWith(rootResolved + path.sep) &&
          (scope === undefined || inScope(dir, scope)) &&
          keep?.has(dir) !== true,
      )
      if (dirs.length <= SYNC_CLEAN_MAX) {
        for (const dir of dirs) {
          try {
            try {
              rmdirSync(dir)
            } catch (err) {
              if (!denied(err as NodeJS.ErrnoException, dir)) throw err
              rmdirSync(dir)
            }
            parents.add(path.dirname(dir))
          } catch (err) {
            if (gone(err as NodeJS.ErrnoException)) parents.add(path.dirname(dir))
          }
        }
      } else {
        await Promise.all(
          dirs.map(async (dir) => {
            const ok = await rmdir(dir)
              .catch((err: NodeJS.ErrnoException) => {
                if (!denied(err, dir)) throw err
                return rmdir(dir)
              })
              .then(() => true, gone)
            if (ok) parents.add(path.dirname(dir))
          }),
        )
      }
      level = parents
    }
  } finally {
    if (!keepOpen) giveBack(reopened)
  }
}

interface PruneScope {
  /** Wildcard globs' roots (`dist` for `dist/**`): prune strictly below. */
  below: string[]
  /** Literal outputs (`out` as a tree): prune the path itself and below. */
  atOrBelow: string[]
}

/**
 * Where a clean may prune: only the trees the task declared. A directory above
 * a glob's root or holding a literal output stays: a sibling task may have just
 * made it. A glob's root stays: the task writes under it. A literal's own path
 * goes. A glob rooted at the project prunes nothing.
 */
function pruneScope(base: string, outputs: readonly string[]): PruneScope {
  const scope: PruneScope = { below: [], atOrBelow: [] }
  for (const g of outputs) {
    if (g.startsWith('!')) continue
    // `literalPath`, as `asTrees` reads it: an escaped `out/\[x\]` is one path.
    const lit = literalPath(normalizeGlob(g))
    if (lit !== null) {
      scope.atOrBelow.push(path.resolve(base, stripTrailingSlash(lit)))
      continue
    }
    const prefix = staticPrefix(g)
    if (prefix !== '.') scope.below.push(path.resolve(base, prefix))
  }
  return scope
}

function inScope(dir: string, scope: PruneScope): boolean {
  return (
    scope.below.some((r) => dir.startsWith(r + path.sep)) ||
    scope.atOrBelow.some((r) => dir === r || dir.startsWith(r + path.sep))
  )
}

/**
 * Resolve `outputs.workspaceFiles` globs to produced files, anchored at the
 * workspace root with NO project exclusion: workspace outputs are the
 * documented escape hatch.
 */
export async function resolveWorkspaceOutputs(
  args: {
    workspaceRoot: string
    outputs: readonly string[]
    inputs?: OwnInputs | undefined
    clearing?: boolean
  },
  emptyDirs?: Set<string>,
  special?: SpecialProbe,
): Promise<string[]> {
  const { positive, negative } = splitNegations(args.outputs)
  if (positive.length === 0) return []
  const excluded = outputExcludes(positive, negative, 'workspace')
  const trees = asTrees(positive)
  const absent = refuseDirLinkedOut(args.workspaceRoot, trees, 'workspace', args.inputs)
  const scanned = [
    ...(await scanUnion(
      trees,
      excluded,
      args.workspaceRoot,
      undefined,
      emptyDirs,
      special,
      absent,
      args.clearing,
    )),
  ]
  // Same containment as the project twin, one level out: these globs may cross
  // projects, never the workspace, and `cleanWorkspaceOutputs` deletes what
  // this returns.
  return containedIn(args.workspaceRoot, scanned).sort()
}

/** `resolveOutputTree` for `outputs.workspaceFiles`: the files and the empty directories. */
export async function resolveWorkspaceOutputTree(args: {
  workspaceRoot: string
  outputs: readonly string[]
  /** As `resolveOutputTree`'s. */
  inputs?: OwnInputs | undefined
  /** As `resolveOutputTree`'s. */
  special?: boolean | 'later'
  clearing?: boolean
}): Promise<OutputTree> {
  const emptyDirs = new Set<string>()
  const probe: SpecialProbe | undefined =
    args.special === undefined || args.special === false ? undefined : {}
  const files = await resolveWorkspaceOutputs(args, emptyDirs, probe)
  return treeOf(args.workspaceRoot, files, emptyDirs, args.special, probe)
}

/**
 * `cleanOutputs` for workspace outputs. Returns the removed root-relative paths
 * for `GitFilesCache.markWorkspaceOutputsChanged`.
 */
export async function cleanWorkspaceOutputs(args: {
  workspaceRoot: string
  outputs: readonly string[]
  inputs?: OwnInputs | undefined
  committed?: (abs: string) => boolean
  /** `cleanOutputs`'s `resolved`, from `resolveWorkspaceOutputs`. */
  resolved?: readonly string[] | undefined
  /** As `cleanOutputs`'s. */
  beforeRun?: boolean
  /** As `cleanOutputs`'s. */
  kept?: string[]
}): Promise<string[]> {
  const committed = committedPastLinks(
    args.workspaceRoot,
    args.committed ?? committedFiles(undefined, args.workspaceRoot),
  )
  sweepRestoreTemps(args.workspaceRoot, args.outputs, committed)
  const tree =
    args.resolved === undefined
      ? await resolveWorkspaceOutputTree({ ...args, special: true, clearing: true })
      : { files: args.resolved, emptyDirs: [], special: [] }
  const matched = tree.files
  await pruneEmptiedDirs(
    args.workspaceRoot,
    await removeAll(
      [...matched, ...tree.special].filter((f) => !keptCommitted(f, committed, args.kept)),
      args.workspaceRoot,
      args.beforeRun,
    ),
    pruneScope(args.workspaceRoot, args.outputs),
    undefined,
    tree.emptyDirs,
    args.beforeRun,
  )
  return matched.map((f) => relPosix(args.workspaceRoot, f))
}

function keptCommitted(
  abs: string,
  committed: (abs: string) => boolean,
  kept: string[] | undefined,
): boolean {
  if (!committed(abs)) return false
  kept?.push(abs)
  return true
}

function realOrNull(p: string): string | null {
  try {
    return realpathOf(p)
  } catch {
    return null
  }
}

// Re-exported from `util/paths.ts`, where the graph's overlap refusal can read
// the same rule.
export { asTrees } from '../util/index.js'

/**
 * The literals no path in `files` answers (by itself or anything under it). Git
 * lists in order, so a binary search answers; a listing out of code-unit order
 * (git sorts bytes) can hide one, so only a walk says a literal is unanswered.
 */
function unanswered(
  literals: readonly string[],
  files: readonly string[],
  newIgnored?: (lit: string) => boolean,
): Set<string> {
  return new Set(
    reachingIgnored(
      literals,
      (lit) => {
        const under = `${lit}/`
        return (
          files[lowerBound(files, lit)] === lit ||
          files[lowerBound(files, under)]?.startsWith(under) === true ||
          files.some((rel) => rel === lit || rel.startsWith(under))
        )
      },
      newIgnored,
    ),
  )
}

/**
 * How a named entry reaches git-ignored files: git lists nothing at or under
 * it, or ignores a new file directly in it (a kept `gen/.gitkeep`).
 */
function reachingIgnored(
  named: readonly string[],
  listed: (entry: string) => boolean,
  newIgnored?: (entry: string) => boolean,
): string[] {
  return named.filter((n) => !listed(n) || newIgnored?.(n) === true)
}

/**
 * The entries of `named` a git-ignored input can be at or under, by the key's
 * rule. Watch asks it, so an ignored file no key reads starts no cycle.
 */
export function namedIgnoredReach(
  root: string,
  named: readonly string[],
  listed: ReadonlySet<string>,
): string[] {
  const held = named.filter((n) => listed.has(n))
  const fresh =
    held.length === 0
      ? new Set<string>()
      : newFilesIgnoredIn(
          root,
          held.map((n) => relPosix(root, n)),
        )
  return reachingIgnored(
    named,
    (n) => listed.has(n),
    (n) => fresh.has(relPosix(root, n)),
  )
}

/** The first index whose path is not below `key`. */
function lowerBound(files: readonly string[], key: string): number {
  let lo = 0
  let hi = files.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (files[mid]! < key) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The entries a declaration names outright that git answers nothing for: a
 * literal or a glob's fixed prefix with no listed path under it. Naming it is
 * asking for it, so {@link ignoredInputs} reads it from disk. A broad glob
 * reaches no ignored file: `node_modules` is never walked.
 */
function ignoredReach(
  reach: { prefixes: readonly string[]; literals: readonly string[] },
  listed: readonly string[],
  ignoredIn?: { dir: string; cache: GitFilesCache | undefined },
): readonly string[] {
  let named = outrightMemo.get(reach)
  if (named === undefined) outrightMemo.set(reach, (named = outright(reach)))
  if (named.length === 0) return []
  // Per listing and entries: thousands of tasks share a few declarations.
  let memo = reachMemo.get(listed)
  if (memo === undefined) reachMemo.set(listed, (memo = new Map()))
  const key = named.join('\0')
  let left = memo.get(key)
  if (left === undefined) {
    // A listed path under an otherwise ignored named directory (`gen/.gitkeep`)
    // must not answer for the whole of it.
    const cache = ignoredIn?.cache
    const newIgnored =
      cache === undefined
        ? undefined
        : (lit: string) => cache.newFilesIgnored(path.resolve(ignoredIn!.dir, lit))
    memo.set(key, (left = [...unanswered(named, listed, newIgnored)]))
  }
  return left
}

const reachMemo = new WeakMap<readonly string[], Map<string, readonly string[]>>()
// A declaration's plan is memoized, so its entries are reckoned once.
const outrightMemo = new WeakMap<object, string[]>()

/**
 * A declaration's literals and fixed prefixes, each once: none for a glob
 * starting with a wildcard or leaving its directory.
 */
function outright(reach: { prefixes: readonly string[]; literals: readonly string[] }): string[] {
  return [
    ...new Set(
      [...reach.literals, ...reach.prefixes].filter(
        (p) => p !== '' && p !== '.' && p !== '..' && !p.startsWith('../') && !path.isAbsolute(p),
      ),
    ),
  ]
}

/**
 * The files on disk under the {@link ignoredReach} entries that `accept` keeps,
 * sorted and absolute, hashed like any untracked file. `node_modules` is no
 * special case: an ignored path named outright
 * (`node_modules/.prisma/client/**`) is an input. lstat, not `exists()`, which
 * is false for a directory. Never memoized: a dependency writes these mid-run.
 * Nothing under `vxDirs` is read, or a task over its own cache dir never hits.
 * Links are not followed, so a link to a directory a glob may reach below is an
 * input itself.
 */
function ignoredInputs(
  root: string,
  reach: readonly string[],
  accept: (rel: string) => boolean,
  linked: (rel: string) => boolean,
  vxDirs: readonly string[] = [],
): string[] {
  const found = new Set<string>()
  const vxOwn = (abs: string) => vxDirs.some((d) => abs === d || abs.startsWith(d + path.sep))
  for (const entry of reach) {
    const abs = path.resolve(root, entry)
    if (vxOwn(abs)) continue
    const st = lstatOrAbsent(abs)
    if (st === undefined) continue
    if (!st.isDirectory()) {
      if ((st.isFile() || st.isSymbolicLink()) && accept(entry)) found.add(abs)
      continue
    }
    try {
      for (const rel of WALK.scanSync({
        cwd: abs,
        onlyFiles: false,
        followSymlinks: false,
        dot: true,
      })) {
        const full = `${entry}/${rel.split(path.sep).join('/')}`
        const file = path.join(abs, rel)
        if (vxOwn(file)) continue
        if (accept(full)) {
          if (isInputOnDisk(file)) found.add(file)
        } else if (linked(full) && dirLinkInput(file, undefined)) found.add(file)
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'EACCES' || e.path === undefined) throw err
      // The walk stops at a directory it cannot list: its files would be in no
      // key. Named as what it is.
      throw new UserError(
        `cannot list input directory ${relPosix(root, path.resolve(abs, e.path))}: EACCES — ` +
          `no key would see the files under it; give this user read and search permission ` +
          `on it (chmod u+rx), or stop declaring it as an input`,
      )
    }
  }
  return [...found].sort()
}

const WALK = new Bun.Glob('**')

interface ResolveFilesArgs {
  projectDir: string
  workspaceRoot: string
  files: readonly string[] | undefined
  ownOutputs: readonly string[]
  /** Root-relative `outputs.workspaceFiles`, and the project's root-relative directory. */
  ownWorkspaceOutputs: readonly string[]
  projectRel: string
  nestedProjectDirs: string[]
  gitFilesCache?: GitFilesCache
  projectFilesCache?: ProjectFilesCache
}

/**
 * Record the names a fresh `git ls-files` could not decode, and return the set
 * to check against.
 */
function noteUndecodable(
  cache: GitFilesCache | undefined,
  dir: string,
  rels: readonly string[],
): ReadonlySet<string> {
  const abs = rels.map((rel) => path.join(dir, rel))
  if (cache === undefined) return new Set(abs)
  cache.markUndecodable(abs)
  return cache.undecodableNames
}

/**
 * An input whose name is not UTF-8 is one vx cannot open, so it would silently
 * drop out of the key. Named instead, with the way out.
 */
function refuseUndecodable(
  candidates: readonly string[],
  undecodable: ReadonlySet<string> | undefined,
  root: string,
  field: 'files' | 'workspaceFiles',
): void {
  if (undecodable === undefined || undecodable.size === 0) return
  const bad = candidates.filter((abs) => undecodable.has(abs) && undecodableOnDisk(abs))
  if (bad.length === 0) return
  const names = bad.map((abs) => JSON.stringify(relPosix(root, abs)))
  throw new UserError(
    `inputs.${field} matched ${names.join(', ')} in ${root}: the name is not valid UTF-8 ` +
      `(shown with \ufffd), and vx cannot read a file by it. Rename it, or exclude it with a ` +
      `negated glob.`,
  )
}

/** What a `files` declaration and its task's outputs compile to, whatever the project. */
interface FilesPlan {
  positive: string[]
  negative: string[]
  isExcluded: (rel: string) => boolean
  ownOutput: (rel: string) => boolean
  positiveGlobs: Bun.Glob[]
  isPositive: (rel: string) => boolean
  /** Whether a positive glob may match a path under `rel` (`mayHoldMatch`). */
  mayHold: (rel: string) => boolean
  /** The literal entries, each naming one path (see `unanswered`). */
  literals: string[]
  /** The directories a positive entry reaches; see `InputListing`. */
  prefixes: string[]
  /**
   * Whether a project-relative path is an input by the declaration alone. Each
   * path is matched once per plan.
   */
  verdicts: Map<string, boolean>
  /**
   * Whether a path is under the task's own outputs and not vx's: one git tracks
   * is an input whether or not a glob reaches it, since a hit writes over it. A
   * `!` entry does not take it back: `!dist/**` would drop the committed
   * `dist/LICENSE`, and a hit would write old bytes over an edit.
   */
  ownOnly: Map<string, boolean>
  isIgnored: (rel: string) => boolean
}

/**
 * Compiled once per declaration for the process: a handful of `files` lists
 * over thousands of tasks. A refused declaration is never stored, so it throws
 * for every task.
 */
const filesPlans = new Map<string, FilesPlan | null>()

function filesPlan(
  files: readonly string[] | undefined,
  ownOutputs: readonly string[],
): FilesPlan | null {
  const key = JSON.stringify([files ?? null, ownOutputs])
  const memo = filesPlans.get(key)
  if (memo !== undefined) return memo
  const positive: string[] = []
  const negative: string[] = []
  if (files === undefined) {
    positive.push(...DEFAULT_FILE_GLOBS)
  } else {
    for (const entry of files) {
      if (entry.startsWith('!')) negative.push(entry.slice(1))
      else positive.push(entry)
    }
  }
  // Outputs alone still make a plan: a committed file under them is keyed.
  const plan =
    positive.length === 0 && splitNegations(ownOutputs).positive.length === 0
      ? null
      : {
          positive,
          negative,
          isExcluded: anyTaskGlob([...ALWAYS_IGNORE, ...asTrees(negative)]),
          // A path the task's own outputs take back with `!` stays an input.
          ownOutput: outputMatcher(ownOutputs),
          positiveGlobs: asTrees(positive).map(globFor),
          isPositive: throughLinks(positive, anyTaskGlob(asTrees(positive))),
          mayHold: mayHoldMatch(positive),
          ...reachOf(positive),
          verdicts: new Map<string, boolean>(),
          ownOnly: new Map<string, boolean>(),
          isIgnored: anyTaskGlob(ALWAYS_IGNORE),
        }
  filesPlans.set(key, plan)
  return plan
}

/**
 * `isPositive`, and each path a glob's static directory passes through: git
 * lists a linked directory as one path, so `lib/**` over `lib -> ../shared`
 * would match nothing. The link is then an input, keying every file behind it.
 */
function throughLinks(
  positive: readonly string[],
  isPositive: (rel: string) => boolean,
): (rel: string) => boolean {
  const through = new Set<string>()
  // Each brace alternative by its own prefix: whole, `{lib,src}/**` has none.
  for (const g of positive.flatMap(braceAlternatives)) {
    const prefix = staticPrefix(g)
    if (prefix === '.' || prefix === '' || path.isAbsolute(prefix)) continue
    const parts = prefix.split('/')
    for (let i = 1; i <= parts.length; i++) through.add(parts.slice(0, i).join('/'))
  }
  return through.size === 0 ? isPositive : (rel) => isPositive(rel) || through.has(rel)
}

/**
 * Whether a positive glob may match under `rel`, by each alternative's prefix
 * and depth. A link below a prefix is listed as one path, so a link to a
 * directory there is an input (`dirLinkInput`). Generous on purpose: a wrong
 * yes costs one lookup.
 *
 * Asked of every path no glob takes, so the prefixes are a map walked by the
 * path's own `/`s, not a scan of every prefix per path.
 */
export function mayHoldMatch(positive: readonly string[]): (rel: string) => boolean {
  // A prefix ends in `/` or is empty, so the ones a path starts with end at its
  // own `/`s.
  const byPrefix = new Map<string, { deep: boolean; depth: number }>()
  for (const r of holdReach(positive)) {
    const seen = byPrefix.get(r.prefix)
    if (seen === undefined) byPrefix.set(r.prefix, { deep: r.deep, depth: r.depth })
    else {
      seen.deep ||= r.deep
      seen.depth = Math.max(seen.depth, r.depth)
    }
  }
  if (byPrefix.size === 0) return () => false
  return (rel) => {
    let slashes = 0
    for (let i = 0; i < rel.length; i++) if (rel.charCodeAt(i) === 47) slashes++
    const depth = slashes + 1
    let r = rel.length > 0 ? byPrefix.get('') : undefined
    if (r !== undefined && (r.deep || depth < r.depth)) return true
    for (let i = rel.indexOf('/'); i !== -1 && i < rel.length - 1; i = rel.indexOf('/', i + 1)) {
      r = byPrefix.get(rel.slice(0, i + 1))
      if (r !== undefined && (r.deep || depth < r.depth)) return true
    }
    return false
  }
}

/** Each positive alternative's fixed prefix (`''` or ending in `/`), whether it has a `**`, and its depth. */
export function holdReach(
  positive: readonly string[],
): { prefix: string; deep: boolean; depth: number }[] {
  return asTrees(positive.flatMap(braceAlternatives)).map((g) => {
    const prefix = staticPrefix(g)
    return {
      prefix: prefix === '.' ? '' : `${prefix}/`,
      deep: g.includes('**'),
      depth: g.split('/').length,
    }
  })
}

/** A name no file holds: only a `!` entry that takes back a whole tree matches it. */
const BENEATH = '\0'

/**
 * Whether the `!` entries take back every path under `rel`, a link to a
 * directory: a negation applies to the files behind it, never the link's own
 * name. Two depths, so `!l/*` alone keeps the link.
 */
function excludedBeneath(isExcluded: (rel: string) => boolean, rel: string): boolean {
  return isExcluded(`${rel}/${BENEATH}`) && isExcluded(`${rel}/${BENEATH}/${BENEATH}`)
}

/**
 * Whether `abs` is a link to a directory. A trusted OID answers for a tracked
 * file with no syscall.
 */
function dirLinkInput(abs: string, oids: ReadonlyMap<string, string> | undefined): boolean {
  const oid = oids?.get(abs)
  if (oid !== undefined && !oid.startsWith('120000:')) return false
  try {
    return lstatSync(abs).isSymbolicLink() && statSync(abs).isDirectory()
  } catch {
    return false
  }
}

/**
 * Whether a changed path is one of a task's declared file inputs, by
 * `projectRel` against `files` and `workspaceRel` against `workspaceFiles`
 * (null skips that half). A committed path under the task's own outputs counts.
 * `--affected` seeds a task with it.
 */
export function declaresInput(
  task: TaskConfig,
  projectRel: string | null,
  workspaceRel: string | null,
  /**
   * A link to a directory, now or before: a glob that may reach below keys what
   * is behind it.
   */
  dirLink = false,
  /** Git does not track the path, so under the task's own outputs it is no input. */
  untracked = false,
  /**
   * The task's project directory: a `workspaceFiles` glob reaches its
   * `outputs.files` too, which the key leaves out.
   */
  projectDir?: string,
): boolean {
  const inputs = task.inputs
  if (inputs === undefined) return false
  if (projectRel !== null) {
    // Under the task's own outputs the key folds only what git tracks.
    const plan = filesPlan(inputs.files, task.outputs?.files ?? [])
    if (plan !== null && (inPlan(plan, projectRel) || (!untracked && ownOnly(plan, projectRel)))) {
      return true
    }
    if (
      plan !== null &&
      dirLink &&
      plan.mayHold(projectRel) &&
      !excludedBeneath(plan.isExcluded, projectRel)
    ) {
      return true
    }
  }
  const ws = inputs.workspaceFiles
  if (workspaceRel === null || ws === undefined || ws.length === 0) return false
  if (!workspaceMatcher(ws)(workspaceRel, dirLink)) return false
  // As for `files`: under its own outputs the key folds only a tracked path.
  return !untracked || !ownWorkspaceOutput(task, workspaceRel, projectDir)
}

/** Asked only of an untracked path a `workspaceFiles` glob matched: rare, so not memoised. */
function ownWorkspaceOutput(task: TaskConfig, rel: string, projectDir?: string): boolean {
  const outputs = task.outputs
  if (outputMatcher(outputs?.workspaceFiles ?? [])(rel)) return true
  if (projectDir === undefined) return false
  return underProject(projectDir, outputMatcher(outputs?.files ?? []))(rel)
}

/**
 * Whether a task's `workspaceFiles` may name a file under `dir`: a nested
 * repository is reported as that one path. By static prefixes, so a descending
 * glob counts.
 */
export function workspaceFilesReachInto(task: TaskConfig, dir: string): boolean {
  const ws = task.inputs?.workspaceFiles
  if (ws === undefined || ws.length === 0) return false
  return reaches(reachOf(splitNegations(ws).positive).prefixes, dir)
}

/** The paths a task names outright: where a gitignored input can be. */
export function namedOutright(task: TaskConfig): { files: string[]; workspaceFiles: string[] } {
  const inputs = task.inputs
  const plan = inputs === undefined ? null : filesPlan(inputs.files, task.outputs?.files ?? [])
  const ws = inputs?.workspaceFiles ?? []
  return {
    files: plan === null ? [] : outright(plan),
    workspaceFiles: ws.length === 0 ? [] : outright(reachOf(splitNegations(ws).positive)),
  }
}

function inPlan(plan: FilesPlan, rel: string): boolean {
  let input = plan.verdicts.get(rel)
  if (input === undefined) {
    input = plan.isPositive(rel) && !plan.isExcluded(rel) && !plan.ownOutput(rel)
    plan.verdicts.set(rel, input)
  }
  return input
}

/** `FilesPlan.ownOnly`, memoised: asked only of a path `inPlan` refused. */
function ownOnly(plan: FilesPlan, rel: string): boolean {
  let own = plan.ownOnly.get(rel)
  if (own === undefined) {
    own = plan.ownOutput(rel) && !plan.isIgnored(rel)
    plan.ownOnly.set(rel, own)
  }
  return own
}

const workspaceMatchers = new Map<string, (rel: string, dirLink: boolean) => boolean>()

function workspaceMatcher(decl: readonly string[]): (rel: string, dirLink: boolean) => boolean {
  const key = JSON.stringify(decl)
  let m = workspaceMatchers.get(key)
  if (m !== undefined) return m
  const { positive, negative } = splitNegations(decl)
  const isPositive = throughLinks(positive, anyTaskGlob(asTrees(positive)))
  const mayHold = mayHoldMatch(positive)
  const isExcluded = anyTaskGlob([...WORKSPACE_ALWAYS_IGNORE, ...asTrees(negative)])
  m = (rel, dirLink) =>
    (isPositive(rel) && !isExcluded(rel)) ||
    (dirLink && mayHold(rel) && !excludedBeneath(isExcluded, rel))
  workspaceMatchers.set(key, m)
  return m
}

async function resolveFiles(
  args: ResolveFilesArgs,
): Promise<{ files: string[]; listing?: InputListing }> {
  const plan = filesPlan(args.files, args.ownOutputs)
  if (plan === null) return { files: [] }
  const { isExcluded, ownOutput, positiveGlobs, isPositive } = plan

  const nested = inNestedProject(args.projectDir, args.nestedProjectDirs)
  // Its root-anchored outputs that land in the project, as `files` sees them.
  const ownWsOutput = inProject(args.projectRel, outputMatcher(args.ownWorkspaceOutputs))

  // Everything below the snapshot that decides the result: the project, its
  // declaration, its own outputs and the boundaries.
  const memoKey = filesMemoKey(
    args.projectDir,
    plan,
    args.ownOutputs,
    args.ownWorkspaceOutputs,
    args.nestedProjectDirs,
  )
  let gitFiles = args.gitFilesCache?.snapshotFor(args.projectDir, positiveGlobs)
  let undecodable = args.gitFilesCache?.undecodableNames
  if (gitFiles !== undefined) {
    const memo = args.projectFilesCache?.get(memoKey)
    // Identity, not equality: a re-enumeration hands back a new array, and that
    // is when inputs must be walked again.
    if (memo !== undefined && memo.snapshot === gitFiles) {
      return {
        files: withIgnored(
          args.projectDir,
          memo.result,
          ignoredReach(plan, gitFiles, { dir: args.projectDir, cache: args.gitFilesCache }),
          plan,
          nested,
          ownWsOutput,
          args.gitFilesCache,
        ),
        listing: listingFor(args, gitFiles, plan, nested, ownWsOutput),
      }
    }
  }
  if (gitFiles === undefined) {
    // Mid-run re-enumeration, or a project git's workspace-wide pass did not
    // see (a submodule): spawned in the project dir. Its OIDs are NOT trusted
    // (no fresh `git status` vouches); these files fall back to `hashFile`,
    // which computes the same blob OID.
    const ls = runGitLsFiles(args.projectDir, listingEnv(args.projectDir, args.workspaceRoot))
    gitFiles = ls.files
    // set() also clears the project's pending-changed bookkeeping.
    args.gitFilesCache?.set(args.projectDir, gitFiles)
    undecodable = noteUndecodable(args.gitFilesCache, args.projectDir, ls.undecodable)
  }
  // A LITERAL entry names one file, so matching nothing is unambiguous (a glob
  // may legitimately match nothing). Tracked because the globs FILTER git's
  // set: naming a gitignored file folds nothing, silently, and the task replays
  // a stale artifact. Git prints normalized relative paths, so a join is
  // concatenation (`path.resolve` per file was ~27 ms of a warm run).
  const base =
    path.sep === '/' &&
    path.isAbsolute(args.projectDir) &&
    path.normalize(args.projectDir) === args.projectDir
      ? args.projectDir.endsWith('/')
        ? args.projectDir
        : `${args.projectDir}/`
      : undefined
  const candidates: string[] = []
  const verdicts = plan.verdicts
  const committed = committedFiles(args.gitFilesCache, args.projectDir)
  const oids = args.gitFilesCache?.oidsFor(args.projectDir)
  const paths = base === undefined ? undefined : args.gitFilesCache?.absPaths(gitFiles)
  for (let i = 0; i < gitFiles.length; i++) {
    const rel = gitFiles[i]!
    let input = verdicts.get(rel)
    if (input === undefined) {
      input = isPositive(rel) && !isExcluded(rel) && !ownOutput(rel)
      verdicts.set(rel, input)
    }
    if (nested(rel) || ownWsOutput(rel)) continue
    const abs = base === undefined ? path.resolve(args.projectDir, rel) : (paths?.[i] ?? base + rel)
    if (!input && !ownOnly(plan, rel)) {
      if (
        plan.mayHold(rel) &&
        !excludedBeneath(isExcluded, rel) &&
        !ownOutput(rel) &&
        dirLinkInput(abs, oids)
      ) {
        candidates.push(paths === undefined ? abs : (paths[i] = abs))
      }
      continue
    }
    if (!input && !committed(abs)) continue
    candidates.push(paths === undefined ? abs : (paths[i] = abs))
  }
  const reach = ignoredReach(plan, gitFiles, { dir: args.projectDir, cache: args.gitFilesCache })
  refuseUndecodable(candidates, undecodable, args.projectDir, 'files')
  // Existence check only for paths without a trusted OID: a clean tracked file
  // exists. `git ls-files -s` can list a staged entry whose file is gone.
  const resolved = candidates.filter(
    (abs) => oids?.has(abs) === true || inputOnDisk(abs, args.gitFilesCache),
  )
  // Git's slice comes sorted and a common prefix keeps it so: one pass proves
  // it.
  for (let i = 1; i < resolved.length; i++) {
    if (resolved[i - 1]! > resolved[i]!) {
      resolved.sort()
      break
    }
  }
  args.projectFilesCache?.set(memoKey, { snapshot: gitFiles, result: resolved })
  return {
    files: withIgnored(
      args.projectDir,
      resolved,
      reach,
      plan,
      nested,
      ownWsOutput,
      args.gitFilesCache,
    ),
    listing: listingFor(args, gitFiles, plan, nested, ownWsOutput),
  }
}

/** The resolved files, plus the gitignored ones the declaration names outright. */
function withIgnored(
  projectDir: string,
  resolved: readonly string[],
  reach: readonly string[],
  plan: FilesPlan,
  nested: (rel: string) => boolean,
  ownWsOutput: (rel: string) => boolean,
  cache: GitFilesCache | undefined,
): string[] {
  if (reach.length === 0) return [...resolved]
  const extra = ignoredInputs(
    projectDir,
    reach,
    (rel) => inPlan(plan, rel) && !nested(rel) && !ownWsOutput(rel),
    (rel) =>
      plan.mayHold(rel) &&
      !excludedBeneath(plan.isExcluded, rel) &&
      !plan.ownOutput(rel) &&
      !nested(rel) &&
      !ownWsOutput(rel),
    cache?.vxDirs,
  )
  return extra.length === 0 ? [...resolved] : mergeSorted(resolved, extra)
}

function listingFor(
  args: { projectDir: string; workspaceRoot: string; gitFilesCache?: GitFilesCache | undefined },
  listed: readonly string[],
  plan: FilesPlan,
  nested: (rel: string) => boolean,
  ownWsOutput: (rel: string) => boolean,
): InputListing {
  const root = args.projectDir
  let committed: ((abs: string) => boolean) | undefined
  return {
    root,
    workspaceRoot: args.workspaceRoot,
    listed,
    isInput: (rel) =>
      (inPlan(plan, rel) ||
        (ownOnly(plan, rel) &&
          (committed ??= committedFiles(args.gitFilesCache, root))(path.join(root, rel)))) &&
      !ownWsOutput(rel),
    linked: (rel) =>
      plan.mayHold(rel) &&
      !excludedBeneath(plan.isExcluded, rel) &&
      !plan.ownOutput(rel) &&
      !ownWsOutput(rel),
    nested,
    prefixes: plan.prefixes,
    literals: plan.literals,
  }
}

/**
 * `Bun.Glob` decodes a non-UTF-8 name lossily, so the path names no file and
 * the output would silently drop out of the artifact (turborepo#9345's output
 * half). `undecodableOnDisk` tells it from a file that left mid-scan.
 * `clearing`: the walk feeds a clean or restore.
 */
function refuseUndecodableOutput(abs: string, clearing: boolean): void {
  if (!undecodableOnDisk(abs)) return
  const why = clearing
    ? 'vx cannot clear a file by it before the task runs or a hit restores'
    : 'vx cannot save a file by it'
  throw new UserError(
    `outputs matched ${JSON.stringify(abs)}: the name is not valid UTF-8 (shown with ` +
      `\ufffd), and ${why}. Rename it, or keep it out of the outputs.`,
  )
}

/**
 * Is `abs`, a lossy spelling, something on disk whose name or an ancestor's is
 * not UTF-8? Read raw names from the deepest reachable ancestor. Only a failed
 * stat gets here, off every warm path.
 */
function undecodableOnDisk(abs: string): boolean {
  let dir = path.dirname(abs)
  let next = path.basename(abs)
  while (!existsOnDisk(dir)) {
    const parent = path.dirname(dir)
    if (parent === dir) return false
    next = path.basename(dir)
    dir = parent
  }
  let raw: Buffer[]
  try {
    raw = readdirSync(dir, { encoding: 'buffer' })
  } catch {
    return false
  }
  const lossy = new TextDecoder('utf-8', { ignoreBOM: true })
  for (const name of raw) {
    if (lossy.decode(name) !== next) continue
    try {
      FATAL_UTF8.decode(name)
    } catch {
      return true
    }
  }
  return false
}

/** The listing a task's inputs were filtered from, and how to read it again. */
export interface InputListing {
  root: string
  /** Where git's location variables point; `root` in a repository below it is listed without them. */
  workspaceRoot: string
  /** Root-relative paths, as git listed them. */
  listed: readonly string[]
  isInput: (rel: string) => boolean
  /**
   * Whether a link to a directory at `rel` is an input: a glob may match below
   * it though its name fits none.
   */
  linked: (rel: string) => boolean
  nested: (rel: string) => boolean
  /** Root-relative directories a positive entry reaches, `''` for the root. */
  prefixes: readonly string[]
  /** The literal entries, each naming one path. */
  literals: readonly string[]
}

function reachOf(entries: readonly string[]): { prefixes: string[]; literals: string[] } {
  // Each alternative names what it would alone: whole, `{gen/a.txt,gen/b.txt}`
  // had no fixed prefix.
  const positive = entries.flatMap(braceAlternatives)
  const prefixes = new Set<string>()
  for (const p of asTrees(positive)) {
    if (isLiteralPattern(p)) continue
    const prefix = staticPrefix(p)
    prefixes.add(prefix === '.' ? '' : prefix)
  }
  return {
    prefixes: [...prefixes],
    literals: positive.map(normalizeGlob).filter(isLiteralPattern).map(stripTrailingSlash),
  }
}

/** Every directory holding a listed path, `''` for the root, once per listing. */
const listedDirsMemo = new WeakMap<readonly string[], Set<string>>()
function listedDirs(listed: readonly string[]): Set<string> {
  let dirs = listedDirsMemo.get(listed)
  if (dirs !== undefined) return dirs
  dirs = new Set([''])
  for (const rel of listed) {
    for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) {
      const dir = rel.slice(0, i)
      if (dirs.has(dir)) break
      dirs.add(dir)
    }
  }
  listedDirsMemo.set(listed, dirs)
  return dirs
}

function reaches(prefixes: readonly string[], rel: string): boolean {
  return prefixes.some(
    (p) => p === '' || rel === p || rel.startsWith(`${p}/`) || p.startsWith(`${rel}/`),
  )
}

/**
 * An input file that exists now and that the key did not fold, or undefined: a
 * file ADDED under an input glob while the command ran would be saved under a
 * key without it.
 *
 * Adding a name changes its directory's ctime, so the listing's directories a
 * positive entry reaches are stat'ed and only one changed since `listedAt` is
 * read; its unknown names go to git, which alone knows what is ignored. Not
 * seen: a file added in a directory that held no listed file and was not itself
 * made during the run.
 */
export function addedInput(
  listings: readonly InputListing[],
  keyFiles: ReadonlySet<string>,
  listedAt: number,
): string | undefined {
  for (const l of listings) {
    const found = addedTo(l, keyFiles, listedAt)
    if (found !== undefined) return found
  }
  return undefined
}

function addedTo(
  l: InputListing,
  keyFiles: ReadonlySet<string>,
  listedAt: number,
): string | undefined {
  const candidates: string[] = []
  for (const lit of l.literals) {
    if (l.nested(lit) || keyFiles.has(path.resolve(l.root, lit))) continue
    if (existsOnDisk(path.resolve(l.root, lit))) candidates.push(lit)
  }
  const known = listedDirs(l.listed)
  for (const dir of known) {
    if (!reaches(l.prefixes, dir) || (dir !== '' && l.nested(`${dir}/`))) continue
    const abs = dir === '' ? l.root : path.resolve(l.root, dir)
    let entries
    try {
      const st = lstatSync(abs, { throwIfNoEntry: false })
      if (st === undefined) continue
      if (st.ctimeMs < listedAt - racyWindowMs(st.ctimeMs, FILE_HASH_RACY_MS)) continue
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      // Unreadable here: git answers for the whole directory instead.
      candidates.push(dir)
      continue
    }
    for (const e of entries) {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`
      if (e.isDirectory()) {
        if (known.has(rel) || e.name === 'node_modules' || l.nested(`${rel}/`)) continue
        if (reaches(l.prefixes, rel)) candidates.push(rel)
      } else if (
        (l.isInput(rel) ||
          (e.isSymbolicLink() &&
            l.linked(rel) &&
            dirLinkInput(path.resolve(abs, e.name), undefined))) &&
        !l.nested(rel) &&
        !isInstalledPath(rel) &&
        !keyFiles.has(path.resolve(abs, e.name))
      ) {
        candidates.push(rel)
      }
    }
  }
  if (candidates.length === 0) return undefined
  for (const rel of runGitLsFiles(l.root, listingEnv(l.root, l.workspaceRoot)).files) {
    if (!candidates.some((c) => c === '' || rel === c || rel.startsWith(`${c}/`))) continue
    if (isInstalledPath(rel) || l.nested(rel)) continue
    const abs = path.resolve(l.root, rel)
    if (!l.isInput(rel) && !(l.linked(rel) && dirLinkInput(abs, undefined))) continue
    if (!keyFiles.has(abs) && isInputOnDisk(abs)) return abs
  }
  return undefined
}

const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * The output files matching any positive pattern in `cwd`, minus excludes.
 * Yields SYMLINKS, never followed: the save keeps them and the clean must
 * remove them. Bun's `onlyFiles` walk drops symlinks, so this lists everything
 * and sorts by `lstat`. Synchronous: on the miss path the walk is CPU-bound.
 */
async function scanUnion(
  positive: readonly string[],
  excluded: (rel: string) => boolean,
  cwd: string,
  nested: (rel: string) => boolean = () => false,
  emptyDirs?: Set<string>,
  special?: SpecialProbe,
  absent?: ReadonlySet<string>,
  clearing = false,
): Promise<Set<string>> {
  const matches = new Set<string>()
  const links: string[] = []
  // Bun's scan skips FIFOs, sockets and devices, so `special` lists the
  // directories the walk entered. Derived only when asked.
  const roots = special === undefined ? undefined : new Set<string>()
  const dirs = special === undefined ? undefined : new Set<string>()
  const take = (rel: string): void => {
    if (nested(rel) || excluded(rel)) return
    const abs = path.resolve(cwd, rel)
    const st = lstatSync(abs, { throwIfNoEntry: false })
    if (st !== undefined && (st.isFile() || st.isSymbolicLink())) {
      matches.add(abs)
      if (st.isSymbolicLink()) links.push(abs)
    } else if (st?.isDirectory() === true) {
      dirs?.add(abs)
      if (emptyDirs !== undefined && readdirSync(abs).length === 0) emptyDirs.add(abs)
    } else if (st === undefined && rel.includes('\ufffd')) refuseUndecodableOutput(abs, clearing)
  }
  // A `<dir>/**` walk never yields its root, so an empty one would not be
  // saved. Not a link: its tree is the link's.
  const takeRoot = (rel: string): void => {
    if (emptyDirs === undefined || nested(rel) || excluded(rel)) return
    const abs = path.resolve(cwd, rel)
    if (lstatSync(abs, { throwIfNoEntry: false })?.isDirectory() !== true) return
    if (readdirSync(abs).length === 0) emptyDirs.add(abs)
  }
  const opts = { onlyFiles: false, followSymlinks: false, dot: true }
  // A directory the task left unlistable (`chmod 000 dist/s`) would fail every
  // later clean. A clean or restore walk opens this user's own and gives the
  // mode back; a save refuses it by path.
  const reopened: Reopened = new Map()
  const tried = new Set<string>()
  const walk = (glob: Bun.Glob, at: string, each: (rel: string) => void): void => {
    for (;;) {
      try {
        for (const rel of glob.scanSync({ ...opts, cwd: at })) each(rel)
        return
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code !== 'EACCES' || e.path === undefined) throw err
        const dir = path.resolve(at, e.path)
        // Under a directory with no search bit the refusal names its child: the
        // parent is the one to open.
        const open = (d: string): boolean => {
          if (tried.has(d)) return false
          tried.add(d)
          return reopenDir(d, reopened, 0o500)
        }
        if (!clearing || !(open(dir) || open(path.dirname(dir))))
          throw unlistedOutput(cwd, dir, clearing)
      }
    }
  }
  // `Bun.Glob` finds nothing for a brace whose alternatives hold a `/`
  // (`{dist,lib/esm}/**`): expanded here.
  const patterns = positive.flatMap(slashBraceExpansions)
  if (special !== undefined) {
    special.find = () => {
      const walked = new Set(roots)
      for (const f of [...matches, ...links]) walked.add(path.dirname(f))
      for (const d of dirs!) walked.add(d).add(path.dirname(d))
      const into = new Set<string>()
      findSpecial(walked, cwd, anyTaskGlob(patterns), excluded, nested, into)
      return [...into]
    }
  }
  // A leading `**` walks the whole project anyway, so the list is one walk. Not
  // through a static head that is a link: the one walk does not follow links.
  if (
    patterns.length > 1 &&
    patterns.some((p) => p.startsWith('**')) &&
    !patterns.some((p) => headLinked(cwd, p))
  ) {
    const any = anyTaskGlob(patterns)
    // A root with a child yielded is not empty: no second listing of it.
    const treeRoots = emptyDirs === undefined ? [] : patterns.flatMap((p) => treeRoot(p) ?? [])
    const bare = new Set<string>()
    const filled = new Set<string>()
    try {
      walk(WHOLE_TREE, cwd, (rel) => {
        if (any(rel)) take(rel)
        if (treeRoots.length === 0) return
        if (treeRoots.includes(rel)) bare.add(rel)
        filled.add(path.posix.dirname(rel))
      })
      for (const rel of bare) if (!filled.has(rel)) takeRoot(rel)
    } finally {
      giveBack(reopened)
    }
    return matches
  }
  try {
    for (const pattern of patterns) {
      if (absentPrefix(cwd, pattern, absent)) continue
      const from = scanRoot(cwd, pattern)
      if (from === null) continue
      roots?.add(from === undefined ? cwd : from.dir)
      if (from === undefined) walk(globFor(pattern), cwd, take)
      else {
        let found = false
        walk(globFor(from.rest), from.dir, (rel) => {
          found = true
          take(`${from.prefix}/${rel}`)
        })
        if (!found && from.rest === '**') takeRoot(from.prefix)
      }
    }
  } finally {
    giveBack(reopened)
  }
  // A literal names the path and its tree, walked through a directory link at
  // its head; otherwise one artifact would hold `dist` as a file and a
  // directory.
  if (links.length > 0) {
    const sorted = [...matches].sort()
    for (const link of links) {
      const under = `${link}/`
      const at = sorted.findIndex((m) => m >= under)
      if (at !== -1 && sorted[at]!.startsWith(under)) matches.delete(link)
    }
  }
  return matches
}

/** The refusal of an output directory this user cannot list, by its path from `cwd`. */
function unlistedOutput(cwd: string, dir: string, clearing: boolean): UserError {
  const why = clearing
    ? "vx lists a task's declared outputs to clear them before it runs and before a restore"
    : "vx lists a task's declared outputs to save them, and cannot store what it cannot read"
  return new UserError(
    `cannot list declared output directory ${relPosix(cwd, dir)}: EACCES — ${why}; ` +
      `leave it readable and searchable by this user (chmod u+rx), or stop declaring it as an output`,
  )
}

/** Filled by a walk asked for it: what lists the FIFOs, sockets and devices its globs name. */
interface SpecialProbe {
  find?: () => string[]
}

/** The FIFOs, sockets and devices in `dirs` that the output globs name. */
function findSpecial(
  dirs: ReadonlySet<string>,
  cwd: string,
  any: (rel: string) => boolean,
  excluded: (rel: string) => boolean,
  nested: (rel: string) => boolean,
  into: Set<string>,
): void {
  for (const dir of dirs) {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isFile() || e.isDirectory() || e.isSymbolicLink()) continue
      const abs = path.join(dir, e.name)
      const rel = path.relative(cwd, abs).split(path.sep).join('/')
      if (any(rel) && !nested(rel) && !excluded(rel)) into.add(abs)
    }
  }
}

/** `pattern`'s static directory passes through a symlink under `cwd`. */
function headLinked(cwd: string, pattern: string): boolean {
  const prefix = staticPrefix(pattern)
  if (prefix === '.' || path.isAbsolute(prefix)) return false
  let at = cwd
  for (const part of prefix.split('/')) {
    at = path.join(at, part)
    const st = lstatSync(at, { throwIfNoEntry: false })
    if (st === undefined || !st.isDirectory()) return st?.isSymbolicLink() === true
  }
  return false
}

/**
 * Where `pattern`'s scan starts: its static directory, with the rest to match
 * there (`Bun.Glob` walks all of `cwd` whatever the prefix). Null when the
 * prefix is a file. Undefined (scan from `cwd`) for no prefix, an escape, or
 * one that does not stat, whose refusals that walk names.
 */
function scanRoot(
  cwd: string,
  pattern: string,
): { prefix: string; rest: string; dir: string } | null | undefined {
  const prefix = staticPrefix(pattern)
  if (prefix === '.' || prefix.includes('\\') || path.isAbsolute(prefix)) return undefined
  if (!pattern.startsWith(`${prefix}/`) || prefix.split('/').includes('..')) return undefined
  const dir = path.join(cwd, prefix)
  let st
  try {
    st = statSync(dir, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
  if (st === undefined) return undefined
  if (!st.isDirectory()) return null
  return { prefix, rest: pattern.slice(prefix.length + 1), dir }
}

/**
 * True when `pattern`'s static directory is absent, so nothing matches: an
 * lstat, not a scan. Anything unclear scans.
 */
function absentPrefix(cwd: string, pattern: string, known?: ReadonlySet<string>): boolean {
  const prefix = staticPrefix(pattern)
  if (prefix === '.' || prefix.includes('\\') || path.isAbsolute(prefix)) return false
  const at = path.join(cwd, prefix)
  if (known?.has(at) === true) return true
  try {
    return lstatSync(at, { throwIfNoEntry: false }) === undefined
  } catch {
    return false
  }
}

const WHOLE_TREE = new Bun.Glob('**')

// Compiled once per pattern for the process: a `Bun.Glob` is immutable.
const globMemo = new Map<string, Bun.Glob>()
function globFor(pattern: string): Bun.Glob {
  let g = globMemo.get(pattern)
  if (g === undefined) globMemo.set(pattern, (g = taskGlob(pattern)))
  return g
}

/**
 * Whether a path lies inside a nested project: its ancestors looked up in a
 * set, O(depth), not a glob per nested project (320 ms of astro's warm no-op).
 * A name is a name: `pkg*` is no glob.
 */
function inNestedProject(projectDir: string, nestedDirs: string[]): (rel: string) => boolean {
  if (nestedDirs.length === 0) return () => false
  const dirs = new Set(nestedDirs.map((d) => relPosix(projectDir, d)))
  return (rel) => {
    for (let i = rel.indexOf('/'); i !== -1; i = rel.indexOf('/', i + 1)) {
      if (dirs.has(rel.slice(0, i))) return true
    }
    return false
  }
}
