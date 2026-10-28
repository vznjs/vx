// `vx watch`'s event filters: which paths never start a cycle (the ignore
// rules, git-ignored paths, the root arm's filter) and which files reshape
// the watched set. Pure decisions over paths; the loop acts on them.

import fs from 'node:fs'
import path from 'node:path'
import {
  executablePath,
  gitEnv,
  isLiteralPattern,
  normalizeGlob,
  outputMatcher,
  realPath,
  staticPrefix,
  taskGlob,
} from '../util/index.js'
import { asTrees } from '../cache/index.js'
import { PROJECT_CONFIG_FILENAMES, WORKSPACE_CONFIG_FILENAMES } from '../workspace/index.js'
import { isIgnoredDir } from './watch-fs.js'

const IGNORED_SUFFIXES = ['~']

/**
 * True for a path the ignore filter drops. Every project dir is watched
 * RECURSIVELY, so without this a `bun install` would re-run the graph on every
 * file it writes, and vx's own `.vx/cache` writes would trigger a cycle that
 * writes to `.vx/cache` again.
 *
 * Segment-wise, not prefix-wise: `node_modules` is ignored wherever it appears
 * in the path, not only at the root.
 */
export function isIgnoredWatchPath(rel: string): boolean {
  const segments = rel.split(path.sep)
  for (let i = 1; i <= segments.length; i++) if (isIgnoredDir(segments.slice(0, i))) return true
  if (IGNORED_SUFFIXES.some((suf) => rel.endsWith(suf))) return true
  const last = segments.length - 1
  // The cache's first save writes `.vx/.gitignore`, which ignores only the
  // `.vx/cache` and `.vx/tmp` already skipped: a watched root project ran
  // one more cycle for it.
  if (segments[last] === '.gitignore' && segments[last - 1] === '.vx') return true
  // `vx lock`'s review copy: no input, so a re-lock is no cycle.
  return segments[last] === 'vx.lock.json'
}

/**
 * The ignore predicate a watcher applies, closed over the run's ACTUAL cache
 * directory.
 *
 * `isIgnoredDir` covers the `.vx/cache` default, but `cacheDir` is a
 * shipped `defineWorkspace` field: point it anywhere else and vx's own cache
 * writes land in a watched subtree, so every cycle triggers the next one.
 * Measured on a relocated cache under a recursive root watcher: ONE edit kicked
 * it and the loop then ran **22 more times during 6 seconds of total silence**
 * (~3.7 re-runs/second, forever) where the default `.vx` cache settles at 0.
 * A hard-coded literal cannot see a configured path — the resolved one can.
 */
export function makeWatchIgnore(
  cacheDir: string,
  outputs: ReadonlyMap<string, readonly string[]> = new Map(),
  inputs: ReadonlyMap<string, ReadonlyArray<readonly string[]>> = new Map(),
  /** What git tracked at the arm (`gitFiles`): never an output, so an edit there is one. */
  tracked?: ReadonlySet<string>,
): (base: string, filename: string) => boolean {
  // Watchers report under the real root; a cache dir named through a link
  // (`VX_CACHE_DIR`, macOS `/var` -> `/private/var`) is matched as its target.
  const cacheAbs = realThrough(path.resolve(cacheDir))
  // A task's own outputs are not edits: without this every cycle that
  // writes `dist/` (or `out.txt`) re-runs once more, reporting
  // "up-to-date" for the trouble. Matched under the directory the globs
  // are relative to, whichever watcher delivered the event.
  // The directory that HOLDS an output tree is the task's too: `dist/**`
  // does not match `dist`, and since the clean before a miss prunes an
  // emptied `dist` (2026-09-10) the task re-creates it, which the watcher
  // reports as a change to `dist` itself — a second cycle per edit,
  // reporting "up-to-date". The literal prefix of each glob (`dist` for
  // `dist/**`, `build/out` for `build/out/*.js`; nothing for `*.js`) and
  // every ancestor of it under the dir are output containers.
  // A literal entry means the file or its whole tree — the resolver's own
  // rule (`asTrees`), so the tree's files never count as edits.
  // A `!` entry takes its paths back, so an edit there is an edit (A-44);
  // compiled as a glob it would be `Bun.Glob`'s own negation and hide every
  // other path.
  const declared = [...outputs].map(
    ([dir, globs]) =>
      [
        path.resolve(dir),
        outputMatcher(globs),
        globs.map(outputContainer).filter((c) => c !== ''),
      ] as const,
  )
  // A path some task takes as an INPUT is never an output to ignore, even
  // when another task declares it one: an in-place formatter declaring
  // `src/**` hid every `src` edit from a `build` watched beside it, and no
  // cycle ran (item 946). Each task's inputs are judged on their own, less
  // their `!` entries (its own outputs among them): a turbo() task reading
  // `**/*` took its own `dist/` write for an edit, and every save ran one
  // more "up-to-date" cycle (2026-09-28).
  const read = [...inputs].flatMap(([dir, tasks]) =>
    tasks.map(
      (globs) =>
        [
          path.resolve(dir),
          asTrees(globs.filter((g) => !g.startsWith('!'))).map((g) => taskGlob(g)),
          asTrees(globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1))).map((g) =>
            taskGlob(g),
          ),
          // The directory an own output lives in is the task's too (see below).
          globs
            .filter((g) => g.startsWith('!'))
            .map((g) => outputContainer(g.slice(1)))
            .filter((c) => c !== ''),
        ] as const,
    ),
  )
  const isInput = (abs: string): boolean =>
    read.some(([dir, globs, not, containers]) => {
      if (!abs.startsWith(dir + path.sep)) return false
      const rel = abs
        .slice(dir.length + 1)
        .split(path.sep)
        .join('/')
      if (!globs.some((g) => g.match(rel))) return false
      if (not.some((g) => g.match(rel))) return false
      return !containers.some((c) => c === rel || c.startsWith(`${rel}/`))
    })
  return (base, filename) => {
    if (isIgnoredWatchPath(filename)) return true
    const abs = path.resolve(base, filename)
    if (abs === cacheAbs || abs.startsWith(cacheAbs + path.sep)) return true
    if (isInput(abs)) return false
    // Core never cleans or saves a file git tracks and keys it under the
    // task's own output glob (2026-10-14); a submodule is listed as its
    // gitlink alone, so a path under a tracked one counts.
    if (tracked !== undefined)
      for (let p = abs; p.length > 1; p = path.dirname(p)) {
        if (tracked.has(p)) return false
        if (p === path.dirname(p)) break
      }
    for (const [dir, isOutput, containers] of declared) {
      if (!abs.startsWith(dir + path.sep)) continue
      const rel = abs
        .slice(dir.length + 1)
        .split(path.sep)
        .join('/')
      if (isOutput(rel)) return true
      if (containers.some((c) => c === rel || c.startsWith(`${rel}/`))) return true
    }
    return false
  }
}

