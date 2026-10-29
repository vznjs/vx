// A global vx hands off to the project's own (2026-10-13), found
// from the workspace root, the one lookup every verb shares. Here for
// the compiled binary installed by hand; an npm install's launcher
// (npm-launcher.sh) walks the same way and `exec`s, which Bun cannot. The
// walk runs before anything else loads, through `Bun.file(…).exists()`:
// importing `node:fs` alone was ~1.1 ms of a 4 ms start (2026-10-13).

/** `vx upgrade -g`: moves only the global vx, so it never hands off (2026-10-16). */
export function upgradesOnlyItself(argv: readonly string[]): boolean {
  return argv[0] === 'upgrade' && argv.some((a) => a === '-g' || a === '--global')
}

/**
 * The project-local vx to run instead of this one, or null: the workspace
 * root's ({@link workspaceFile}) `node_modules/@vzn/vx`, run through its
 * `.bin/vx`. Null once handed
 * off (one hop), for a vx that is not a standalone compiled binary (source;
 * an npm install, whose launcher already walked), outside a workspace,
 * when the local one is this binary, and when another user owns it.
 */
export async function localVx(
  cwd: string,
  execPath: string,
  compiled: boolean,
  uid = process.getuid?.(),
): Promise<string | null> {
  // Empty is unset, as the launcher's `[ -z "${VX_HANDED_OFF-}" ]` reads it.
  if (process.env['VX_HANDED_OFF'] || !compiled) return null
  if (execPath.includes('/node_modules/')) return null
  const file = await workspaceFile(cwd)
  if (file === null) return null
  const root = workspaceRootOf(file)
  if (!(await Bun.file(`${root}/node_modules/@vzn/vx/package.json`).exists())) return null
  const bin = `${root}/node_modules/.bin/vx`
  const { realpathSync, statSync } = await import('node:fs')
  try {
    const real = realpathSync(bin)
    // One another user planted would run as you.
    if (statSync(real).uid !== uid) return null
    return real === realpathSync(execPath) ? null : bin
  } catch {
    return null
  }
}

/**
 * The workspace config's paths under the root, in lookup order: one marks
 * the workspace root, the directory holding its `.vx` (2026-10-14).
 */
export const WORKSPACE_CONFIG_FILENAMES = [
  '.vx/workspace.ts',
  '.vx/workspace.mts',
  '.vx/workspace.js',
  '.vx/workspace.mjs',
  // A CommonJS config (`module.exports = …`), as Vite and TS name theirs: it
  // was ignored without a word (D-86).
  '.vx/workspace.cts',
  '.vx/workspace.cjs',
]

/** The workspace root a workspace config marks: the directory above its `.vx`. */
export function workspaceRootOf(file: string): string {
  return file.slice(0, file.lastIndexOf('/.vx/')) || '/'
}

const files = new Map<string, Promise<string | null>>()

/**
 * The workspace config that marks the root for `dir`: the first
 * `.vx/workspace.*` from `dir` up to the git top-level ({@link gitTop}),
 * inclusive, or to `/` outside git (2026-10-13: "Workspace file is
 * the ultimate" and "never go out of git root"). Null when there is none.
 * Learned once per directory per run: the hand-off and the workspace root
 * share it (principle 9).
 */
export function workspaceFile(dir: string): Promise<string | null> {
  let file = files.get(dir)
  if (file === undefined) {
    file = findWorkspaceFile(dir)
    files.set(dir, file)
  }
  return file
}

/** vx wrote a workspace config (`vx init`): what was learned before it is stale. */
export function workspaceFileWritten(): void {
  files.clear()
}

async function findWorkspaceFile(start: string): Promise<string | null> {
  let top = await gitTop(start)
  const passed: string[] = []
  let found: string | null = null
  walk: for (let d = start; ; d = d.slice(0, d.lastIndexOf('/'))) {
    passed.push(d || '/')
    for (const name of WORKSPACE_CONFIG_FILENAMES) {
      const file = `${d}/${name}`
      if (await Bun.file(file).exists()) {
        found = file
        break walk
      }
    }
    if (d === '') break
    if (d === top) {
      // A submodule whose `.git` is a directory (added from a clone, not
      // absorbed) is a top-level by its files: git alone knows the
      // superproject tracks it. Asked only once the walk found nothing.
      const above = await superproject(d)
      if (above === null) break
      top = await gitTop(above)
    }
  }
  if (found === null && top !== null && top !== '/') found = await outerWorkspaceFile(top)
  // Every directory walked has the same answer: the loader asks for the root's.
  for (const d of passed) if (!files.has(d)) files.set(d, Promise.resolve(found))
  return found
}

/**
 * The workspace config of the repository `top` is embedded in (an untracked
 * clone with its own `.git` directory), when that repository's git does not
 * ignore it: `vx lock` lists such a repository's configs as the outer
 * workspace's, and a run from inside one stopped at its `.git`, "no
 * .vx/workspace.ts". A submodule's walk goes on already ({@link gitTop}).
 * Asked only when the walk found nothing, so a run pays nothing for it.
 */
