// What a worker must have checked out: the tracked files as the run sees
// them. Workers compare trees, not commits, so a run on uncommitted changes
// still matches the worktrees `local()` makes from them.

import { existsSync, lstatSync } from 'node:fs'
import { copyFile, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PROJECT_CONFIG_FILENAMES, UserError } from '@vzn/vx'
import { repoEnv } from './local.js'

/**
 * A commit of the tracked files as they are now (`HEAD`'s when none changed),
 * and its tree; both empty when git cannot say.
 */
export async function snapshot(root: string): Promise<{ commit: string; tree: string }> {
  const none = { commit: '', tree: '' }
  const head = (await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], root))?.trim()
  if (head === undefined || head === '') return none
  // The working tree's tracked files staged into a copy of the index, which
  // leaves the index and the working tree as they are. `git stash create`
  // did the same, but refused an intent-to-add entry (`git add -N`), and
  // HEAD stood in for the changes (2026-10-28).
  const [top, index] =
    (
      await git(
        ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-path', 'index'],
        root,
      )
    )?.split('\n') ?? []
  if (top === undefined || index === undefined) return none
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-index-'))
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') }
    try {
      await copyFile(index, env.GIT_INDEX_FILE)
      // The copy keeps the index's mtime (as core's refreshedIndex): git
      // trusts an entry's stat only while its file is older than the index,
      // and a fresh mtime took a same-size edit made in the tick the index
      // was written for clean, its old blob in the tree (2026-10-29).
      const st = await stat(index)
      await utimes(env.GIT_INDEX_FILE, st.atime, st.mtime)
    } catch {
      // quiet: no index yet, so HEAD's tree is its tracked set.
      if ((await git(['read-tree', head], root, env)) === undefined) return none
    }
    await unflag(top, env)
    // The executable bit as on disk, which core keys from an lstat under
    // `core.fileMode=false` too: there `add -u` staged no `chmod +x`,
    // workers checked the file out 644, and saved what it built under the
    // key of its 755 (2026-11-08).
    if (
      (await git([...UNSPARSE, '-c', 'core.fileMode=true', 'add', '-u', '--', ':/'], root, env)) ===
      undefined
    )
      return none
    const tree = (await git(['write-tree'], root, env))?.trim()
    if (tree === undefined || tree === '') return none
    const was = (await git(['rev-parse', `${head}^{tree}`], root))?.trim()
    if (tree === was) return { commit: head, tree }
    // The commit is nobody's, so it needs no one's identity: a CI runner
    // with none made `git stash create` fail (2026-10-28).
    const commit = (
      await git(['commit-tree', tree, '-p', head, '-m', 'vx dte'], root, IDENTITY)
    )?.trim()
    return commit === undefined || commit === '' ? none : { commit, tree }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Each tracked file a git filter of this machine checked out other than
 * the commit holds it (`text`, `eol`, `ident`, `filter`,
 * `working-tree-encoding`, `core.autocrlf`), written back as the commit's
 * bytes; the paths written. The run keys its disk's bytes and refuses a
 * task that keys a file the commit holds otherwise, so these are the bytes
 * its key read: a worktree that smudged LF to CRLF built CRLF output under
 * the key of the LF file, a stale hit (2026-11-08).
 */
