// `--affected` — git-relative project selection.
//
// Resolves the set of project names whose files have changed since a
// given git ref: `git diff --name-only <merge-base(since, HEAD)>`, which
// compares that commit to the working tree — commits on this branch +
// index + unstaged — so it captures everything you touched and nothing
// the base branch moved on with. Matches Turbo's `[<since>]` semantics.

import { lstatSync } from 'node:fs'
import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  CHECK_ATTR,
  executablePath,
  gitCaseArgs,
  gitEnv,
  gitSpawnRefusal,
  ignoreCaseLies,
  isExecutableMissing,
  isInstalledPath,
  isUserError,
  notAWorkTree,
  parseCheckAttrOutput,
  relPosix,
  sameDir,
  UserError,
  xxh3hex,
} from '../util/index.js'
import { LOCKFILE_NAME, lockEntries, lockKey } from './lockfile.js'
import {
  DEPENDENCIES_LOCK_NAME,
  type DependenciesLock,
  dependantsOf,
  recordedDigests,
  parseDependenciesLock,
} from './dependencies-lock.js'
import { configImportOwners, realpathOr } from './config-imports.js'
import { WORKSPACE_CONFIG_FILENAMES } from './project-loader.js'
import { bunPatchFiles } from './fingerprint.js'
import { inVxDir, PROJECT_CONFIG_FILENAMES, REVIEW_FILE, type ProjectMeta } from './workspace.js'

/**
 * Every git call here goes through these two: a git that is not on PATH
 * is one refusal naming the install (util `gitSpawnRefusal`), never the
 * `ENOENT` stack `defaultAffectedBase` showed a minimal image.
 * A git that ran and failed is each caller's to read.
 */
function spawnGitSync(
  args: string[],
  cwd: string,
  stderr: 'pipe' | 'ignore' = 'pipe',
): ReturnType<typeof Bun.spawnSync> {
  try {
    return Bun.spawnSync({
      cmd: [executablePath('git'), ...args],
      // A probe never fetches: in a partial clone, `rev-parse` of a commit
      // it lacks fetched that commit and all its history (50k objects).
      env: { ...gitEnv(), GIT_NO_LAZY_FETCH: '1' },
      cwd,
      stdout: 'pipe',
      stderr,
    })
  } catch (err) {
    if (isExecutableMissing(err)) throw gitSpawnRefusal(cwd)
    throw err
  }
}