/** `p` with its longest existing prefix realpath'd: the cache dir may not exist yet. */
function realThrough(p: string): string {
  try {
    return realPath(p)
  } catch {
    const up = path.dirname(p)
    return up === p ? p : path.join(realThrough(up), path.basename(p))
  }
}

/**
 * The literal directory a glob's matches live under (`''` when the glob
 * starts with a pattern, or negates). A literal entry is a file or its
 * whole tree (schema: literal → tree), so the entry itself is the
 * container; a pattern's is `staticPrefix` — the same rule the sandbox
 * baseline and the deferral gate read.
 */
function outputContainer(raw: string): string {
  const glob = normalizeGlob(raw)
  if (glob.startsWith('!')) return ''
  if (isLiteralPattern(glob)) return glob.replace(/\/+$/, '')
  const prefix = staticPrefix(glob)
  return prefix === '.' || prefix === '/' ? '' : prefix
}

/**
 * The subset of `paths` git ignores, asked once per judgement (one
 * `git check-ignore` per debounce window that has candidates, never per
 * event). A git-ignored path is invisible to every cache key — inputs
 * are tracked + untracked-not-ignored — so a cycle it starts can change
 * nothing, and a task that writes one on every run (a pid file, a
 * timestamped log, `.next/trace`) made the loop re-run itself forever
 * (2026-09-16: 29 cycles in 8 s from one edit). A TRACKED file that
 * matches a pattern is not reported, by git's own rule, so it stays an
 * edit. Outside a repository (exit 128) nothing is ignored, as before.
 */