export async function unfilter(root: string): Promise<string[]> {
  const top = (await git(['rev-parse', '--show-toplevel'], root))?.trim()
  if (top === undefined || top === '') return []
  const vars = await git(['var', '-l'], top)
  if (vars === undefined) return []
  const config = varList(vars)
  const every = autocrlf(config)
  // The common repository names no filter: no index read.
  if (!every && !(await attributed(top, config))) return []
  const staged = await git([...UNSPARSE, 'ls-files', '-s', '-z'], top)
  if (staged === undefined) return []
  const blobs = new Map<string, string>()
  for (const e of staged.split('\0')) {
    const m = /^(?:100644|100755) ([0-9a-f]+) 0\t(.*)$/s.exec(e)
    if (m !== null) blobs.set(m[2]!, m[1]!)
  }
  let paths = [...blobs.keys()]
  if (!every) paths = await filtered(top, paths)
  // `--stdin-paths` reads lines; a file off disk (a sparse checkout's) is no checkout.
  paths = paths.filter((p) => !p.includes('\n') && isFile(path.join(top, p)))
  if (paths.length === 0) return []
  const raw = await git(
    ['hash-object', '--no-filters', '--stdin-paths'],
    top,
    undefined,
    paths.join('\n') + '\n',
  )
  if (raw === undefined) return []
  const oids = raw.split('\n')
  const off = paths.filter((p, i) => oids[i] !== blobs.get(p))
  if (off.length === 0) return []
  const p = Bun.spawn(['git', 'cat-file', '--batch'], {
    cwd: top,
    env: repoEnv(top),
    stdin: Buffer.from(off.map((f) => blobs.get(f)).join('\n') + '\n'),
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const [out, code] = await Promise.all([new Response(p.stdout).bytes(), p.exited])
  if (code !== 0) throw new UserError(`vx dte worker: git could not read ${off[0]}'s blob`)
  // Each `<oid> blob <size>\n<bytes>\n`.
  let at = 0
  for (const f of off) {
    const nl = out.indexOf(10, at)
    const size = Number(new TextDecoder().decode(out.subarray(at, nl)).split(' ')[2])
    await writeFile(path.join(top, f), out.subarray(nl + 1, nl + 1 + size))
    at = nl + 1 + size + 1
  }
  return off
}

/** Whether `file` is a regular file on disk. */
function isFile(file: string): boolean {
  try {
    return lstatSync(file).isFile()
  } catch {
    // quiet: off disk is no file
    return false
  }
}

/** `git var -l`'s last value of each name; a bare key (true) has none. */
function varList(vars: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>()
  for (const line of vars.split('\n')) {
    const eq = line.indexOf('=')
    if (eq === -1) out.set(line.toLowerCase(), undefined)
    else out.set(line.slice(0, eq).toLowerCase(), line.slice(eq + 1))
  }
  return out
}

/** Whether `core.autocrlf`, as git reads it, converts line ends. */
function autocrlf(config: Map<string, string | undefined>): boolean {
  if (!config.has('core.autocrlf')) return false
  const v = config.get('core.autocrlf')
  if (v === undefined) return true
  const s = v.trim().toLowerCase()
  if (s === 'input' || s === 'true' || s === 'yes' || s === 'on') return true
  return /^-?\d+$/.test(s) && Number(s) !== 0
}

/**
 * Whether any attributes file may name a filter: a `.gitattributes` in the
 * tree, `$GIT_DIR/info/attributes`, or the global or system one git names
 * (`git var`, from git 2.42; an older git names neither, so any may).
 */
async function attributed(top: string, config: Map<string, string | undefined>): Promise<boolean> {
  if (existsSync(path.join(top, '.gitattributes'))) return true
  const [tracked, info] = await Promise.all([
    git([...UNSPARSE, 'ls-files', '-z', '--', ':(glob)**/.gitattributes'], top),
    git(['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes'], top),
  ])
  if (tracked !== '' || info === undefined || existsSync(info.trim())) return true
  if (!config.has('git_attr_global')) return true
  for (const name of ['git_attr_global', 'git_attr_system']) {
    const f = config.get(name)
    if (f !== undefined && f !== '' && existsSync(f)) return true
  }
  return false
}

/** Of `paths`, those a filter attribute names (set, or given a value). */
async function filtered(top: string, paths: string[]): Promise<string[]> {
  const out = await git(
    ['check-attr', '-z', '--stdin', 'text', 'eol', 'ident', 'filter', 'working-tree-encoding'],
    top,
    undefined,
    paths.join('\0') + '\0',
  )
  if (out === undefined) return paths
  const named = new Set<string>()
  const f = out.split('\0')
  for (let i = 0; i + 2 < f.length; i += 3)
    if (f[i + 2] !== 'unspecified' && f[i + 2] !== 'unset') named.add(f[i]!)
  return paths.filter((p) => named.has(p))
}

/**
 * The workspace config core loads (the first `.vx/workspace.*` under
 * `root`), when `tree` lacks it: every worker started without one failed
 * `unknown command: dte`, and started again three times, before a task
 * said why (2026-11-07).
 */
export async function untrackedWorkspace(root: string, tree: string): Promise<string | undefined> {
  for (const name of WORKSPACE_FILES) {
    if (!(await Bun.file(path.join(root, name)).exists())) continue
    return (await git(['cat-file', '-e', `${tree}:./${name}`], root)) === undefined
      ? name
      : undefined
  }
  return undefined
}

/** Core's names in its order: a project config's extensions. */
const WORKSPACE_FILES = PROJECT_CONFIG_FILENAMES.map((n) => `.vx/workspace${path.extname(n)}`)

/**
 * The copy's assume-unchanged and skip-worktree flags cleared, so `add -u`
 * takes those files from disk: it passed over them, and the tree kept
 * HEAD's blob of a file core's key hashed as edited, a stale hit
 * (2026-11-07). A skip-worktree file off disk (a sparse checkout's) stays
 * flagged: its bytes are the index's, not a deletion.
 */
async function unflag(top: string, env: Record<string, string>): Promise<void> {
  const listed = await git([...UNSPARSE, 'ls-files', '-v', '-z'], top, env)
  if (listed === undefined) return
  const assumed: string[] = []
  const skipped: string[] = []
  for (const entry of listed.split('\0')) {
    const tag = entry[0]
    if (tag === undefined) continue
    const file = entry.slice(2)
    // Lower case is assume-unchanged; S (s: both flags) skip-worktree.
    if (tag !== tag.toUpperCase()) assumed.push(file)
    if ((tag === 'S' || tag === 's') && existsSync(path.join(top, file))) skipped.push(file)
  }
  // One flag a call: given both, update-index clears the first and skips
  // the second.
  for (const [flag, files] of [
    ['--no-assume-unchanged', assumed],
    ['--no-skip-worktree', skipped],
  ] as const) {
    if (files.length === 0) continue
    const p = Bun.spawn(['git', ...UNSPARSE, 'update-index', flag, '-z', '--stdin'], {
      cwd: top,
      stdin: Buffer.from(files.join('\0') + '\0'),
      stdout: 'ignore',
      stderr: 'pipe',
      env: { ...repoEnv(top), ...env },
    })
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited])
    if (code !== 0)
      throw new UserError(
        `dte(): git could not take ${files[0]} (flagged assume-unchanged or skip-worktree) from disk, so workers would run its committed bytes: ${err.trim()}`,
      )
  }
}

// A sparse checkout's patterns kept `add` off a file outside them that is
// on disk all the same, and its index reads clear the flag of such a file
// in memory only, so `ls-files` named it unflagged.
const UNSPARSE = ['-c', 'core.sparseCheckout=false']

const IDENTITY = {
  GIT_AUTHOR_NAME: 'vx',
  GIT_AUTHOR_EMAIL: 'vx@localhost',
  GIT_COMMITTER_NAME: 'vx',
  GIT_COMMITTER_EMAIL: 'vx@localhost',
}

/** git's stdout, or undefined when it failed. */
async function git(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  input?: string,
): Promise<string | undefined> {
  const p = Bun.spawn(['git', ...args], {
    cwd,
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'ignore',
    env: { ...repoEnv(cwd), ...env },
  })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  return code === 0 ? out : undefined
}