function spawnGit(
  args: string[],
  cwd: string,
  stdin?: Uint8Array,
): Bun.Subprocess<Uint8Array | 'ignore', 'pipe', 'pipe'> {
  try {
    return Bun.spawn({
      cmd: [executablePath('git'), ...args],
      env: gitEnv(),
      cwd,
      stdin: stdin ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (err) {
    if (isExecutableMissing(err)) throw gitSpawnRefusal(cwd)
    throw err
  }
}

export interface AffectedArgs {
  workspaceRoot: string
  /** Git ref / commit / branch to compare against. Required. */
  since: string
  /** A promise when the caller is still discovering them: the git calls start first. */
  projects: readonly ProjectMeta[] | Promise<readonly ProjectMeta[]>
  /**
   * False skips the scan of what each `vx.config` imports (every config
   * read): the cache scope's split, where a wrong answer costs a miss,
   * never a stale hit, and the scan was most of a 1,000-project diff.
   */
  configImports?: false
  /**
   * Which projects declare a `inputs.workspaceFiles` glob matching one of
   * these workspace-relative paths.
   *
   * A workspace-anchored glob is the documented escape hatch for inputs
   * outside the project, so mapping changed paths to project directories
   * structurally cannot see it. Answering needs the RESOLVED configs, which
   * selection runs before loading, so it is a callback, asked only when
   * something changed. It is asked about EVERY changed path, the ones a
   * project owns included: the glob may name a file inside another project
   * (`schema.md` allows it), and asking only the paths no project owns
   * left the declaring project out of a run its key called stale.
   * The `--affected` sugar's graph walk has already staged every
   * config, so there it costs nothing more.
   */
  workspaceGlobOwners?: (
    changedPaths: readonly string[],
    nested: readonly string[],
    dirLinks: ReadonlySet<string>,
    /** `AffectedChanges.untracked`. */
    untracked: ReadonlySet<string>,
  ) => Promise<Iterable<string>>
  /**
   * The fingerprint files a plugin claims (`VxPlugin.fingerprint`) and its
   * answer for a change to one. Resolved lazily: loading the workspace
   * file costs an evaluation, and a diff that touches no root file — the
   * common one — never needs it.
   */
  fingerprintClaims?: () => Promise<FingerprintClaims>
  /**
   * The untracked files, workspace-relative, from a walk the caller shares
   * with the run (`GitEnumeration.untracked`); null or absent spawns `git
   * ls-files --others` here. The selection's own walk was a second one the
   * run then paid again (I-26).
   */
  untracked?: () => Promise<readonly string[] | null>
  /**
   * The tracked symlinks, workspace-relative, from the run's enumeration
   * (its index OIDs spell one `120000:`); null or absent spawns `git ls-files
   * -s` here. A changed or untracked link is a changed path already.
   */
  links?: () => Promise<readonly string[] | null>
  /**
   * The tracked paths git does not look at on disk (assume-unchanged,
   * skip-worktree), workspace-relative, from the run's enumeration; null or
   * absent asks `git ls-files -v` here.
   */
  flagged?: () => Promise<readonly string[] | null>
}

export interface FingerprintClaims {
  readonly files: ReadonlySet<string>
  /** Project names a change to a claimed file affects; `undefined` = all. */
  affected(change: {
    file: string
    before: Uint8Array | null
    after: Uint8Array | null
    extras?: ReadonlyMap<string, { before: Uint8Array | null; after: Uint8Array | null }>
  }): Promise<ReadonlySet<string> | undefined>
  /** The files a claimed file names that its claimant keys too; absent = it reads none. */
  extraFiles?(file: string, bytes: Uint8Array): Promise<readonly string[] | undefined>
  /**
   * An extra file's hash now, as the key takes it (`hashExtra`), from the
   * hashes the run's key reads too; absent = selection checks none.
   */
  hashExtra?(rel: string): Promise<string>
  /** Each project's digest of a claimed file now (`FingerprintClaim.digests`); absent or undefined = none. */
  digests?(
    file: string,
  ): Promise<{ hash: string; projects: Readonly<Record<string, string>> } | undefined>
}

/**
 * `extraFiles` on one side of a claimed file. Which side failed to parse is
 * the whole fix: a broken lockfile at the base ref is not the working
 * tree's to regenerate, and the bare refusal named neither.
 */
async function extraFilesOn(
  claims: FingerprintClaims,
  file: string,
  bytes: Uint8Array,
  side: string,
): Promise<readonly string[] | undefined> {
  try {
    return await claims.extraFiles?.(file, bytes)
  } catch (err) {
    if (!(err instanceof Error)) throw err
    throw new UserError(
      `${err.message} (${side})`,
      err instanceof UserError ? err.code : 'VX_E_REFUSED',
    )
  }
}

/**
 * Return the set of project names whose files changed between
 * `<since>` and the current working tree. Errors if `git` is missing
 * or `<since>` doesn't resolve to a commit.
 */
export async function affectedProjects(args: AffectedArgs): Promise<Set<string>> {
  return (await affectedChanges(args, false)).projects
}

/**
 * What `--affected` seeds its tasks from: the changed
 * projects, each one's changed paths relative to it, and the projects a
 * change reaches as a whole — every task in one is affected whatever its
 * inputs say, because the reason was no path of its own (a lockfile claim,
 * a config import, a nested repository, a
 * workspace-wide file).
 */
export interface AffectedChanges {
  projects: Set<string>
  /** Workspace-relative changed paths. */
  changed: readonly string[]
  /** Project → its changed paths, relative to the project's directory. */
  paths: ReadonlyMap<string, readonly string[]>
  whole: ReadonlySet<string>
  /** A whole project → the workspace-wide file that made it so (a workspace config, a claimed root file). */
  wholeBy?: ReadonlyMap<string, string>
  /** `wholeBy`'s file reached every project (the workspace config), not only those a claim named. */
  wide?: boolean
  /**
   * The changed paths that are nested repositories (a submodule, an
   * embedded repository), workspace-relative: each stands for every file
   * in it, so a `workspaceFiles` glob that reaches under one is reached.
   */
  nested?: readonly string[]
  /**
   * The changed paths a glob matches as a directory (a link to one),
   * workspace-relative: `declaresInput`'s `dirLink`.
   */
  dirLinks?: ReadonlySet<string>
  /** Project → its `dirLinks`, relative to the project's directory. */
  dirLinksIn?: ReadonlyMap<string, ReadonlySet<string>>
  /**
   * Project → its changed paths git tracks neither now nor at the base,
   * relative to the project's directory: one under a task's own outputs
   * is no input of it.
   */
  untrackedIn?: ReadonlyMap<string, ReadonlySet<string>>
  /** Those changed paths, workspace-relative: `declaresInput`'s `untracked`. */
  untracked?: ReadonlySet<string>
}

/** `<base>...HEAD` / `<base>..HEAD`: the base alone, read as `affectedChanges` reads it. */
const HEAD_RANGE = /^(.+?)(\.{2,3})HEAD$/s

export async function affectedChanges(
  args: AffectedArgs,
  perTask = true,
): Promise<AffectedChanges> {
  const { base, partial, autocrlf, caseArgs } = await diffBase(args)
  const diff = await changedPaths(args, base, partial, autocrlf, caseArgs)
  const { changed } = diff
  const everything = (file: string): AffectedChanges => {
    const all = new Set(diff.projects.map((p) => p.name))
    const wholeBy = new Map([...all].map((n) => [n, file]))
    return { projects: all, changed, paths: new Map(), whole: all, wholeBy, wide: true }
  }
  // The workspace config's plugins shape every project's resolved config,
  // so its edit can re-key any task and selection cannot tell which (item
  // 953). No key folds the file; selection is not hashed, so widening here
  // changes no key.
  const wsConfig = WORKSPACE_CONFIG_FILENAMES.find((n) => changed.includes(n))
  if (wsConfig !== undefined) return everything(wsConfig)
  const extrasBy = await claimedExtras(args, diff)
  if (typeof extrasBy === 'string') return everything(extrasBy)
  const claimedOwned = await claimedOwners(args, diff, extrasBy)
  if (typeof claimedOwned === 'string') return everything(claimedOwned)
  const owners = await pathOwners(args, diff, claimedOwned, perTask)
  if (typeof owners === 'string') return everything(owners)
  const { owned, whole, paths, dirLinksIn, untrackedIn, untrackedSet } = owners

  // THIRD CHANNEL: a project whose `vx.config.*` IMPORTS a changed file.
  // Resolved-config hashing folds those values into the key, so the same
  // sentence above applies — input hashing sees it, so selection must. This
  // runs on the FULL changed set, not just the paths no project owns: the
  // common shape is a config reaching into ANOTHER project
  // (`../../src/index.ts`), whose target is owned.
  // Per task, a project that owns the changed file still needs to know its
  // config imported it: that re-keys every task, whatever their inputs.
  // A file the workspace config imports widens as the config itself does.
  if (args.configImports !== false) {
    const imports = await configImportOwners({
      workspaceRoot: args.workspaceRoot,
      projects: diff.projects,
      changed,
      skip: perTask ? new Set() : owned,
      workspaceConfigs: WORKSPACE_CONFIG_FILENAMES.map((n) => path.join(diff.rootDir, n)),
    })
    if (imports.workspace !== undefined) return everything(imports.workspace)
    if (imports.outside !== undefined) {
      const moved = await outsideChanged(args.workspaceRoot, base, imports.outside)
      if (moved !== undefined) return everything(moved)
    }
    for (const name of imports.owners) {
      owned.add(name)
      whole.add(name)
    }
  }

  const { dirLinks } = diff
  const nestedDirs = [...diff.nested].map((rel) => rel.replace(/\/$/, ''))
  const done = (): AffectedChanges => ({
    projects: owned,
    changed,
    paths,
    whole,
    ...(claimedOwned.size > 0 ? { wholeBy: claimedOwned } : {}),
    ...(nestedDirs.length > 0 ? { nested: nestedDirs } : {}),
    ...(dirLinks.size > 0 ? { dirLinks, dirLinksIn } : {}),
    ...(untrackedIn.size > 0 ? { untrackedIn } : {}),
    ...(untrackedSet.size > 0 ? { untracked: untrackedSet } : {}),
  })
  if (changed.length === 0 || args.workspaceGlobOwners === undefined) return done()
  const globOwners = await args.workspaceGlobOwners(changed, nestedDirs, dirLinks, untrackedSet)
  for (const name of globOwners) owned.add(name)
  return done()
}

/** The commit `args.since` names to diff from, and the git config facts the diff's shape needs. */
async function diffBase(args: AffectedArgs) {
  // Turbo's CI spelling, `[origin/main...HEAD]`, is the base alone here:
  // vx already diffs from the merge base (three dots' meaning), and the
  // working tree it diffs to holds HEAD. Its two-dot `[A..HEAD]`
  // diffs from A itself. Any other range is refused.
  const headRange = HEAD_RANGE.exec(args.since)
  const since = headRange?.[1] ?? args.since
  const fromMergeBase = headRange?.[2] !== '..'
  // The base reaches git as an argument, never through a shell, so `$(…)`
  // is opaque — but an option-like value is not: `--output=<path>` is a
  // real `git diff` option and an arbitrary file write. This is a security
  // boundary, so it is a check that knows it is one, before any spawn, and
  // every git call below also ends its options (`--end-of-options`) so a
  // second caller cannot lose the guard by accident.
  if (since.length === 0 || since.startsWith('-')) {
    throw new UserError(
      `git ref "${since}" is not a ref: a base cannot be empty or start with "-".`,
      'VX_E_AFFECTED_BASE',
    )
  }
  // `A..B` / `A...B` reached `rev-parse --verify`, which refuses a range, and
  // the user read "did not resolve" about refs that both exist. `..` is
  // illegal in a ref name (git-check-ref-format), so this refuses no ref.
  const range = since.indexOf('..')
  if (range >= 0) {
    throw new UserError(
      `git ref "${since}" is a range: ranges are not supported — pass the base alone ` +
        `("${since.slice(0, range) || 'HEAD'}"); vx diffs it against the working tree.`,
      'VX_E_AFFECTED_BASE',
    )
  }
  // `^main` is rev-list's exclusion, not a ref: merge-base refused it, it
  // verified, and `git diff ^main` diffed from main itself, so changes
  // only main made were selected (`^` is illegal in a ref name).
  if (since.startsWith('^')) {
    throw new UserError(
      `git ref "${since}" is an exclusion, not a ref: pass the base alone ("${since.replace(/^\^+/, '') || 'HEAD'}").`,
      'VX_E_AFFECTED_BASE',
    )
  }
  // Diff from the MERGE BASE of `since` and HEAD, not from `since` itself:
  // on a branch whose base has moved on, `git diff <base>` reports every
  // file OTHER people changed on the base (over-selection that defeats a
  // CI `--affected`), and hides your own edit when the base later landed
  // byte-identical content. Turbo and Nx both diff from the merge base;
  // when there is none (unrelated histories, a detached probe) the ref
  // itself is the base, as before. Turbo's two-dot range `A..HEAD` is the
  // one form that diffs from A itself.
  // Asked beside the base, not after it: the diff's shape waits on it.
  const config = gitConfigFacts(args.workspaceRoot).catch(() => ({
    partial: false,
    ignoreCase: false,
    autocrlf: false,
  }))
  const partial = config.then((c) => c.partial)
  const autocrlf = config.then((c) => c.autocrlf)
  // `core.ignorecase=true` on a disk that tells case apart hid a new
  // `a.txt` beside the tracked `A.txt` from the untracked listings.
  const caseArgs = config.then((c) => {
    if (c.ignoreCase) ignoreCaseLies(args.workspaceRoot, args.workspaceRoot)
    return gitCaseArgs(args.workspaceRoot)
  })
  const base = fromMergeBase
    ? await mergeBase(args.workspaceRoot, since)
    : await rangeBase(args.workspaceRoot, since)
  return { base, partial, autocrlf, caseArgs }
}

/**
 * Every path that differs from `base` as a key sees it: the diff, the
 * untracked files, links whose target moved and paths git was told not
 * to look at; with the projects, and the base's lock record and the
 * fingerprint claims, each read once when asked.
 */
async function changedPaths(
  args: AffectedArgs,
  base: string,
  partial: Promise<boolean>,
  autocrlf: Promise<boolean>,
  caseArgs: Promise<readonly string[]>,
) {
  const [diffed, untracked] = await Promise.all([
    // `--no-renames` is crucial for project-affected detection: with
    // git's auto rename-detection on (the default in modern git), a
    // cross-project `git mv` collapses to a single rename entry that
    // surfaces only the destination path. We'd then miss flagging the
    // source project as affected. Treating renames as delete+add gives
    // us both halves so both projects get correctly marked.
    //
    // `--relative` prints paths relative to the cwd (the workspace root), NOT
    // the git repo root. Without it, when the workspace root is a SUBDIR of the
    // git repo, `git diff` emits repo-root-relative paths (`code/pkg/x`) that
    // `path.resolve(workspaceRoot, …)` mangles into `<root>/code/…`, matching no
    // project → the project is silently NOT flagged affected. `--relative` also
    // (correctly) drops changes ABOVE the workspace, which belong to no project.
    // No-op when the workspace root IS the git root.
    //
    // `-z` because git otherwise C-quotes and octal-escapes any path with a
    // non-ASCII / `"` / `\` character — the quoted string then resolves to no
    // project, while the cache-input enumeration (which uses `-z`) sees the
    // real name and re-keys the task. The two surfaces must agree.
    //
    // `--ignore-submodules=none` because a repository may ask git to hide its
    // submodules (`diff.ignoreSubmodules`, `submodule.<name>.ignore`), and
    // then an edit inside one, or a committed bump, was no change here while
    // the task's key moved.
    //
    // `--raw` for each path's mode: a gitlink (160000) is a nested
    // repository, one path standing for every file in it (`nested` below).
    gitDiffPaths(args.workspaceRoot, base, partial, autocrlf),
    // `git diff` never reports untracked-but-not-ignored files, but input
    // enumeration does (`git ls-files --cached --others --exclude-standard`),
    // so a brand-new source file changes a task's cache key. Union it in or
    // `--affected` skips a package that genuinely has new work.
    (async () =>
      (await args.untracked?.().catch(() => null)) ??
      gitPaths(args.workspaceRoot, [
        ...(await caseArgs),
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
      ]))(),
  ])

  const projects = await args.projects

  // What vx writes under `.vx` (the lock, its git files, the cache) is
  // excluded like a gitignored file: re-running `vx lock` must not mark
  // every project affected, nor the root project whole. The lock's
  // entries are read below.
  // An untracked file under `node_modules` is an install, which the input
  // enumeration drops too (`isInstalledPath`); a tracked one is a source.
  // So is each project's `vx.lock.json`, the review copy `vx lock` writes
  // beside its config and nothing reads: a re-lock rewriting them all
  // selected every project while no key moved. The temp a killed write of
  // any of these left beside it is vx's too.
  const reviewCopies = new Set(projects.map((p) => path.join(p.dir, REVIEW_FILE)))
  const rootDir = path.resolve(args.workspaceRoot)
  const changed = [...diffed.paths, ...untracked.filter((s) => !isInstalledPath(s))].filter((s) => {
    const own = s.replace(WRITE_TEMP, '')
    return (
      !VX_OWN.has(own) &&
      !s.startsWith('.vx/cache/') &&
      !s.startsWith('.vx/tmp/') &&
      (path.posix.basename(own) !== REVIEW_FILE || !reviewCopies.has(path.join(rootDir, own)))
    )
  })
  const dirLinks = await unseenChanges(args, changed, diffed.links, untracked, caseArgs, autocrlf)
  // The nested repositories git reports as one path: a gitlink, or an
  // untracked embedded repository (`dir/`, the only path git prints so).
  const nested = new Set(diffed.gitlinks)
  for (const rel of untracked) if (rel.endsWith('/')) nested.add(rel)

  // The base commit's `vx lock` record, read once and only when asked.
  let baseDeps: Promise<DependenciesLock | null> | undefined
  const baseDependencies = (): Promise<DependenciesLock | null> =>
    (baseDeps ??= gitBytesAt(args.workspaceRoot, base, DEPENDENCIES_LOCK_NAME).then((bytes) => {
      // A base a newer vx locked is read as no record (everything its
      // files key moves), as before: only the working tree's lock is this
      // vx's to refuse, since only that one `vx lock` would write over.
      try {
        return parseDependenciesLock(bytes)
      } catch (err) {
        if (isUserError(err)) return null
        throw err
      }
    }))
  // The workspace file is loaded once, for the extra files below and the
  // changed root names after them.
  let claims: FingerprintClaims | undefined
  const loadClaims = async (): Promise<FingerprintClaims | undefined> =>
    (claims ??= await args.fingerprintClaims?.())
  return {
    base,
    diffed,
    untracked,
    projects,
    rootDir,
    changed,
    dirLinks,
    nested,
    baseDependencies,
    loadClaims,
  }
}
type Diff = Awaited<ReturnType<typeof changedPaths>>

/**
 * Adds to `changed` what the diff cannot list: links whose target moved
 * and paths git was told not to look at. Returns the changed paths that
 * are, or were, links to a directory.
 */
async function unseenChanges(
  args: AffectedArgs,
  changed: string[],
  diffedLinks: readonly string[],
  untracked: readonly string[],
  caseArgs: Promise<readonly string[]>,
  autocrlf: Promise<boolean>,
) {
  // A symlinked input keys the content behind it (cache/linked-inputs.ts),
  // and the diff names that content's path, never the link's: a link whose
  // target changed is a changed path itself.
  // One index listing serves both when the run's enumeration did not.
  let index: Promise<IndexEntry[]> | undefined
  const listIndex = () => (index ??= indexEntries(args.workspaceRoot))
  const [links, flagged] = await Promise.all([
    (async () =>
      (await args.links?.().catch(() => null)) ??
      (await listIndex()).filter((e) => e.mode === '120000').map((e) => e.path))(),
    (async () =>
      (await args.flagged?.().catch(() => null)) ??
      (await listIndex()).filter((e) => e.flagged).map((e) => e.path))(),
  ])
  const dirLinkSet = new Set<string>()
  changed.push(
    ...(await linkedChanges(args.workspaceRoot, links, changed, dirLinkSet, await caseArgs)),
  )
  // A path git was told not to look at (`update-index --assume-unchanged`,
  // `--skip-worktree`): `git diff` reports no edit to it, and the key
  // hashes it from disk, so the task missed and selection left it out.
  if (flagged.length > 0) {
    changed.push(
      ...(await flaggedChanges(
        args.workspaceRoot,
        flagged,
        await listIndex(),
        changed,
        await autocrlf,
      )),
    )
  }
  // A changed path that is a link to a directory, or was a link and is
  // no link to a file now: a glob reaching below it keys what is behind
  // it (cache/inputs.ts `mayHoldMatch`), so it is matched as a directory.
  const dirLinks = await changedDirLinks(
    args.workspaceRoot,
    changed,
    dirLinkSet,
    new Set([...diffedLinks, ...untracked]),
  )
  return dirLinks
}

/** Before and after of each extra file a claimed lockfile names, by that lockfile. */
type ExtrasBy = Map<string, Map<string, { before: Uint8Array | null; after: Uint8Array | null }>>

/**
 * The changed extra files of each claimed root file; or, when a change
 * reaches every project, the file that widens.
 *
 * A root file a plugin CLAIMS (`VxPlugin.fingerprint`: a lockfile, an
 * install setting) re-keys tasks through what its claimant folds, and it
 * sits at the root, owned by no project or by the root alone: mapping
 * paths to directories selected ZERO projects for a lockfile bump that
 * re-keyed them all, and `vx run test --affected` after a `pnpm update`
 * exited 0 having run nothing — the failure `docs/cli.md` warns against:
 * "input hashing sees it, so `--affected` must too." So selection asks the
 * claimant the question its key answers, with the bytes at the base ref
 * and in the working tree; the answer is unioned with the path-owned
 * projects below, and only "cannot tell" widens. Core keys no root file
 * itself, so an unclaimed one is a path like any other.
 *
 * Selection is not hashed, so widening it here changes no cache key.
 */
async function claimedExtras(args: AffectedArgs, diff: Diff): Promise<ExtrasBy | string> {
  const { base, changed } = diff
  // A file a claimed lockfile names that its claimant keys but the
  // lockfile does not pin (`FingerprintClaim.extraFiles`: bun.lock's
  // patches, a `file:`, `link:` or `portal:` directory
  // a manager copies or links) is part of
  // that lockfile: a change to one, or under one, is a lockfile change the
  // claimant answers with it. It may sit inside another project's
  // directory, so every changed path is asked: asking only the paths no
  // project owned selected the owner and never the project the lockfile
  // says reaches it.
  const extrasBy: ExtrasBy = new Map()
  const extraClaims = changed.length > 0 ? await diff.loadClaims() : undefined
  for (const file of extraClaims?.files ?? []) {
    const after = await bytesOrNull(path.join(args.workspaceRoot, file))
    // An unchanged claimed file is the same bytes at the base: one read,
    // one parse, no git.
    const same = !changed.includes(file)
    const before = same ? after : await gitBytesAt(args.workspaceRoot, base, file)
    const namedAfter =
      after === null ? [] : await extraFilesOn(extraClaims!, file, after, 'in the working tree')
    const named = new Set([
      ...(before === null || same
        ? []
        : ((await extraFilesOn(extraClaims!, file, before, 'as of the base ref')) ?? [])),
      ...(namedAfter ?? []),
    ])
    const extras = new Map<string, { before: Uint8Array | null; after: Uint8Array | null }>()
    for (const rel of named) {
      const at = path.posix.normalize(rel).replace(/\/+$/, '')
      if (changed.includes(at)) {
        extras.set(rel, {
          before: await gitBytesAt(args.workspaceRoot, base, at),
          after: await bytesOrNull(path.join(args.workspaceRoot, at)),
        })
        continue
      }
      // A directory's sides are not its bytes: a file under it changed,
      // so they differ, and only the projects reaching it move.
      const under = changed.filter((p) => p.startsWith(`${at}/`))
      if (under.length > 0) {
        extras.set(rel, { before: null, after: new TextEncoder().encode(under.join('\0')) })
      }
    }
    if (extras.size > 0) extrasBy.set(file, extras)
    else if (file === 'bun.lock' && after !== null && namedAfter === undefined) {
      // A bun.lock claimant that names no file still folds the patches
      // bun.lock names (the lockfile records no hash of them): it cannot
      // say which projects one reaches, so its edit widens.
      const patches = new Set(bunPatchFiles(after))
      const patch = changed.find((p) => patches.has(p))
      if (patch !== undefined) return patch
    }
  }
  await recordedExtras(diff, extrasBy)
  return extrasBy
}

/**
 * An extra file can move with no change git lists: a gitignored file in
 * a `file:` directory (a vendored package's built `dist/`, which the
 * manager copies), or a `file:` or `link:` directory outside the
 * repository. The key digests anew from what `vx lock` recorded, so
 * selection compares the same hashes, against the base's record, and
 * the run's key reads them from this pass (`FingerprintClaims.hashExtra`).
 */
async function recordedExtras(diff: Diff, extrasBy: ExtrasBy): Promise<void> {
  const hashing = await diff.loadClaims()
  if (hashing?.hashExtra === undefined || hashing.files.size === 0) return
  // Not in the diff, the working tree's lock is the base's: no git show.
  const relocked =
    diff.diffed.paths.includes(DEPENDENCIES_LOCK_NAME) ||
    diff.untracked.includes(DEPENDENCIES_LOCK_NAME)
  const record = relocked
    ? await diff.baseDependencies()
    : parseDependenciesLock(await bytesOrNull(path.join(diff.rootDir, DEPENDENCIES_LOCK_NAME)))
  for (const file of hashing.files) {
    const was = record === null ? undefined : recordedDigests(record, file)
    const rels = was === undefined ? [] : Object.keys(was.extras)
    if (rels.length === 0) continue
    const now = await Promise.all(rels.map((rel) => hashing.hashExtra!(rel)))
    const listed = extrasBy.get(file) ?? new Map()
    const side = (hash: string): Uint8Array | null =>
      hash === '' ? null : new TextEncoder().encode(hash)
    rels.forEach((rel, i) => {
      const then = was!.extras[rel]!
      if (now[i] === then || listed.has(rel)) return
      // Sides that differ as the hashes do: the claimant folds each.
      listed.set(rel, { before: side(then), after: side(now[i]!) })
    })
    if (listed.size > 0) extrasBy.set(file, listed)
  }
}

/**
 * The projects each changed claimed root file reaches, by the file that
 * reached them; or the file whose claimant cannot tell, which widens.
 */
async function claimedOwners(
  args: AffectedArgs,
  diff: Diff,
  extrasBy: ExtrasBy,
): Promise<Map<string, string> | string> {
  const { base, changed } = diff
  const claimedOwned = new Map<string, string>()
  const rootNamesChanged = changed.filter((p) => !p.includes('/'))
  for (const file of extrasBy.keys()) {
    if (!rootNamesChanged.includes(file)) rootNamesChanged.push(file)
  }
  const claimed = rootNamesChanged.length > 0 ? await diff.loadClaims() : undefined
  for (const file of rootNamesChanged) {
    if (claimed === undefined || !claimed.files.has(file)) continue
    const extras = extrasBy.get(file)
    const before = await gitBytesAt(args.workspaceRoot, base, file)
    const after = await bytesOrNull(path.join(args.workspaceRoot, file))
    const answer =
      (extras === undefined
        ? await recordedMoves(diff, claimed, file, before, after)
        : undefined) ??
      (await claimed.affected({ file, before, after, ...(extras !== undefined ? { extras } : {}) }))
    const why =
      extras === undefined || changed.includes(file)
        ? file
        : path.posix.normalize([...extras.keys()][0]!).replace(/\/+$/, '')
    if (answer === undefined) return why
    for (const name of answer) if (!claimedOwned.has(name)) claimedOwned.set(name, why)
  }
  return claimedOwned
}

/**
 * The projects whose digest of `file` moved, from the base's recorded
 * digests and the claimant's now: the base side is never parsed. Null
 * when the base recorded none for these bytes (no lock, or another
 * hash) or the claimant gives none now: `affected` answers then.
 */
async function recordedMoves(
  diff: Diff,
  asked: FingerprintClaims,
  file: string,
  before: Uint8Array | null,
  after: Uint8Array | null,
): Promise<ReadonlySet<string> | null> {
  if (before === null || after === null || asked.digests === undefined) return null
  const base = await diff.baseDependencies()
  const was = base === null ? undefined : recordedDigests(base, file)
  // Base digests that read another file are that file's at the base,
  // which the record does not prove.
  if (was === undefined || was.hash !== xxh3hex(before) || Object.keys(was.extras).length > 0)
    return null
  const now = await asked.digests(file)
  if (now === undefined) return null
  const moved = new Set<string>()
  for (const p of diff.projects) {
    const d = was.of(lockKey(diff.rootDir, p.dir))
    if (d === undefined || d !== now.projects[p.name]) moved.add(p.name)
  }
  return moved
}

/**
 * The projects the changed paths fall in, those a lock entry or a project
 * marker moved, and per project its changed paths; or the removed config
 * that widens when the base recorded no dependencies.
 */
async function pathOwners(
  args: AffectedArgs,
  diff: Diff,
  claimedOwned: Map<string, string>,
  perTask: boolean,
) {
  const { base, changed, projects, rootDir, dirLinks, untracked, diffed } = diff
  const realDirs = new Map(
    await Promise.all(
      projects.map(async (p) => [p.dir, await realpath(p.dir).catch(() => p.dir)] as const),
    ),
  )
  const paths = new Map<string, string[]>()
  const dirLinksIn = new Map<string, Set<string>>()
  // A path git tracked at the base and no longer does is in both lists: the
  // base key folded it, so it moved a key and stays an input.
  const tracked = new Set(diffed.paths)
  const untrackedSet = new Set(untracked.filter((rel) => !tracked.has(rel)))
  const untrackedIn = new Map<string, Set<string>>()
  const whole = new Set<string>(claimedOwned.keys())
  const owned = projectsContaining(
    args.workspaceRoot,
    changed,
    diff.nested,
    projects,
    realDirs,
    perTask
      ? {
          path: (name, rel, wsRel) => {
            const list = paths.get(name)
            if (list) list.push(rel)
            else paths.set(name, [rel])
            if (untrackedSet.has(wsRel)) {
              const loose = untrackedIn.get(name)
              if (loose) loose.add(rel)
              else untrackedIn.set(name, new Set([rel]))
            }
            if (!dirLinks.has(wsRel)) return
            const links = dirLinksIn.get(name)
            if (links) links.add(rel)
            else dirLinksIn.set(name, new Set([rel]))
          },
          repo: (name) => whole.add(name),
        }
      : undefined,
  )
  for (const name of claimedOwned.keys()) owned.add(name)
  // A run reads each config, name and edge from the lock, so an entry that
  // moved moved its project's keys, though no config or import did (one
  // evaluated under another env, a preset imported by package name, an
  // edge a `discover` plugin added). The lock is the reason only when no
  // file below names a closer one.
  const lockMoved: string[] = []
  if (diffed.paths.includes(LOCKFILE_NAME) || untracked.includes(LOCKFILE_NAME)) {
    // A side with no lock (or one that will not parse) ran nothing from
    // it: the paths of the configs say what changed, as before the lock.
    const before = lockEntries(await gitBytesAt(args.workspaceRoot, base, LOCKFILE_NAME))
    const after = lockEntries(await bytesOrNull(path.join(args.workspaceRoot, LOCKFILE_NAME)))
    const same = (dir: string): boolean =>
      before === null ||
      after === null ||
      (Object.hasOwn(before, dir) === Object.hasOwn(after, dir) &&
        JSON.stringify(before[dir]) === JSON.stringify(after[dir]))
    for (const p of projects) {
      if (same(lockKey(rootDir, p.dir))) continue
      owned.add(p.name)
      whole.add(p.name)
      lockMoved.push(p.name)
    }
  }

  // A config or manifest that makes an existing directory a project took
  // files from the project above it.
  const markers = changed.filter((rel) => PROJECT_MARKERS.has(path.posix.basename(rel)))
  if (markers.length > 0) {
    const atBase = await gitBlobsAt(args.workspaceRoot, base, markers)
    // A config the base had in a directory that is no project now: the
    // project is gone, and with it the edge naming who depended on it,
    // while their keys lost an upstream. Today's graph cannot say who; the
    // base's dependencies lock can. Without one, every project.
    // A config that moved, the same bytes under a new project, is no
    // loss: its files select it where it lives.
    const nameAt = new Map(projects.map((p) => [lockKey(rootDir, p.dir), p.name]))
    for (const gone of await removedProjectConfigs(args.workspaceRoot, atBase, projects)) {
      const recorded = await diff.baseDependencies()
      if (recorded === null) return gone
      const held = dependantsOf(recorded, path.posix.dirname(gone)).flatMap(
        (d) => nameAt.get(d) ?? [],
      )
      for (const name of held) {
        owned.add(name)
        whole.add(name)
        if (!claimedOwned.has(name)) claimedOwned.set(name, gone)
      }
    }
    for (const name of parentsOfNewNested(args.workspaceRoot, atBase, projects)) {
      owned.add(name)
      whole.add(name)
    }
  }
  for (const name of lockMoved) if (!claimedOwned.has(name)) claimedOwned.set(name, LOCKFILE_NAME)
  return { owned, whole, paths, dirLinksIn, untrackedIn, untrackedSet }
}

/** What vx writes under `.vx`, which no key reads (cache/inputs.ts `ALWAYS_IGNORE`). */
const VX_OWN: ReadonlySet<string> = new Set([
  LOCKFILE_NAME,
  DEPENDENCIES_LOCK_NAME,
  '.vx/.gitattributes',
  '.vx/.gitignore',
])

/** The suffix of the temp a write renames into place (util/write-file.ts). */
const WRITE_TEMP = /\.tmp-\d+-[0-9a-z]*$/

const CONFIG_NAMES: ReadonlySet<string> = new Set(PROJECT_CONFIG_FILENAMES)
/**
 * The files that make a directory a project: core's configs, and the
 * `package.json` a `discover` plugin reads (core keys every project's own).
 * Discovery names no file it read, so these stand for the base's project set.
 */
const PROJECT_MARKERS: ReadonlySet<string> = new Set([...PROJECT_CONFIG_FILENAMES, 'package.json'])

/**
 * Each project's dir to its name, looked up by a path's own spelling first.
 * macOS git reports paths NFC (core.precomposeunicode) while a dir
 * discovered by readdir keeps the spelling it was created with, so a dir
 * not spelled NFC is found by its NFC name too, when that name is the same
 * directory: Linux keeps `café` NFC and NFD as two, git reports each
 * byte-exact, and one NFC key made an edit in one select the other.
 */
interface DirIndex {
  /** The name `dir` maps to, and the spelling of `dir` that matched. */
  get(dir: string): { name: string; dir: string } | undefined
  /** Adds `dir` unless a project already holds it. */
  add(dir: string, name: string): void
  entries(): Iterable<[string, string]>
}

function dirIndex(projects: readonly ProjectMeta[]): DirIndex {
  const exact = new Map<string, string>()
  const alias = new Map<string, string>()
  const aliasOf = (dir: string, name: string): void => {
    const nfc = dir.normalize('NFC')
    if (nfc !== dir && !exact.has(nfc) && sameDir(dir, nfc)) alias.set(nfc, name)
  }
  for (const p of projects) exact.set(p.dir, p.name)
  for (const p of projects) aliasOf(p.dir, p.name)
  return {
    get(dir) {
      const name = exact.get(dir)
      if (name !== undefined) return { name, dir }
      if (alias.size === 0) return undefined
      const nfc = dir.normalize('NFC')
      const viaNfc = alias.get(nfc)
      return viaNfc === undefined ? undefined : { name: viaNfc, dir: nfc }
    },
    add(dir, name) {
      if (exact.has(dir)) return
      exact.set(dir, name)
      aliasOf(dir, name)
    },
    entries: () => [...exact, ...alias],
  }
}

/**
 * The projects a NEW nested project took files from. A project's inputs
 * stop at every project below it, so a marker that makes an existing
 * directory a project re-keys the project above it — its `**` lost the
 * directory's files — while containment maps the change to the new
 * project alone, and `--affected` left the re-keyed parent out. "New" is
 * judged at the base: none of the changed markers in its directory was
 * there. `atBase` holds each changed marker there.
 */
function parentsOfNewNested(
  workspaceRoot: string,
  atBase: ReadonlyMap<string, Uint8Array | null>,
  projects: readonly ProjectMeta[],
): Set<string> {
  const out = new Set<string>()
  const dirToName = dirIndex(projects)
  const existed = new Set<string>()
  for (const [rel, bytes] of atBase) if (bytes !== null) existed.add(path.posix.dirname(rel))
  for (const rel of atBase.keys()) {
    if (existed.has(path.posix.dirname(rel))) continue
    const dir = path.resolve(workspaceRoot, path.posix.dirname(rel))
    if (dirToName.get(dir) === undefined) continue
    let parent: string | undefined
    for (let d = path.dirname(dir); parent === undefined; d = path.dirname(d)) {
      parent = dirToName.get(d)?.name
      if (path.dirname(d) === d) break
    }
    if (parent !== undefined) out.add(parent)
  }
  return out
}

/** Each config in `atBase` the base had whose file and project are both gone now. */
async function removedProjectConfigs(
  workspaceRoot: string,
  atBase: ReadonlyMap<string, Uint8Array | null>,
  projects: readonly ProjectMeta[],
): Promise<string[]> {
  const dirs = dirIndex(projects)
  const gone: string[] = []
  let added: Uint8Array[] | undefined
  for (const [rel, bytes] of atBase) {
    // A manifest's directory may never have been a project; a config's was.
    if (bytes === null || !CONFIG_NAMES.has(path.posix.basename(rel))) continue
    // Under `.vx` no config made a project, at the base either.
    if (inVxDir(rel)) continue
    if (dirs.get(path.resolve(workspaceRoot, path.posix.dirname(rel))) !== undefined) continue
    if (await Bun.file(path.join(workspaceRoot, rel)).exists()) continue
    // Each config the base lacked, read once, only when one went.
    added ??= await Promise.all(
      [...atBase]
        .filter(([r, b]) => b === null && CONFIG_NAMES.has(path.posix.basename(r)))
        .map(([r]) => bytesOrNull(path.join(workspaceRoot, r))),
    ).then((all) => all.filter((b): b is Uint8Array => b !== null))
    if (added!.some((b) => Buffer.from(b).equals(bytes))) continue
    gone.push(rel)
  }
  return gone
}

/**
 * Each of `files` (workspace-root-relative) as `ref` has it, in one `git
 * cat-file --batch`: null for a file the ref does not have. `./` anchors
 * each path to the cwd, the workspace root, as `gitBytesAt` does.
 */
async function gitBlobsAt(
  workspaceRoot: string,
  ref: string,
  files: readonly string[],
): Promise<Map<string, Uint8Array | null>> {
  const blobs = new Map<string, Uint8Array | null>()
  // The batch reads one path per line; a name holding a newline asks alone.
  const batched: string[] = []
  for (const file of files) {
    if (file.includes('\n')) blobs.set(file, await gitBytesAt(workspaceRoot, ref, file))
    else batched.push(file)
  }
  if (batched.length === 0) return blobs
  const proc = spawnGit(
    ['cat-file', '--batch'],
    workspaceRoot,
    new TextEncoder().encode(batched.map((f) => `${ref}:./${f}\n`).join('')),
  )
  const [out, stderr, exit] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exit !== 0) {
    throw new UserError(`git cat-file --batch failed (exit ${exit}): ${stderr.trim()}`, 'VX_E_GIT')
  }
  let at = 0
  for (const file of batched) {
    const eol = out.indexOf(0x0a, at)
    if (eol === -1)
      throw new UserError(`git cat-file --batch ended before ${ref}:./${file}`, 'VX_E_GIT')
    const header = new TextDecoder().decode(out.subarray(at, eol))
    at = eol + 1
    // `<oid> <type> <size>`, or `<spec> missing` / `<spec> ambiguous`.
    const m = /^[0-9a-f]{40,64} (\w+) (\d+)$/.exec(header)
    if (m === null) {
      blobs.set(file, null)
      continue
    }
    const size = Number(m[2])
    blobs.set(file, m[1] === 'blob' ? out.slice(at, at + size) : null)
    at += size + 1
  }
  return blobs
}

/**
 * A root file's bytes at `ref`, or null when the ref has no such file.
 * `./` anchors the path to the cwd (the workspace root) rather than the
 * repository root, for a workspace that is a subdirectory of its repo.
 */
async function gitBytesAt(
  workspaceRoot: string,
  ref: string,
  file: string,
): Promise<Uint8Array | null> {
  const proc = spawnGit(['show', '--end-of-options', `${ref}:./${file}`], workspaceRoot)
  const [bytes, stderr, exit] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exit === 0) return bytes
  // "exists on disk but not in <ref>" and "path does not exist in <ref>"
  // are the file being absent at the ref; anything else is git failing.
  if (/does not exist in|exists on disk, but not in/.test(stderr)) return null
  throw new UserError(
    `git show ${ref}:./${file} failed (exit ${exit}): ${stderr.trim()}`,
    'VX_E_GIT',
  )
}

async function bytesOrNull(file: string): Promise<Uint8Array | null> {
  const f = Bun.file(file)
  return (await f.exists()) ? await f.bytes() : null
}

interface IndexEntry {
  path: string
  mode: string
  oid: string
  /** Assume-unchanged or skip-worktree: git does not look at it on disk. */
  flagged: boolean
  skipWorktree: boolean
}

/**
 * The index's stage-0 entries, workspace-relative. `ls-files -v` prefixes
 * a tag: `S` skip-worktree, a lowercase letter assume-unchanged (`s` both).
 */
async function indexEntries(workspaceRoot: string): Promise<IndexEntry[]> {
  const out: IndexEntry[] = []
  for (const record of await gitPaths(workspaceRoot, ['ls-files', '-s', '-v', '-z'])) {
    const m = /^(\S) (\d+) ([0-9a-f]+) 0\t(.*)$/s.exec(record)
    if (m === null) continue
    const tag = m[1]!
    out.push({
      path: m[4]!,
      mode: m[2]!,
      oid: m[3]!,
      flagged: tag === 'S' || (tag >= 'a' && tag <= 'z'),
      skipWorktree: tag === 'S' || tag === 's',
    })
  }
  return out
}

/** No entry at `p`, under a parent that is now a file too (ENOTDIR). */
function absent(p: string): boolean {
  try {
    return lstatSync(p, { throwIfNoEntry: false }) === undefined
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') return true
    throw err
  }
}

/**
 * The flagged paths whose disk side moved from the index (`git diff` covers
 * the index against the base): a file whose bytes hash to another blob, a
 * link, or an assume-unchanged file deleted. An absent skip-worktree file
 * is a sparse checkout's: the key leaves it out, and so does this.
 */
async function flaggedChanges(
  workspaceRoot: string,
  flagged: readonly string[],
  index: readonly IndexEntry[],
  changed: readonly string[],
  /** `core.autocrlf` converts (`gitConfigFacts`). */
  autocrlf: boolean,
): Promise<string[]> {
  const byPath = new Map(index.map((e) => [e.path, e]))
  const seen = new Set(changed)
  const out: string[] = []
  let hash: IndexEntry[] = []
  for (const rel of flagged) {
    const entry = byPath.get(rel)
    if (entry === undefined || seen.has(rel)) continue
    // Synchronous: a sparse checkout flags its every absent file, and one
    // awaited stat each was 7 s per 100,000 (a loop of these, 0.15 s).
    if (absent(path.join(workspaceRoot, rel))) {
      if (!entry.skipWorktree) out.push(rel)
    } else if (entry.mode === '120000' || rel.includes('\n')) out.push(rel)
    else hash.push(entry)
  }
  const raw = await filtered(
    workspaceRoot,
    hash.map((e) => e.path),
    autocrlf,
  )
  for (const e of hash) if (raw.has(e.path)) out.push(e.path)
  if (raw.size > 0) hash = hash.filter((e) => !raw.has(e.path))
  if (hash.length === 0) return out
  // `--stdin-paths` hashes each file as `git add` would (its clean
  // filters), so an unchanged one names the index's blob.
  const proc = spawnGit(
    ['hash-object', '--stdin-paths'],
    workspaceRoot,
    new TextEncoder().encode(hash.map((e) => `${e.path}\n`).join('')),
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exit !== 0) {
    throw new UserError(`git hash-object failed (exit ${exit}): ${stderr.trim()}`, 'VX_E_GIT')
  }
  const oids = stdout.split('\n')
  hash.forEach((e, i) => {
    if (oids[i] !== e.oid) out.push(e.path)
  })
  return out
}

/**
 * The links in `links` whose target changed: a file `changed` names, or a
 * directory holding one. A target git cannot diff is changed on every run:
 * one outside the workspace, or git-ignored (or ignored files under a linked
 * directory), since the key reads it whatever git says. A dangling link
 * reads nothing; retargeting it is a change to the link itself.
 */
async function linkedChanges(
  workspaceRoot: string,
  links: readonly string[],
  changed: readonly string[],
  /** Given each link to a directory. */
  dirs: Set<string>,
  /** `gitCaseArgs`, for the ignored listing. */
  caseArgs: readonly string[],
): Promise<string[]> {
  if (links.length === 0) return []
  const realRoot = await realpath(workspaceRoot).catch(() => workspaceRoot)
  const out: string[] = []
  const inside: Array<{ link: string; target: string; dir: boolean }> = []
  for (const link of links) {
    let real: string
    let dir: boolean
    try {
      real = await realpath(path.join(workspaceRoot, link))
      dir = (await stat(real)).isDirectory()
    } catch {
      continue
    }
    if (dir) dirs.add(link)
    const rel = path.relative(realRoot, real)
    if (rel.startsWith('..') || path.isAbsolute(rel)) out.push(link)
    else inside.push({ link, target: rel.split(path.sep).join('/'), dir })
  }
  if (inside.length === 0) return out
  const named = inside.map((l) => l.target).filter((t) => t !== '')
  const ignored = await gitPaths(workspaceRoot, [
    ...caseArgs,
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '-z',
    '--',
    // A name is a path, never pathspec magic (`:x`, `*`).
    ...(named.length === inside.length ? named.map((n) => `:(literal)${n}`) : ['.']),
  ])
  const changedSet = new Set(changed)
  const under = (p: string, dir: string): boolean => dir === '' || p.startsWith(`${dir}/`)
  for (const { link, target, dir } of inside) {
    const unseen = ignored.some((i) => {
      const at = i.replace(/\/$/, '')
      return at === target || under(target, at) || (dir && under(at, target))
    })
    const hit = dir ? changed.some((c) => under(c, target)) : changedSet.has(target)
    if (unseen || hit) out.push(link)
  }
  return out
}

/**
 * The changed paths a glob must match as a directory: a tracked link to
 * one (`dirs`), and each of `maybe` (a link on either side of the diff,
 * an untracked path) that is a link now to no file.
 */
async function changedDirLinks(
  workspaceRoot: string,
  changed: readonly string[],
  dirs: ReadonlySet<string>,
  maybe: ReadonlySet<string>,
): Promise<Set<string>> {
  const out = new Set<string>()
  await Promise.all(
    changed.map(async (rel) => {
      if (dirs.has(rel)) out.add(rel)
      else if (
        maybe.has(rel) &&
        !rel.endsWith('/') &&
        (await noFileLink(path.join(workspaceRoot, rel)))
      ) {
        out.add(rel)
      }
    }),
  )
  return out
}

/** A link now to anything but a file, or a path that is gone (a deleted link). */
async function noFileLink(abs: string): Promise<boolean> {
  try {
    if (!(await lstat(abs)).isSymbolicLink()) return false
  } catch {
    return true
  }
  return !(await stat(abs)
    .then((s) => s.isFile())
    .catch(() => false))
}

/** Run a NUL-separated path-listing git command from the workspace root. */
async function gitPaths(workspaceRoot: string, cmd: string[]): Promise<string[]> {
  const proc = spawnGit([...cmd], workspaceRoot)
  // `Response.text()` strips a leading U+FEFF, the first path's own.
  const stdout = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
    await new Response(proc.stdout).bytes(),
  )
  const stderr = await new Response(proc.stderr).text()
  const exit = await proc.exited
  if (exit !== 0) {
    throw new UserError(
      `git ${cmd.find((a, i) => a !== '-c' && cmd[i - 1] !== '-c')} failed (exit ${exit}): ${stderr.trim()}`,
      'VX_E_GIT',
    )
  }
  return stdout.split('\0').filter((s) => s.length > 0)
}