export function gitIgnored(workspaceRoot: string, paths: readonly string[]): Set<string> {
  const ignored = new Set<string>()
  // `-v -n` answers every path with a record, so on a refusal the count of
  // records says which path git refused: a path inside a submodule ends
  // the batch (exit 128, "is in submodule"), and reading that as nothing
  // ignored let a pid file in the same window start cycles again. The
  // refused path is skipped and the rest asked again; a refusal before
  // any record outside a work tree is git refusing them all.
  // Git refuses a path beyond a symbolic link: its ignored pid file read
  // as an edit and an uncached task re-ran forever. Asked at its real
  // place, answered as given.
  const real = paths.map(gitSpeller(workspaceRoot))
  let from = 0
  let inWorkTree: boolean | undefined
  while (from < paths.length) {
    const rest = real.slice(from)
    let proc: ReturnType<typeof Bun.spawnSync>
    try {
      proc = Bun.spawnSync({
        cmd: [executablePath('git'), 'check-ignore', '-v', '-n', '-z', '--stdin'],
        env: gitEnv(),
        cwd: workspaceRoot,
        stdin: Buffer.from(rest.map((p) => `${p}\0`).join('')),
        stdout: 'pipe',
        stderr: 'ignore',
      })
    } catch {
      // No git on PATH: nothing is ignored, and the loop keeps judging —
      // the initial run already said what vx requires.
      return ignored
    }
    // Each record: source, line, pattern, path. No source: no pattern
    // matched; a `!` pattern: re-included. Either way not ignored.
    const fields = new TextDecoder('utf-8', { ignoreBOM: true }).decode(proc.stdout).split('\0')
    const records = Math.floor(fields.length / 4)
    for (let i = 0; i < records; i++) {
      const [source, , pattern] = fields.slice(i * 4, i * 4 + 4)
      if (source !== '' && !pattern!.startsWith('!')) ignored.add(paths[from + i]!)
    }
    // 0: some ignored; 1: none. Anything else is git refusing.
    if (proc.exitCode === 0 || proc.exitCode === 1) return ignored
    if (records === 0) {
      inWorkTree ??=
        Bun.spawnSync({
          cmd: [executablePath('git'), 'rev-parse', '--is-inside-work-tree'],
          env: gitEnv(),
          cwd: workspaceRoot,
          stdout: 'ignore',
          stderr: 'ignore',
        }).exitCode === 0
      if (!inWorkTree) return ignored
    }
    from += records + 1
  }
  return ignored
}

/**
 * Under the recursive root watcher, the events that can move a key. The
 * watcher hears every write in the workspace; a key can see three kinds
 * of path and no other: a file inside a project's directory (its own
 * `inputs.files`, or its outputs, which the ignore filter drops next), a
 * root file a plugin claims, and a match of a declared
 * `inputs.workspaceFiles` glob. Everything else — a log written at the
 * root, a `coverage/` or `.turbo/` tree, an editor's scratch file — is
 * dropped before the trigger, so it costs no cycle. Before this rule the
 * one Turbo idiom that puts every repo on this watcher
 * (`globalDependencies` → `workspaceFiles`) made `vx watch … > build.log`
 * inside the repo a loop that never settled: each cycle's output grew the
 * log, the log was an event, the event was a cycle. Negated globs are not
 * consulted: a `!` only narrows, and an event it would have excluded costs
 * one cache-hit cycle, which is the wrong direction to be clever in.
 */
export function makeRootEventFilter(
  workspaceRoot: string,
  projectDirs: readonly string[],
  workspaceInputs: readonly string[],
  claimedRootFiles: ReadonlySet<string> = new Set(),
  fenced: (ownDir: string, abs: string) => boolean = () => false,
): (filename: string) => boolean {
  const dirs = projectDirs.map((d) => path.resolve(d))
  // A literal is its tree, as the key resolves it: `shared` matched only
  // the directory's own event and no edit under it ran a cycle (WD-2).
  const globs = asTrees(workspaceInputs.filter((g) => !normalizeGlob(g).startsWith('!'))).map((g) =>
    taskGlob(g),
  )
  return (filename: string): boolean => {
    const rel = filename.split(path.sep).join('/')
    // Exact membership, not a basename match: `nested/pnpm-lock.yaml` and
    // `nested/.vx/workspace.ts` are no root file. The workspace config and
    // a claimed file carry their `.vx/` prefix.
    if (isWorkspaceConfigFile(rel) || claimedRootFiles.has(rel) || rel === '.gitignore') {
      return true
    }
    const abs = path.resolve(workspaceRoot, filename)
    for (const d of dirs)
      if (abs === d || (abs.startsWith(d + path.sep) && !fenced(d, abs))) return true
    for (const g of globs) if (g.match(rel)) return true
    return false
  }
}

/**
 * Whether `abs`, under the project at `ownDir`, lies inside another
 * project nested there: the key's boundary (`computeNestedProjectDirs`)
 * leaves such a file out, so it is no edit of `ownDir`'s. A root project
 * watched its whole tree and ran a cycle for every edit in a nested one
 * (X-42). The fences are every project, config or not, as the key's are
 * (X-57). The fence's own config is let through: it may give the project
 * tasks, and the cycle it starts re-reads the set.
 */
export function makeFence(fenceDirs: readonly string[]): (ownDir: string, abs: string) => boolean {
  const fences = fenceDirs.map((d) => path.resolve(d))
  return (ownDir, abs) => {
    const config = PROJECT_CONFIGS.has(path.basename(abs)) ? path.dirname(abs) : undefined
    return fences.some(
      (f) => f !== config && f.startsWith(ownDir + path.sep) && abs.startsWith(f + path.sep),
    )
  }
}

