// `--affected` — git-relative project selection.
//
// Resolves the set of project names whose files have changed since a
// given git ref: `git diff --name-only <merge-base(since, HEAD)>`, which
// compares that commit to the working tree — commits on this branch +
// index + unstaged — so it captures everything you touched and nothing
// the base branch moved on with. Matches Turbo's `[<since>]` semantics.

import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  executablePath,
  gitEnv,
  gitSpawnRefusal,
  isExecutableMissing,
  isInstalledPath,
  notAWorkTree,
  relPosix,
  UserError,
} from '../util/index.js'
import { LOCKFILE_NAME } from './lockfile.js'
import { configImportOwners, realpathOr } from './config-imports.js'
import { WORKSPACE_CONFIG_FILENAMES } from './project-loader.js'
import { bunPatchFiles } from './fingerprint.js'
import { PROJECT_CONFIG_FILENAMES, type ProjectMeta } from './workspace.js'

/**
 * Every git call here goes through these two: a git that is not on PATH
 * is one refusal naming the install (util `gitSpawnRefusal`), never the
 * `ENOENT` stack `defaultAffectedBase` showed a minimal image
 * (2026-09-16). A git that ran and failed is each caller's to read.
 */
function spawnGitSync(
  args: string[],
  cwd: string,
  stderr: 'pipe' | 'ignore' = 'pipe',
): ReturnType<typeof Bun.spawnSync> {
  try {
    return Bun.spawnSync({
      cmd: [executablePath('git'), ...args],
      env: gitEnv(),
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
  projects: readonly ProjectMeta[]
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
   * left the declaring project out of a run its key called stale
   * (item 954). The `--affected` sugar's graph walk has already staged every
   * config, so there it costs nothing more.
   */
  workspaceGlobOwners?: (
    changedPaths: readonly string[],
    nested: readonly string[],
  ) => Promise<Iterable<string>>
  /**
   * The projects with a task naming a gitignored input that exists: no diff
   * shows an edit to one, so each is a candidate (`ignoredInputsNamed`).
   */
  ignoredInputOwners?: () => Promise<Iterable<string>>
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
}

export interface FingerprintClaims {
  readonly files: ReadonlySet<string>
  /** Project names a change to a claimed file affects; `undefined` = all. */
  affected(change: {
    file: string
    before: Uint8Array | null
    after: Uint8Array | null
  }): Promise<ReadonlySet<string> | undefined>
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
 * What `--affected` seeds its tasks from (owner, 2026-10-04): the changed
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
  /**
   * The changed paths that are nested repositories (a submodule, an
   * embedded repository), workspace-relative: each stands for every file
   * in it, so a `workspaceFiles` glob that reaches under one is reached.
   */
  nested?: readonly string[]
}

export async function affectedChanges(
  args: AffectedArgs,
  perTask = true,
): Promise<AffectedChanges> {
  // Turbo's CI spelling, `[origin/main...HEAD]`, is the base alone here:
  // vx already diffs from the merge base (three dots' meaning), and the
  // working tree it diffs to holds HEAD (D-117). Its two-dot `[A..HEAD]`
  // diffs from A itself (G-145). Any other range is refused.
  const headRange = /^(.+?)(\.{2,3})HEAD$/s.exec(args.since)
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
  const base = fromMergeBase
    ? await mergeBase(args.workspaceRoot, since)
    : (await verifyRef(args.workspaceRoot, since), since)

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
    // the task's key moved (item 951).
    //
    // `--raw` for each path's mode: a gitlink (160000) is a nested
    // repository, one path standing for every file in it (`nested` below).
    gitDiffPaths(args.workspaceRoot, base),
    // `git diff` never reports untracked-but-not-ignored files, but input
    // enumeration does (`git ls-files --cached --others --exclude-standard`),
    // so a brand-new source file changes a task's cache key. Union it in or
    // `--affected` skips a package that genuinely has new work.
    (async () =>
      (await args.untracked?.().catch(() => null)) ??
      gitPaths(args.workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z']))(),
  ])

  // .vx/projects.lock.json (workspace-root metadata) is excluded like a gitignored
  // file: re-running `vx lock` must not mark every project affected.
  // An untracked file under `node_modules` is an install, which the input
  // enumeration drops too (`isInstalledPath`); a tracked one is a source.
  const changed = [...diffed.paths, ...untracked.filter((s) => !isInstalledPath(s))].filter(
    (s) => s !== LOCKFILE_NAME,
  )
  // A symlinked input keys the content behind it (cache/linked-inputs.ts),
  // and the diff names that content's path, never the link's: a link whose
  // target changed is a changed path itself.
  changed.push(
    ...(await linkedChanges(
      args.workspaceRoot,
      (await args.links?.().catch(() => null)) ?? (await trackedLinks(args.workspaceRoot)),
      changed,
    )),
  )
  // The nested repositories git reports as one path: a gitlink, or an
  // untracked embedded repository (`dir/`, the only path git prints so).
  const nested = new Set(diffed.gitlinks)
  for (const rel of untracked) if (rel.endsWith('/')) nested.add(rel)

  // A root file a plugin CLAIMS (`VxPlugin.fingerprint`: a lockfile, an
  // install setting) re-keys tasks through what its claimant folds, and it
  // sits at the root, owned by no project or by the root alone: mapping
  // paths to directories selected ZERO projects for a lockfile bump that
  // re-keyed them all, and `vx run test --affected` after a `pnpm update`
  // exited 0 having run nothing — the failure `docs/cli.md` warns against:
  // "input hashing sees it, so `--affected` must too." So selection asks the
  // claimant the question its key answers, with the bytes at the base ref
  // and in the working tree; the answer is unioned with the path-owned
  // projects below, and only "cannot tell" widens. Core keys no root file
  // itself, so an unclaimed one is a path like any other.
  //
  // Selection is not hashed, so widening it here changes no cache key.
  const everything = (file: string): AffectedChanges => {
    const all = new Set(args.projects.map((p) => p.name))
    const wholeBy = new Map([...all].map((n) => [n, file]))
    return { projects: all, changed, paths: new Map(), whole: all, wholeBy }
  }
  // The workspace config's plugins shape every project's resolved config,
  // so its edit can re-key any task and selection cannot tell which (item
  // 953). No key folds the file; selection is not hashed, so widening here
  // changes no key.
  const wsConfig = WORKSPACE_CONFIG_FILENAMES.find((n) => changed.includes(n))
  if (wsConfig !== undefined) return everything(wsConfig)
  // Loading the workspace file costs an evaluation; only a changed ROOT
  // name can be claimed, so a diff inside the projects never loads it.
  let claims: FingerprintClaims | undefined
  const loadClaims = async (): Promise<FingerprintClaims | undefined> =>
    (claims ??= await args.fingerprintClaims?.())
  // A patch bun.lock names folds into the key of the plugin that claims
  // bun.lock (`bun()`; the lockfile records no hash of it), so its edit
  // widens as a lockfile edit does. A patch the lockfile no longer names
  // moved bun.lock itself.
  if (changed.length > 0) {
    const lock = await bytesOrNull(path.join(args.workspaceRoot, 'bun.lock'))
    if (lock !== null) {
      const patches = new Set(bunPatchFiles(lock))
      const patch = changed.find((p) => patches.has(p))
      if (patch !== undefined && (await loadClaims())?.files.has('bun.lock')) {
        return everything(patch)
      }
    }
  }
  const claimedOwned = new Map<string, string>()
  const rootNamesChanged = changed.filter((p) => !p.includes('/'))
  const claimed = rootNamesChanged.length > 0 ? await loadClaims() : undefined
  for (const file of rootNamesChanged) {
    if (claimed === undefined || !claimed.files.has(file)) continue
    const answer = await claimed.affected({
      file,
      before: await gitBytesAt(args.workspaceRoot, base, file),
      after: await bytesOrNull(path.join(args.workspaceRoot, file)),
    })
    if (answer === undefined) return everything(file)
    for (const name of answer) if (!claimedOwned.has(name)) claimedOwned.set(name, file)
  }

  const realDirs = new Map(
    await Promise.all(
      args.projects.map(async (p) => [p.dir, await realpath(p.dir).catch(() => p.dir)] as const),
    ),
  )
  const paths = new Map<string, string[]>()
  const whole = new Set<string>(claimedOwned.keys())
  const owned = projectsContaining(
    args.workspaceRoot,
    changed,
    nested,
    args.projects,
    realDirs,
    perTask
      ? {
          path: (name, rel) => {
            const list = paths.get(name)
            if (list) list.push(rel)
            else paths.set(name, [rel])
          },
          repo: (name) => whole.add(name),
        }
      : undefined,
  )
  for (const name of claimedOwned.keys()) owned.add(name)

  // A config that makes an existing directory a project took files from
  // the project above it.
  const configs = changed.filter((rel) => CONFIG_NAMES.has(path.posix.basename(rel)))
  if (configs.length > 0) {
    const atBase = await gitBlobsAt(args.workspaceRoot, base, configs)
    for (const name of parentsOfNewNested(args.workspaceRoot, atBase, args.projects)) {
      owned.add(name)
      whole.add(name)
    }
  }

  // THIRD CHANNEL: a project whose `vx.config.*` IMPORTS a changed file.
  // Resolved-config hashing folds those values into the key, so the same
  // sentence above applies — input hashing sees it, so selection must. This
  // runs on the FULL changed set, not just the paths no project owns: the
  // common shape is a config reaching into ANOTHER project
  // (`../../src/index.ts`), whose target is owned.
  // Per task, a project that owns the changed file still needs to know its
  // config imported it: that re-keys every task, whatever their inputs.
  for (const name of await configImportOwners({
    workspaceRoot: args.workspaceRoot,
    projects: args.projects,
    changed,
    skip: perTask ? new Set() : owned,
  })) {
    owned.add(name)
    whole.add(name)
  }

  const nestedDirs = [...nested].map((rel) => rel.replace(/\/$/, ''))
  const done = (): AffectedChanges => ({
    projects: owned,
    changed,
    paths,
    whole,
    ...(claimedOwned.size > 0 ? { wholeBy: claimedOwned } : {}),
    ...(nestedDirs.length > 0 ? { nested: nestedDirs } : {}),
  })
  if (args.ignoredInputOwners !== undefined) {
    for (const name of await args.ignoredInputOwners()) owned.add(name)
  }
  if (changed.length === 0 || args.workspaceGlobOwners === undefined) return done()
  for (const name of await args.workspaceGlobOwners(changed, nestedDirs)) owned.add(name)
  return done()
}

const CONFIG_NAMES: ReadonlySet<string> = new Set(PROJECT_CONFIG_FILENAMES)

/**
 * The projects a NEW nested project took files from. A project's inputs
 * stop at every project below it, so a config that makes an existing
 * directory a project re-keys the project above it — its `**` lost the
 * directory's files — while containment maps the change to the new
 * project alone, and `--affected` left the re-keyed parent out. "New" is
 * judged at the base: none of the changed configs in its directory was
 * there. `atBase` holds each changed config there.
 */
function parentsOfNewNested(
  workspaceRoot: string,
  atBase: ReadonlyMap<string, Uint8Array | null>,
  projects: readonly ProjectMeta[],
): Set<string> {
  const out = new Set<string>()
  // Keyed NFC: macOS git reports paths NFC (core.precomposeunicode) while a
  // dir discovered by readdir keeps the spelling it was created with.
  const dirToName = new Map<string, string>()
  for (const p of projects) dirToName.set(p.dir.normalize('NFC'), p.name)
  const existed = new Set<string>()
  for (const [rel, bytes] of atBase) if (bytes !== null) existed.add(path.posix.dirname(rel))
  for (const rel of atBase.keys()) {
    if (existed.has(path.posix.dirname(rel))) continue
    const dir = path.resolve(workspaceRoot, path.posix.dirname(rel))
    if (!dirToName.has(dir)) continue
    let parent: string | undefined
    for (let d = path.dirname(dir); parent === undefined; d = path.dirname(d)) {
      parent = dirToName.get(d)
      if (path.dirname(d) === d) break
    }
    if (parent !== undefined) out.add(parent)
  }
  return out
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

/** The symlinks the index lists, workspace-relative. */
async function trackedLinks(workspaceRoot: string): Promise<string[]> {
  const out: string[] = []
  for (const record of await gitPaths(workspaceRoot, ['ls-files', '-s', '-z'])) {
    if (record.startsWith('120000 ')) out.push(record.slice(record.indexOf('\t') + 1))
  }
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
    const rel = path.relative(realRoot, real)
    if (rel.startsWith('..') || path.isAbsolute(rel)) out.push(link)
    else inside.push({ link, target: rel.split(path.sep).join('/'), dir })
  }
  if (inside.length === 0) return out
  const named = inside.map((l) => l.target).filter((t) => t !== '')
  const ignored = await gitPaths(workspaceRoot, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '-z',
    '--',
    ...(named.length === inside.length ? named : ['.']),
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
    throw new UserError(`git ${cmd[0]} failed (exit ${exit}): ${stderr.trim()}`, 'VX_E_GIT')
  }
  return stdout.split('\0').filter((s) => s.length > 0)
}

/**
 * `git diff --raw -z <base>`'s paths, and those that are a gitlink on
 * either side: one the change removed took its files with it. Each record
 * is `:<mode> <mode> <oid> <oid> <status>` then its path (one path:
 * `--no-renames`).
 */
async function gitDiffPaths(
  workspaceRoot: string,
  base: string,
): Promise<{ paths: string[]; gitlinks: string[] }> {
  const fields = await gitPaths(workspaceRoot, [
    'diff',
    '--no-renames',
    '--ignore-submodules=none',
    '--relative',
    '--raw',
    '-z',
    '--end-of-options',
    base,
  ])
  const paths: string[] = []
  const gitlinks: string[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const rel = fields[i + 1]!
    paths.push(rel)
    const head = fields[i]!
    if (head.startsWith('160000 ', 1) || head.startsWith('160000 ', 8)) gitlinks.push(rel)
  }
  return { paths, gitlinks }
}

/**
 * Resolve the default base for `--affected` with no explicit value.
 * Tries the remote's HEAD branch first (`origin/main`, `origin/master`,
 * etc.), then `origin/main`, `origin/master`, `main`, `master`, then
 * falls back to `HEAD~1`. A clone with no `origin/HEAD` and
 * no parent commit — a CI checkout at `fetch-depth: 1` — has no base at
 * all, and says so here rather than failing on a ref nobody typed.
 */
export async function defaultAffectedBase(workspaceRoot: string): Promise<string> {
  const probe = spawnGitSync(
    ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'],
    workspaceRoot,
    'ignore',
  )
  const out = new TextDecoder().decode(probe.stdout).trim()
  // An origin/HEAD naming a branch the remote deleted (a pruned fetch keeps
  // the symref) is no base either: it failed as `git ref "origin/master" did
  // not resolve`, a ref nobody typed, where an unset one falls back.
  if (probe.exitCode === 0 && out.length > 0 && revParse(workspaceRoot, out) !== undefined) {
    return out
  }
  // No origin/HEAD: `git remote add` + fetch, as actions/checkout does, sets
  // none, and `HEAD~1` saw only a feature branch's last commit where Turbo
  // and Nx compare with `main` (D-93). The usual trunk names, remote first;
  // one that IS HEAD (a push to main) falls through to `HEAD~1` as before.
  const trunk = trunkBase(workspaceRoot)
  if (trunk !== undefined) return trunk
  if (revParse(workspaceRoot, 'HEAD~1') === undefined) {
    const noHistory = noHistoryRefusal(workspaceRoot)
    if (noHistory !== undefined) throw noHistory
    throw new UserError(
      '--affected has no base here: origin/HEAD is not set (or names a branch that is gone) and HEAD has no parent to compare ' +
        'with — a shallow clone? Fetch history (actions/checkout: fetch-depth: 0) or name the ' +
        'base: --affected=origin/main',
      'VX_E_AFFECTED_BASE',
    )
  }
  return 'HEAD~1'
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

const TRUNKS = ['origin/main', 'origin/master', 'main', 'master']

/** The first of `TRUNKS` that exists and is not HEAD's commit, in one spawn. */
function trunkBase(workspaceRoot: string): string | undefined {
  const proc = spawnGitSync(
    [
      'for-each-ref',
      '--format=%(refname:short) %(objectname)',
      '--end-of-options',
      ...TRUNKS.map((t) => (t.startsWith('origin/') ? `refs/remotes/${t}` : `refs/heads/${t}`)),
    ],
    workspaceRoot,
    'ignore',
  )
  if (proc.exitCode !== 0) return undefined
  const at = new Map(
    new TextDecoder()
      .decode(proc.stdout)
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.split(' ') as [string, string]),
  )
  const head = revParse(workspaceRoot, 'HEAD')
  return TRUNKS.find((t) => at.has(t) && at.get(t) !== head)
}

/**
 * Does `ref` name the commit HEAD is on? A base that IS HEAD can never
 * mark anything affected — the shape of a single-branch clone whose
 * `origin/HEAD` is the branch under test.
 */
export function refIsHead(workspaceRoot: string, ref: string): boolean {
  const head = revParse(workspaceRoot, 'HEAD')
  return head !== undefined && head === revParse(workspaceRoot, ref)
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
  const proc = spawnGit(['merge-base', '--end-of-options', ref, 'HEAD'], workspaceRoot)
  const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  const sha = out.trim()
  if (exit === 0 && sha.length > 0) return sha
  await verifyRef(workspaceRoot, ref)
  // `<rev>:<path>` names the tree (or blob) at <path>: diffed against the
  // working tree, its paths miss the <path>/ prefix, and `develop:pkgs`
  // selected projects nothing had changed, green. A root tree
  // (`develop^{tree}`, the empty tree) diffs right and stays a base.
  const sub = /^([^:]*):(?!\/)(.+)$/s.exec(ref)
  if (sub !== null) {
    throw new UserError(
      `git ref "${ref}" names what is at ${sub[2]}, not a commit: vx diffs the whole ` +
        `workspace, so pass the commit alone ("${sub[1] || 'HEAD'}").`,
      'VX_E_AFFECTED_BASE',
    )
  }
  return ref
}

async function verifyRef(workspaceRoot: string, ref: string): Promise<void> {
  if (resolvedRefs.has(`${workspaceRoot}\0${ref}`)) return
  const proc = spawnGitSync(
    ['rev-parse', '--verify', '--quiet', '--end-of-options', ref],
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
    throw new UserError(
      `git rev-parse failed (exit ${proc.exitCode}) in ${workspaceRoot}` +
        (stderr.length > 0 ? `: ${stderr}` : ''),
      'VX_E_GIT',
    )
  }
  // A shallow clone (CI's checkout fetches one commit by default) has no
  // HEAD~1 and no base branch: the ref exists, the history does not.
  const shallow = spawnGitSync(['rev-parse', '--is-shallow-repository'], workspaceRoot, 'pipe')
  const isShallow = new TextDecoder().decode(shallow.stdout).trim() === 'true'
  throw new UserError(
    `git ref "${ref}" did not resolve. Pass a branch or commit you have locally.` +
      (isShallow
        ? ' This clone is shallow: fetch the history the base needs (`git fetch --unshallow`, or `fetch-depth: 0` on actions/checkout).'
        : ''),
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
  on?: { path(name: string, rel: string): void; repo(name: string): void },
): Set<string> {
  // Index projects by their (canonical) dir, then for each changed path walk
  // its ancestor dirs bottom-up until one is a project dir. The FIRST hit is
  // the DEEPEST containing project — so a nested project still wins over its
  // parent, exactly as the prior longest-dir sort did — but this is
  // O(files · path-depth) instead of O(files · projects): independent of the
  // project count, which is what a big --affected diff on a 1000-project repo
  // pays for.
  // Keyed NFC: macOS git reports paths NFC (core.precomposeunicode) while a
  // dir discovered by readdir keeps the spelling it was created with.
  const dirToName = new Map<string, string>()
  for (const p of projects) dirToName.set(p.dir.normalize('NFC'), p.name)
  // A member linked in from elsewhere in the tree (`pkgs/b -> ../ext/b`) is
  // indexed by its link, and git reports its files at their real place
  // (`ext/b/src/a.txt`), which resolved to no project: an edit there
  // selected nothing (item 1079). Its real place under the root is indexed
  // too. One realpath per member, and only on an --affected run.
  const realRoot = realpathOr(workspaceRoot)
  for (const p of projects) {
    const real = realDirs.get(p.dir) ?? p.dir
    const rel = path.relative(realRoot, real)
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    const spelled = path.resolve(workspaceRoot, rel).normalize('NFC')
    if (!dirToName.has(spelled)) dirToName.set(spelled, p.name)
  }
  const owned = new Set<string>()
  for (const rel of changedRelPaths) {
    const repo = nested.has(rel)
    let dir = path.resolve(workspaceRoot, rel).normalize('NFC')
    for (;;) {
      const name = dirToName.get(dir)
      if (name !== undefined) {
        owned.add(name)
        on?.path(name, relPosix(dir, path.resolve(workspaceRoot, rel).normalize('NFC')))
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
    const prefix = path.resolve(workspaceRoot, rel).normalize('NFC') + path.sep
    for (const [dir, name] of dirToName) {
      if (!dir.startsWith(prefix)) continue
      owned.add(name)
      on?.repo(name)
    }
  }
  return owned
}