/**
 * `git diff --raw -z <base>`'s paths, those that are a symlink on either
 * side, and those that are a gitlink on either side: one the change
 * removed took its files with it. Each record
 * is `:<mode> <mode> <oid> <oid> <status>` then its path (one path:
 * `--no-renames`).
 *
 * `diff.autoRefreshIndex=false`: a porcelain `diff` that meets a
 * stat-dirty file rewrites the index under `index.lock`, and ignores
 * `--no-optional-locks`, so a user's `git commit` beside a run failed on
 * that lock. Without the refresh a stat-only change is listed as a
 * modification (`statOnly` drops it).
 */
async function gitDiffPaths(
  workspaceRoot: string,
  base: string,
  partial: Promise<boolean>,
  /** `core.autocrlf` converts (`gitConfigFacts`). */
  autocrlf: Promise<boolean>,
): Promise<{ paths: string[]; gitlinks: string[]; links: string[] }> {
  const diff = (...revs: string[]) =>
    gitPaths(workspaceRoot, [
      '-c',
      'diff.autoRefreshIndex=false',
      // The key reads the worktree's mode under `core.fileMode=false` and
      // trusts no index OID under a weakened stat (git-inputs.ts), so the
      // diff judges by git's full stat: a file only that stat calls dirty
      // is hashed below, and only a DrvFs mode over-selects.
      '-c',
      'core.fileMode=true',
      '-c',
      'core.trustctime=true',
      '-c',
      'core.checkStat=default',
      'diff',
      '--no-renames',
      '--ignore-submodules=none',
      '--relative',
      '--raw',
      '--no-abbrev',
      '-z',
      '--end-of-options',
      ...revs,
    ])
  // A partial clone lacks the base's blobs, and a stat-dirty file made
  // `git diff <base>` read them to drop it: one fetch per file, and git
  // 2.43 crashed (exit 139) on the batch. The base's tree against HEAD's
  // reads no blob, HEAD's against the working tree reads only blobs a
  // checkout has; their union over-selects only a file the working tree
  // put back as the base had it.
  const lists =
    (await partial) || fetchedInto.has(workspaceRoot)
      ? await Promise.all([diff(base, 'HEAD'), diff('HEAD')])
      : [await diff(base)]
  const paths: string[] = []
  const gitlinks: string[] = []
  const links: string[] = []
  const seen = new Set<string>()
  const unread: { rel: string; oid: string; link: boolean }[] = []
  for (const fields of lists) {
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const rel = fields[i + 1]!
      if (seen.has(rel)) continue
      seen.add(rel)
      paths.push(rel)
      const head = fields[i]!
      if (head.startsWith('160000 ', 1) || head.startsWith('160000 ', 8)) gitlinks.push(rel)
      if (head.startsWith('120000 ', 1) || head.startsWith('120000 ', 8)) links.push(rel)
      const [src, dst, oid, worktree, status] = head.slice(1).split(' ')
      if (status === 'M' && src === dst && /^0+$/.test(worktree!) && src !== '160000')
        unread.push({ rel, oid: oid!, link: src === '120000' })
    }
  }
  if (unread.length === 0) return { paths, gitlinks, links }
  const same = await statOnly(workspaceRoot, unread, await autocrlf)
  return { paths: paths.filter((p) => !same.has(p)), gitlinks, links }
}