async function outerWorkspaceFile(top: string): Promise<string | null> {
  // A worktree's `.git` is a file: another checkout, its own top-level.
  if (!(await Bun.file(`${top}/.git/HEAD`).exists())) return null
  const parent = top.slice(0, top.lastIndexOf('/')) || '/'
  const outer = await gitTop(parent)
  if (outer === null) return null
  const file = await workspaceFile(parent)
  if (file === null) return null
  try {
    // Plain `git`, as handoff imports nothing (the hand-off runs first).
    // Exit 1: not ignored, so the outer listing holds it; 0 ignored; 128 an error.
    // `./`: check-ignore reads `:x` as pathspec magic and refuses `:(literal)`.
    const rel = top.slice(outer.length + (outer === '/' ? 0 : 1))
    const p = Bun.spawnSync({
      cmd: ['git', 'check-ignore', '-q', '--', `./${rel}`],
      cwd: outer,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return p.exitCode === 1 ? file : null
  } catch {
    return null
  }
}

const tops = new Map<string, Promise<string | null>>()

/** The working tree of the repository that tracks `top` as a submodule, or null. */
async function superproject(top: string): Promise<string | null> {
  const { executablePath, gitEnv } = await import('./util/index.js')
  try {
    const proc = Bun.spawn({
      cmd: [executablePath('git'), 'rev-parse', '--show-superproject-working-tree'],
      cwd: top,
      env: gitEnv(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    const dir = out.trim()
    return exit === 0 && dir.length > 0 ? dir : null
  } catch {
    // No git: the files are all there is to go by.
    return null
  }
}

/**
 * The git top-level holding `dir`, or null outside git: the nearest `.git`
 * up from it, a directory in a clone, a file in a worktree. A submodule's
 * `.git` file points into its superproject's `.git/modules`, so the walk
 * goes on to the superproject's. Learned once per directory per run: the
 * hand-off and the workspace root walk share it (principle 9).
 */
export function gitTop(dir: string): Promise<string | null> {
  let top = tops.get(dir)
  if (top === undefined) {
    top = findGitTop(dir)
    tops.set(dir, top)
  }
  return top
}

async function findGitTop(start: string): Promise<string | null> {
  for (let d = start; ; d = d.slice(0, d.lastIndexOf('/'))) {
    // A file each: `exists()` is false for a directory.
    if (await Bun.file(`${d}/.git/HEAD`).exists()) return d || '/'
    const file = Bun.file(`${d}/.git`)
    if (await file.exists()) {
      const gitdir = await file.text().catch(() => '')
      if (!/(^|[\s/])\.git\/modules\//.test(gitdir)) return d || '/'
      // A submodule's own worktree points there too, and is a top-level:
      // git writes `commondir` in a worktree's gitdir alone.
      const to = gitdir.replace(/^gitdir:\s*/, '').trim()
      if (await Bun.file(`${to.startsWith('/') ? '' : `${d}/`}${to}/commondir`).exists())
        return d || '/'
    }
    if (d === '') return null
  }
}

/** This vx's own file: the compiled binary, else the source entry Bun runs. */
export function vxPath(): string {
  return Bun.main.startsWith('/$bunfs') ? process.execPath : Bun.main
}

/**
 * Run `bin` with this process's arguments and stdio, and exit as it does.
 * A signal sent to this vx alone (`kill`, a process manager) is passed on;
 * one the terminal sent reached the whole foreground group already, and a
 * second would read as "stop now" (npm-launcher.cjs, the same rule).
 */
export async function handOff(bin: string, args: readonly string[]): Promise<never> {
  const child = Bun.spawn([bin, ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, VX_HANDED_OFF: process.execPath },
  })
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      if (!inForeground()) child.kill(sig)
    })
  }
  const code = await child.exited
  const signal = child.signalCode
  if (signal === null) process.exit(code)
  // Die of a stop signal the local vx died of, as vx itself does: a shell
  // running vx in a script stops on Ctrl-C only when its child died of
  // SIGINT, and an exit 130 ran the script's next line. The code below is
  // the rest, and the fallback should the signal not land.
  if (signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGHUP') {
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
  }
  if (typeof signal === 'number') process.exit(128 + signal)
  const { constants } = await import('node:os')
  process.exit(128 + (constants.signals[signal] ?? 1))
}

function inForeground(): boolean {
  try {
    // The handed-off vx's tasks run meanwhile and could read its env: PATH alone (`helperEnv`).
    const stat = Bun.spawnSync(['ps', '-o', 'pgid=,tpgid=', '-p', String(process.pid)], {
      env: { PATH: process.env['PATH'] ?? '' },
    })
    const [pgid, tpgid] = stat.stdout.toString().trim().split(/\s+/)
    return pgid !== undefined && pgid === tpgid
  } catch {
    return false
  }
}
