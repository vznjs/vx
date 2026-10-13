// A global vx hands off to the project's own (owner, 2026-10-13). Here for
// the compiled binary installed by hand; an npm install's launcher
// (npm-launcher.sh) walks the same way and `exec`s, which Bun cannot. The
// walk runs before anything else loads, through `Bun.file(…).exists()`:
// importing `node:fs` alone was ~1.1 ms of a 4 ms start (2026-10-13).

/**
 * The project-local vx to run instead of this one, or null: the first
 * `node_modules/@vzn/vx` from `cwd` up to the git root (a `.git` stops the
 * walk after its own level), run through its `.bin/vx`. Null once handed
 * off (one hop), for a vx that is not a standalone compiled binary (source;
 * an npm install, whose launcher already walked), and when the local one is
 * this binary.
 */
export async function localVx(
  cwd: string,
  execPath: string,
  compiled: boolean,
): Promise<string | null> {
  if (process.env['VX_HANDED_OFF'] !== undefined || !compiled) return null
  if (execPath.includes('/node_modules/')) return null
  for (let d = cwd; d !== ''; d = d.slice(0, d.lastIndexOf('/'))) {
    // A file each: `exists()` is false for a directory.
    if (await Bun.file(`${d}/node_modules/@vzn/vx/package.json`).exists()) {
      const bin = `${d}/node_modules/.bin/vx`
      const { realpathSync } = await import('node:fs')
      try {
        return realpathSync(bin) === realpathSync(execPath) ? null : bin
      } catch {
        return null
      }
    }
    // `.git` is a directory in a clone, a file in a worktree or submodule.
    if ((await Bun.file(`${d}/.git/HEAD`).exists()) || (await Bun.file(`${d}/.git`).exists())) {
      return null
    }
  }
  return null
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
  const { constants } = await import('node:os')
  process.exit(child.signalCode === null ? code : 128 + (constants.signals[child.signalCode] ?? 1))
}

function inForeground(): boolean {
  try {
    const stat = Bun.spawnSync(['ps', '-o', 'pgid=,tpgid=', '-p', String(process.pid)])
    const [pgid, tpgid] = stat.stdout.toString().trim().split(/\s+/)
    return pgid !== undefined && pgid === tpgid
  } catch {
    return false
  }
}