/**
 * Of the paths the diff listed as modified in the working tree, those
 * whose content is still the base's blob: the working-tree side is hashed
 * as `git add` would (filters, a link's target), so only a stat changed.
 */
async function statOnly(
  workspaceRoot: string,
  unread: readonly { rel: string; oid: string; link: boolean }[],
  /** `core.autocrlf` converts (`gitConfigFacts`). */
  autocrlf: boolean,
): Promise<Set<string>> {
  const same = new Set<string>()
  let files: { rel: string; oid: string }[] = []
  for (const u of unread) {
    if (!u.link) {
      // `--stdin-paths` reads a line and unquotes a leading `"`; the
      // decoder replaced a byte that was not UTF-8. Such a path stays listed.
      if (!/[\n\uFFFD]/.test(u.rel) && !u.rel.startsWith('"')) files.push(u)
      continue
    }
    try {
      const target = await readlink(path.join(workspaceRoot, u.rel), 'buffer')
      const hasher = new Bun.CryptoHasher(u.oid.length === 64 ? 'sha256' : 'sha1')
      hasher.update(`blob ${target.length}\0`)
      hasher.update(target)
      if (hasher.digest('hex') === u.oid) same.add(u.rel)
    } catch {
      // not a link any more: a change
    }
  }
  const raw = await filtered(
    workspaceRoot,
    files.map((f) => f.rel),
    autocrlf,
  )
  if (raw.size > 0) files = files.filter((f) => !raw.has(f.rel))
  if (files.length === 0) return same
  const proc = spawnGit(
    ['hash-object', '--stdin-paths'],
    workspaceRoot,
    new TextEncoder().encode(files.map((f) => `${f.rel}\n`).join('')),
  )
  const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exit !== 0) return same
  const oids = out.split('\n')
  files.forEach((f, i) => {
    if (oids[i] === f.oid) same.add(f.rel)
  })
  return same
}