/**
 * A file whose edit can change what the loop watches: a project config (a
 * task that starts declaring `workspaceFiles` needs the root watcher, a
 * new output must stop being an event) or the workspace config (a
 * plugin's `project` stage). Until item 891 each of these waited for a
 * restart while the loop looked alive. The lock and a file a plugin
 * claims re-read the set as well (the caller asks: the projects come from
 * the lock, a lockfile plugin's `discover` names and edges from its file).
 */
const PROJECT_CONFIGS: ReadonlySet<string> = new Set(PROJECT_CONFIG_FILENAMES)

/** A project's own config file, by name: a run reads it only through the lock. */
export function isProjectConfigFile(filename: string): boolean {
  return PROJECT_CONFIGS.has(path.basename(filename))
}

export function shapesWatchedSet(filename: string): boolean {
  const base = path.basename(filename)
  return PROJECT_CONFIGS.has(base) || isWorkspaceConfigFile(filename.split(path.sep).join('/'))
}

/**
 * The workspace config is the one root file that shapes a run without
 * being any task's input — its plugins, `config` stage, concurrency, cache
 * dir — and a cycle re-evaluates it (its import is keyed on its bytes).
 * Until 2026-09-10 neither root arm listened for it: a plugin added under
 * `vx watch` waited for a restart while the loop looked alive.
 */
const WORKSPACE_CONFIGS: ReadonlySet<string> = new Set(WORKSPACE_CONFIG_FILENAMES)

export function isWorkspaceConfigFile(name: string): boolean {
  return WORKSPACE_CONFIGS.has(name)
}

/**
 * Paths as git spells them under `root`: a project reached through a
 * symlink below the root (`packages/x -> ../shared/x`) is watched at the
 * link, and git names and answers for its files only at the real place.
 * The root keeps its own spelling (macOS's `/var` is `/private/var`), the
 * name its own (the file may be gone); a directory outside the root is
 * kept as given. Directories are resolved once per speller.
 */
export function gitSpeller(root: string): (p: string) => string {
  const dirs = new Map<string, string>()
  let realRoot: string | undefined
  return (p) => {
    const dir = path.dirname(p)
    let at = dirs.get(dir)
    if (at === undefined) {
      at = dir
      try {
        realRoot ??= realPath(root)
        const rel = path.relative(realRoot, realPath(dir))
        if (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
          at = path.join(root, rel)
        }
      } catch {}
      dirs.set(dir, at)
    }
    return path.join(at, path.basename(p))
  }
}

/**
 * The files under the workspace git lists, tracked and untracked, ignored
 * ones aside, and every directory above one (git lists no directory, and
 * a project moved away whole is one event on its directory): what existed
 * when watch armed, so a path born and gone since is told from a deletion
 * (watch-judge.ts). `tracked` is the files git tracks: a user edits those,
 * so a server cannot be blamed for one. `links` is the symlinks among the
 * files: a key reads what each points to (cache/linked-inputs.ts), so watch
 * arms that too. Undefined when git cannot answer:
 * no inventory, every gone path is a deletion as before.
 */
export function gitFiles(
  workspaceRoot: string,
): { listed: Set<string>; tracked: Set<string>; links: Set<string> } | undefined {
  let proc: ReturnType<typeof Bun.spawnSync>
  try {
    proc = Bun.spawnSync({
      cmd: [
        executablePath('git'),
        'ls-files',
        '-z',
        '-t',
        '-s',
        '--cached',
        '--others',
        '--exclude-standard',
      ],
      env: gitEnv(),
      cwd: workspaceRoot,
      stdout: 'pipe',
      stderr: 'ignore',
    })
  } catch {
    return undefined
  }
  if (proc.exitCode !== 0) return undefined
  const files = new Set<string>()
  const tracked = new Set<string>()
  const links = new Set<string>()
  for (const entry of new TextDecoder('utf-8', { ignoreBOM: true })
    .decode(proc.stdout)
    .split('\0')) {
    if (entry.length === 0) continue
    // `-t` prefixes a tag and a space; `?` is untracked, a bare path. A
    // tracked entry is `-s`'s `<mode> <oid> <stage>\t<path>` after the tag.
    const untracked = entry[0] === '?'
    const p = untracked ? entry.slice(2) : entry.slice(entry.indexOf('\t') + 1)
    // An untracked nested repository is listed as `dir/`.
    let abs = path.join(workspaceRoot, p.endsWith('/') ? p.slice(0, -1) : p)
    files.add(abs)
    if (!untracked) tracked.add(abs)
    if (untracked ? isLink(abs) : entry.startsWith('120000 ', 2)) links.add(abs)
    for (abs = path.dirname(abs); abs !== workspaceRoot && !files.has(abs); abs = path.dirname(abs))
      files.add(abs)
  }
  return { listed: files, tracked, links }
}

function isLink(abs: string): boolean {
  try {
    return fs.lstatSync(abs).isSymbolicLink()
  } catch {
    return false
  }
}