/**
 * The first of `files` (absolute, above the workspace root) that changed
 * since `base` or is untracked, workspace-relative: `gitDiffPaths` is
 * `--relative` and never lists one. A file outside the repository is
 * git's to tell no more than the key's to pin.
 */
async function outsideChanged(
  workspaceRoot: string,
  base: string,
  files: readonly string[],
): Promise<string | undefined> {
  const realRoot = realpathOr(workspaceRoot)
  const top = spawnGitSync(['rev-parse', '--show-toplevel'], workspaceRoot)
  if (top.exitCode !== 0) return undefined
  const repo = realpathOr(new TextDecoder().decode(top.stdout).replace(/\n$/, ''))
  const rels = files.filter((f) => f.startsWith(repo + path.sep)).map((f) => relPosix(realRoot, f))
  if (rels.length === 0) return undefined
  const specs = rels.map((r) => `:(literal)${r}`)
  const [diffed, untracked] = await Promise.all([
    gitPaths(workspaceRoot, [
      '-c',
      'diff.autoRefreshIndex=false',
      'diff',
      '--no-renames',
      '--name-only',
      '-z',
      '--end-of-options',
      base,
      '--',
      ...specs,
    ]),
    gitPaths(workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...specs]),
  ])
  if (diffed.length > 0) return relPosix(realRoot, path.join(repo, diffed[0]!))
  return untracked[0]
}

/**
 * Of `rels`, the paths a clean filter can rewrite (`core.autocrlf`, or a
 * converting attribute, `parseCheckAttrOutput`),
 * as the key asks it (cache/git-inputs.ts `dropFilteredOids`). `hash-object`
 * names such a file's filtered blob, which a CRLF edit to an LF file leaves
 * the base's, while the key hashes the raw bytes; and raw bytes equal to the
 * blob prove nothing, since a checkout under `eol=crlf` writes others. So
 * each is a change. A failed `check-attr` names every path.
 */
async function filtered(
  workspaceRoot: string,
  rels: readonly string[],
  autocrlf: boolean,
): Promise<Set<string>> {
  if (rels.length === 0 || autocrlf) return new Set(rels)
  const proc = spawnGit(
    CHECK_ATTR,
    workspaceRoot,
    new TextEncoder().encode(rels.map((r) => `${r}\0`).join('')),
  )
  const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return exit === 0 ? parseCheckAttrOutput(out) : new Set(rels)
}

/**
 * Three config facts in one `git config`: `partial`, a remote that serves
 * missing objects on demand (`--filter` on a clone or a fetch),
 * `ignoreCase`, `core.ignorecase` set true, and `autocrlf`,
 * `core.autocrlf` set `true` or `input`.
 */
async function gitConfigFacts(
  workspaceRoot: string,
): Promise<{ partial: boolean; ignoreCase: boolean; autocrlf: boolean }> {
  const proc = spawnGit(
    [
      'config',
      '--get-regexp',
      String.raw`^(remote\..*\.promisor|extensions\.partialclone|core\.ignorecase|core\.autocrlf)$`,
    ],
    workspaceRoot,
  )
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  let partial = false
  let ignoreCase = false
  let autocrlf = false
  for (const l of out.split('\n')) {
    // A bare key (`[core] ignorecase`) is true, as git reads it.
    if (l.startsWith('core.ignorecase'))
      ignoreCase = /^core\.ignorecase( (true|yes|on|[-+]?0*[1-9]\d*[kmg]?))?$/i.test(l)
    else if (l.startsWith('core.autocrlf'))
      autocrlf = /^core\.autocrlf( (input|true|yes|on|[-+]?0*[1-9]\d*[kmg]?))?$/i.test(l)
    else if (l.startsWith('extensions.') || l.endsWith(' true')) partial = true
  }
  return { partial, ignoreCase, autocrlf }
}

/**
 * The base a bare `--affected` compares with: the merge base of HEAD and
 * the base branch (`origin/<baseBranch>`, or the local branch in a clone
 * with no remote; its tip when they share no history). On the base branch
 * itself there is none: what a push to main changed
 * is the last good commit's to say (`--affected=<sha>`), and `HEAD~1`
 * guessed it wrong after any multi-commit push.
 */
export async function defaultAffectedBase(
  workspaceRoot: string,
  baseBranch: string | undefined,
  /** The verb's way to take every project instead: `vx show` has no `--all`. */
  instead = 'run --all (the cache skips what did not change)',
): Promise<string> {
  const found =
    (await baseBranchRef(workspaceRoot, baseBranch)) ??
    (await fetchBaseBranch(workspaceRoot, baseBranch))
  if (found === undefined) {
    const noHistory = noHistoryRefusal(workspaceRoot)
    if (noHistory !== undefined) throw noHistory
    const failed = fetchFailures.get(workspaceRoot)
    if (failed !== undefined) {
      throw new UserError(
        `--affected has no base here: fetching it from origin failed (${failed}): ` +
          'make origin reachable, or name the base: --affected=origin/main',
        'VX_E_AFFECTED_BASE',
      )
    }
    throw new UserError(
      `--affected has no base here: ${baseBranch === undefined ? 'no origin/HEAD, main or master' : `no ${baseBranch} or origin/${baseBranch}`} ` +
        'to compare with: set `baseBranch`, or name the base: --affected=origin/main',
      'VX_E_AFFECTED_BASE',
    )
  }
  // A detached HEAD (a CI checkout of a pushed commit) is on the base
  // branch when the branch holds it: the base was HEAD, or a commit after
  // it, and nothing ran, green.
  if (!found.onIt && found.detached && (await isAncestor(workspaceRoot, 'HEAD', found.ref))) {
    found.onIt = true
  }
  if (found.onIt) {
    throw new UserError(
      `--affected has no default on the base branch (${found.branch}): ${instead}, or name the last good commit, --affected=<sha>`,
      'VX_E_AFFECTED_BASE',
    )
  }
  return found.ref
}

/**
 * Why a base cannot resolve before any ref is to blame: no work tree, or
 * no commit yet. Asked only once a base has failed, so a run that finds
 * one spawns nothing more (X-52).
 */
function noHistoryRefusal(workspaceRoot: string): UserError | undefined {
  const tree = spawnGitSync(['rev-parse', '--is-inside-work-tree'], workspaceRoot, 'pipe')
  if (tree.exitCode !== 0) {
    return notAWorkTree(workspaceRoot, new TextDecoder().decode(tree.stderr).trim())
  }
  if (revParse(workspaceRoot, 'HEAD') === undefined) {
    return new UserError(
      '--affected has no base here: this repository has no commit yet. Commit first, or run without --affected.',
      'VX_E_AFFECTED_BASE',
    )
  }
  return undefined
}

/**
 * The base branch as a ref: `origin/<name>`, else the local branch (a
 * clone with no remote), and whether HEAD is on it. The name is the
 * configured one, else `origin/HEAD`'s, else `main`, else `master`. Its
 * spawns run at once, off the event loop.
 */
async function baseBranchRef(
  workspaceRoot: string,
  configured: string | undefined,
): Promise<{ ref: string; branch: string; onIt: boolean; detached: boolean } | undefined> {
  const text = async (args: string[]): Promise<string> => {
    const proc = spawnGit(args, workspaceRoot)
    const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return exit === 0 ? out.trim() : ''
  }
  const names = configured === undefined ? ['main', 'master'] : [configured]
  const [remoteHead, refs, head] = await Promise.all([
    configured === undefined
      ? text(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])
      : Promise.resolve(''),
    text([
      'for-each-ref',
      '--format=%(refname:short)',
      '--end-of-options',
      ...(configured === undefined
        ? ['refs/remotes/origin']
        : [`refs/remotes/origin/${configured}`]),
      ...names.map((n) => `refs/heads/${n}`),
    ]),
    text(['symbolic-ref', '--short', '-q', 'HEAD']).then(
      async (h) => h || (await rebasing(workspaceRoot, text)),
    ),
  ])
  const have = new Set(refs.split('\n'))
  const at = (branch: string, ref: string) => ({
    ref,
    branch,
    onIt: head === branch,
    detached: head === '',
  })
  if (remoteHead.startsWith('origin/') && have.has(remoteHead)) {
    return at(remoteHead.slice('origin/'.length), remoteHead)
  }
  for (const n of names) if (have.has(`origin/${n}`)) return at(n, `origin/${n}`)
  for (const n of names) if (have.has(n)) return at(n, n)
  return undefined
}

/**
 * The branch a rebase in progress replays, or `''`: it stops on a detached
 * HEAD (a conflict, an `edit`), the base branch's tip when the first
 * commit stops, and that HEAD is the rebased branch, not the base branch.
 * Asked only when HEAD is detached; `--git-path` finds a linked
 * worktree's own git dir.
 */
async function rebasing(
  workspaceRoot: string,
  text: (args: string[]) => Promise<string>,
): Promise<string> {
  const paths = await text([
    'rev-parse',
    '--git-path',
    'rebase-merge/head-name',
    '--git-path',
    'rebase-apply/head-name',
  ])
  for (const p of paths.split('\n')) {
    if (p === '') continue
    const name = await readFile(path.resolve(workspaceRoot, p), 'utf8').catch(() => '')
    if (name.startsWith('refs/heads/')) return name.trim().slice('refs/heads/'.length)
  }
  return ''
}

/**
 * The base `ref` names (`<base>...HEAD` reads as `<base>`, as
 * `affectedChanges` reads it) when it is the commit HEAD is on and HEAD is
 * that branch (or detached), else undefined. A base that IS HEAD can never
 * mark anything affected — the shape of a single-branch clone whose
 * `origin/HEAD` is the branch under test. Another branch on the same commit
 * (a fresh `checkout -b feature origin/main`) has only not moved past it.
 */
export function headBase(workspaceRoot: string, ref: string): string | undefined {
  const head = revParse(workspaceRoot, 'HEAD')
  const base = HEAD_RANGE.exec(ref)?.[1] ?? ref
  if (head === undefined || head !== revParse(workspaceRoot, base)) return undefined
  if (base === 'HEAD') return base
  const proc = spawnGitSync(['symbolic-ref', '--short', '-q', 'HEAD'], workspaceRoot, 'ignore')
  const branch = new TextDecoder().decode(proc.stdout).trim()
  return branch === '' || base === branch || base.endsWith(`/${branch}`) ? base : undefined
}

/** The commit `ref` names, or undefined when it does not resolve here. */
function revParse(workspaceRoot: string, ref: string): string | undefined {
  const proc = spawnGitSync(
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
    workspaceRoot,
    'ignore',
  )
  const sha = new TextDecoder().decode(proc.stdout).trim()
  if (proc.exitCode !== 0 || sha.length === 0) return undefined
  resolvedRefs.set(`${workspaceRoot}\0${ref}`, sha)
  return sha
}

/**
 * Refs `revParse` resolved to a commit, by workspace: the default base is
 * found that way, and `verifyRef` asked git about it again, a synchronous
 * spawn (~3.5 ms) of every bare `--affected`. A ref is fixed for a run.
 */
const resolvedRefs = new Map<string, string>()

/** A ref that names an ancestor of HEAD by its own spelling (`HEAD~1`, `HEAD^`). */
const HEAD_ANCESTOR = /^HEAD(?:~\d*|\^\d*)+$/

/**
 * `git merge-base <ref> HEAD`, or `ref` itself when the two share no
 * ancestor. A merge base proves the ref resolves, so `verifyRef`'s own
 * spawn (synchronous, ~3.5 ms) runs only when there is none: to refuse a
 * ref that does not resolve, or to pass one that does (exit 1, unrelated
 * histories; a tree).
 */
async function mergeBase(workspaceRoot: string, ref: string): Promise<string> {
  // HEAD's own ancestor is its merge base with HEAD: the commit it names,
  // which the default base's search already resolved (`HEAD~1`).
  const known = HEAD_ANCESTOR.test(ref) ? resolvedRefs.get(`${workspaceRoot}\0${ref}`) : undefined
  if (known !== undefined) return known
  const sha = await gitMergeBase(workspaceRoot, ref)
  if (sha !== undefined) return sha
  const reached = await reachMergeBase(workspaceRoot, ref)
  if (reached !== undefined) return reached
  await verifyTreeRef(workspaceRoot, ref)
  // The ref itself is the base only for histories that share nothing. A
  // shallow clone may just lack the commits between them (origin gone, a
  // fetch failed, past MAX_DEEPEN), and its tip selected what the base
  // branch changed.
  if (
    revParse(workspaceRoot, ref) !== undefined &&
    revParse(workspaceRoot, 'HEAD') !== undefined &&
    isShallow(workspaceRoot)
  ) {
    throw new UserError(
      `git ref "${ref}" has no merge base with HEAD in this shallow clone, ` +
        (hasOrigin(workspaceRoot)
          ? 'and origin did not give the history between them: fetch it (`git fetch --unshallow origin`).'
          : 'which has no origin remote: fetch the history between them (`git fetch --unshallow <url>`).'),
      'VX_E_AFFECTED_BASE',
    )
  }
  return ref
}

/**
 * `verifyRef`, then refuse `<rev>:<path>`: it names the tree (or blob) at
 * <path>, and diffed against the working tree its paths miss the <path>/
 * prefix, so `develop:pkgs` selected projects nothing had changed, green.
 * A root tree (`develop^{tree}`, the empty tree) diffs right and stays a base.
 */
async function verifyTreeRef(workspaceRoot: string, ref: string): Promise<void> {
  await verifyRef(workspaceRoot, ref)
  const sub = /^([^:]*):(?!\/)(.+)$/s.exec(ref)
  if (sub !== null) {
    throw new UserError(
      `git ref "${ref}" names what is at ${sub[2]}, not a commit: vx diffs the whole ` +
        `workspace, so pass the commit alone ("${sub[1] || 'HEAD'}").`,
      'VX_E_AFFECTED_BASE',
    )
  }
}

/**
 * The merge base of `ref` and HEAD, or undefined when there is none. A
 * clone that lacks it fetches what it needs from origin (`reachMergeBase`):
 * a plugin reading the base branch's history (shared timings) asks this,
 * not `git merge-base`, so a one-commit checkout serves it too.
 */
export async function mergeBaseWith(
  workspaceRoot: string,
  ref: string,
): Promise<string | undefined> {
  return (await gitMergeBase(workspaceRoot, ref)) ?? (await reachMergeBase(workspaceRoot, ref))
}

/** Whether `commit` is `ref` or one of its ancestors. */
async function isAncestor(workspaceRoot: string, commit: string, ref: string): Promise<boolean> {
  const proc = spawnGit(
    ['merge-base', '--is-ancestor', '--end-of-options', commit, ref],
    workspaceRoot,
  )
  return (await proc.exited) === 0
}

async function gitMergeBase(workspaceRoot: string, ref: string): Promise<string | undefined> {
  const proc = spawnGit(['merge-base', '--end-of-options', ref, 'HEAD'], workspaceRoot)
  const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  const sha = out.trim()
  return exit === 0 && sha.length > 0 ? sha : undefined
}

/**
 * A shallow clone (CI's checkout fetches one commit) lacks the base, or
 * the history between it and HEAD: this fetches from origin what the
 * merge base needs and nothing more. The base's tip at depth 1, then
 * both tips deepened 1, 2, 4… commits until git finds the merge base;
 * commits and trees only, as `--name-only` reads no blob. A pull request's
 * merge checkout has its base as HEAD's parent, so it needs one fetch.
 * A whole clone that fetched one branch (GitLab's, at any GIT_DEPTH)
 * lacks only a base it cannot name: that tip's history is fetched, so
 * the merge base is here at once. Undefined when the clone has the base,
 * has no origin, or the fetch failed.
 */
async function reachMergeBase(workspaceRoot: string, ref: string): Promise<string | undefined> {
  if (!isShallow(workspaceRoot)) {
    if (HEAD_ANCESTOR.test(ref) || revParse(workspaceRoot, ref) !== undefined) return undefined
    const tip = await fetchTip(workspaceRoot, ref, false)
    return tip === undefined ? undefined : gitMergeBase(workspaceRoot, tip)
  }
  const head = revParse(workspaceRoot, 'HEAD')
  if (head === undefined) return undefined
  const ancestor = HEAD_ANCESTOR.test(ref)
  let tip = ancestor ? undefined : revParse(workspaceRoot, ref)
  if (tip === undefined && !ancestor) {
    tip = await fetchTip(workspaceRoot, ref, true)
    if (tip === undefined) return undefined
  }
  if (tip !== undefined && parentsOf(workspaceRoot, head).includes(tip)) return tip
  for (let depth = 1; depth <= MAX_DEEPEN; depth *= 2) {
    const tips = tip === undefined ? [head] : [head, tip]
    if (!(await fetchOrigin(workspaceRoot, [`--deepen=${depth}`, ...tips]))) return undefined
    // `HEAD~2` is its own merge base with HEAD, once the history has it.
    if (ancestor) {
      const at = revParse(workspaceRoot, ref)
      if (at !== undefined) return at
    } else {
      const found = await gitMergeBase(workspaceRoot, tip!)
      if (found !== undefined) return found
    }
    if (!isShallow(workspaceRoot)) return undefined
  }
  return undefined
}

/**
 * `ref`'s commit fetched from origin, or undefined when origin cannot name
 * it: at depth 1 into a shallow clone, with its history into a whole one
 * (`--depth` would make it shallow).
 */
async function fetchTip(
  workspaceRoot: string,
  ref: string,
  shallow: boolean,
): Promise<string | undefined> {
  const spec = originSpec(ref)
  if (
    spec === undefined ||
    !(await fetchOrigin(workspaceRoot, shallow ? ['--depth=1', spec] : [spec]))
  ) {
    return undefined
  }
  return revParse(workspaceRoot, ref)
}

/**
 * The base of a two-dot `<ref>..HEAD`: `ref` itself, which a clone that
 * lacks it fetches as the three-dot form fetches its tip (CI's depth-1 checkout
 * refused `origin/main..HEAD` while `origin/main...HEAD` worked). HEAD's
 * own ancestor is its merge base with HEAD, reached by deepening.
 */
async function rangeBase(workspaceRoot: string, ref: string): Promise<string> {
  if (HEAD_ANCESTOR.test(ref)) return mergeBase(workspaceRoot, ref)
  if (revParse(workspaceRoot, ref) === undefined) {
    await fetchTip(workspaceRoot, ref, isShallow(workspaceRoot))
  }
  await verifyTreeRef(workspaceRoot, ref)
  return ref
}

/** The clones `fetchOrigin` fetched into, so made partial: `gitConfigFacts` may have answered first. */
const fetchedInto = new Set<string>()

/** Why a fetch from origin (or asking origin its default branch) failed, by workspace: git's first line. */
const fetchFailures = new Map<string, string>()

/** Deepening stops here (2,047 commits on each side): past it, the base is the user's to fetch. */
const MAX_DEEPEN = 1024

function isShallow(workspaceRoot: string): boolean {
  const proc = spawnGitSync(['rev-parse', '--is-shallow-repository'], workspaceRoot, 'ignore')
  return new TextDecoder().decode(proc.stdout).trim() === 'true'
}

/**
 * Whether origin has a URL. Asked only before a fetch or on a refusal. Not `git remote get-url`: a `[remote "origin"]` of
 * promisor keys alone (git's filtered fetch from no origin writes one) it
 * names as a URL.
 */
function hasOrigin(workspaceRoot: string): boolean {
  return (
    spawnGitSync(['config', '--get', 'remote.origin.url'], workspaceRoot, 'ignore').exitCode === 0
  )
}

/** The parents a commit names, even where a shallow clone cut them off. */
function parentsOf(workspaceRoot: string, sha: string): string[] {
  const proc = spawnGitSync(
    ['cat-file', '--end-of-options', 'commit', sha],
    workspaceRoot,
    'ignore',
  )
  const out: string[] = []
  for (const line of new TextDecoder().decode(proc.stdout).split('\n')) {
    if (line === '') break
    if (line.startsWith('parent ')) out.push(line.slice('parent '.length))
  }
  return out
}

/**
 * What to ask origin for a base: a commit id as it is (GitHub serves any
 * commit a ref reaches), `origin/<branch>` as that branch into its
 * remote-tracking ref, any other plain name as origin's tag of that name
 * (a release base, `v1`; `--no-tags` fetched none). An expression (`v1~2`)
 * is a name only this clone knows.
 */
function originSpec(ref: string): string | undefined {
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(ref)) return ref
  const branch = /^(?:refs\/remotes\/)?origin\/(.+)$/s.exec(ref)?.[1]
  if (branch !== undefined) {
    return branch === 'HEAD' ? undefined : `+refs/heads/${branch}:refs/remotes/origin/${branch}`
  }
  const tag = /^(?:refs\/tags\/)?([^\s~^:?*[\\@{]+)$/.exec(ref)?.[1]
  if (tag === undefined || tag === 'HEAD' || tag.startsWith('refs/')) return undefined
  return `+refs/tags/${tag}:refs/tags/${tag}`
}

/**
 * A clone with no base branch at all (a CI checkout of one commit, or of
 * one branch's whole history): fetch it from origin, the configured one
 * or origin's default, at depth 1 into a shallow clone, with the history
 * the merge base needs into a whole one.
 */
async function fetchBaseBranch(
  workspaceRoot: string,
  configured: string | undefined,
): Promise<{ ref: string; branch: string; onIt: boolean; detached: boolean } | undefined> {
  if (!hasOrigin(workspaceRoot)) return undefined
  const branch = configured ?? (await originDefaultBranch(workspaceRoot))
  if (branch === undefined) return undefined
  const spec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`
  const depth = isShallow(workspaceRoot) ? ['--depth=1'] : []
  if (!(await fetchOrigin(workspaceRoot, [...depth, spec]))) return undefined
  const proc = spawnGitSync(['symbolic-ref', '--short', '-q', 'HEAD'], workspaceRoot, 'ignore')
  const head = new TextDecoder().decode(proc.stdout).trim()
  return { ref: `origin/${branch}`, branch, onIt: head === branch, detached: head === '' }
}

/** The branch origin's HEAD names, asked of origin (a one-commit checkout has no `origin/HEAD`). */
async function originDefaultBranch(workspaceRoot: string): Promise<string | undefined> {
  const proc = spawnGit(['ls-remote', '--symref', 'origin', 'HEAD'], workspaceRoot)
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exit !== 0) {
    noteFetchFailure(workspaceRoot, err)
    return undefined
  }
  return /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out)?.[1]
}

/**
 * `git fetch` from origin into a clone that lacks the base, without blobs: the diff
 * names paths, and the lockfile a claim reads at the base is fetched on
 * demand. Never prompts for credentials; false when it failed.
 */
async function fetchOrigin(workspaceRoot: string, args: string[]): Promise<boolean> {
  // With no origin the fetch fails, yet first writes a promisor
  // `[remote "origin"]` into the user's config.
  if (!hasOrigin(workspaceRoot)) return false
  try {
    const proc = Bun.spawn({
      cmd: [
        executablePath('git'),
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-recurse-submodules',
        '--filter=blob:none',
        'origin',
        ...args,
      ],
      env: { ...gitEnv(), GIT_TERMINAL_PROMPT: '0' },
      cwd: workspaceRoot,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    })
    fetchedInto.add(workspaceRoot)
    const [err, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    if (exit === 0) fetchFailures.delete(workspaceRoot)
    else noteFetchFailure(workspaceRoot, err)
    return exit === 0
  } catch (err) {
    if (isExecutableMissing(err)) throw gitSpawnRefusal(workspaceRoot)
    throw err
  }
}

function noteFetchFailure(workspaceRoot: string, stderr: string): void {
  const line = stderr
    .split('\n')
    .find((l) => l.trim().length > 0)
    ?.trim()
    .replace(/^(fatal|error): /, '')
  fetchFailures.set(workspaceRoot, line ?? 'git gave no reason')
}

async function verifyRef(workspaceRoot: string, ref: string): Promise<void> {
  if (resolvedRefs.has(`${workspaceRoot}\0${ref}`)) return
  // A full commit id resolves whether or not its object is here (a base
  // origin could not give), and the diff then failed with git's dump.
  // `^{object}` asks for the object, and still passes a tree; a `<rev>:<path>`
  // would read it as part of the path.
  const proc = spawnGitSync(
    [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      ref.includes(':') ? ref : `${ref}^{object}`,
    ],
    workspaceRoot,
    'pipe',
  )
  if (proc.exitCode === 0) return
  // `--verify --quiet` exits 1 for "that ref does not exist" and 128 for
  // "git could not run here at all" (not a repository, corrupt objects,
  // permissions). Reporting the second as a ref problem sends you hunting
  // for a branch name when the real fault is the repository — so only exit
  // 1 gets the ref message; anything else surfaces what git actually said.
  const stderr = new TextDecoder().decode(proc.stderr).trim()
  if (proc.exitCode !== 1) {
    const noHistory = noHistoryRefusal(workspaceRoot)
    if (noHistory !== undefined) throw noHistory
    // `--quiet` also silences a ref git refused in its own words (a reflog
    // entry the log lacks, `main@{9}`: exit 128): ask again to say why.
    if (stderr.length === 0) {
      const loud = spawnGitSync(
        ['rev-parse', '--verify', '--end-of-options', ref],
        workspaceRoot,
        'pipe',
      )
      const why = new TextDecoder()
        .decode(loud.stderr)
        .trim()
        .replace(/^fatal: /, '')
      if (loud.exitCode !== 0 && why.length > 0) {
        throw new UserError(
          `git ref "${ref}" did not resolve: ${why.replace(/\.?$/, '.')}`,
          'VX_E_AFFECTED_BASE',
        )
      }
    }
    throw new UserError(
      `git rev-parse failed (exit ${proc.exitCode}) in ${workspaceRoot}` +
        (stderr.length > 0 ? `: ${stderr}` : ''),
      'VX_E_GIT',
    )
  }
  // A base origin could not give (`reachMergeBase`): no origin, no
  // network, a name only another clone has.
  const failed = fetchFailures.get(workspaceRoot)
  throw new UserError(
    `git ref "${ref}" did not resolve. Pass a branch or commit you have locally.` +
      (!isShallow(workspaceRoot)
        ? failed === undefined
          ? ''
          : ` Fetching it from origin failed: ${failed.replace(/\.?$/, '.')}`
        : hasOrigin(workspaceRoot)
          ? ` This clone is shallow and ${failed === undefined ? 'origin did not give it' : `fetching it from origin failed (${failed})`}: ` +
            'fetch the base (`git fetch --depth=1 origin <base>`).'
          : ' This clone is shallow and has no origin remote: fetch the base from where it lives ' +
            '(`git fetch --depth=1 <url> <base>`), or add one (`git remote add origin <url>`).'),
    'VX_E_AFFECTED_BASE',
  )
}

function projectsContaining(
  workspaceRoot: string,
  changedRelPaths: readonly string[],
  /** The changed paths that are nested repositories (`nested` in `affectedChanges`). */
  nested: ReadonlySet<string>,
  projects: readonly ProjectMeta[],
  realDirs: ReadonlyMap<string, string>,
  /** Told each owned path relative to its project, and each nested repository's projects. */
  on?: { path(name: string, rel: string, wsRel: string): void; repo(name: string): void },
): Set<string> {
  // Index projects by their (canonical) dir, then for each changed path walk
  // its ancestor dirs bottom-up until one is a project dir. The FIRST hit is
  // the DEEPEST containing project — so a nested project still wins over its
  // parent, exactly as the prior longest-dir sort did — but this is
  // O(files · path-depth) instead of O(files · projects): independent of the
  // project count, which is what a big --affected diff on a 1000-project repo
  // pays for.
  const dirToName = dirIndex(projects)
  // A member linked in from elsewhere in the tree (`pkgs/b -> ../ext/b`) is
  // indexed by its link, and git reports its files at their real place
  // (`ext/b/src/a.txt`), which resolved to no project: an edit there
  // selected nothing. Its real place under the root is indexed
  // too. One realpath per member, and only on an --affected run.
  const realRoot = realpathOr(workspaceRoot)
  for (const p of projects) {
    const real = realDirs.get(p.dir) ?? p.dir
    const rel = path.relative(realRoot, real)
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    dirToName.add(path.resolve(workspaceRoot, rel), p.name)
  }
  const owned = new Set<string>()
  for (const rel of changedRelPaths) {
    const repo = nested.has(rel)
    const at = path.resolve(workspaceRoot, rel)
    let dir = at
    for (;;) {
      const hit = dirToName.get(dir)
      if (hit !== undefined) {
        const { name } = hit
        owned.add(name)
        on?.path(name, relPosix(hit.dir, hit.dir === dir ? at : at.normalize('NFC')), rel)
        // Its files are the project's inputs, and none of them is this
        // path: a task's globs cannot say whether they reach inside.
        if (repo) on?.repo(name)
        break
      }
      const parent = path.dirname(dir)
      if (parent === dir) break // reached the filesystem root
      dir = parent
    }
    if (!repo) continue
    // A submodule whose checkout moved or is dirty (`vendor/sub`), an
    // embedded repository left untracked (`vendor/nested/`): the workspace
    // repository sees the nested one as that single path, so a change
    // inside is a change to it, and every project under it is affected.
    // Its own enumeration already keys those projects on their files
    // (git-inputs.ts); without this, `--affected` after an edit inside
    // selected none of them.
    const prefix = at + path.sep
    for (const [dir, name] of dirToName.entries()) {
      if (!dir.startsWith(prefix)) continue
      owned.add(name)
      on?.repo(name)
    }
  }
  return owned
}
