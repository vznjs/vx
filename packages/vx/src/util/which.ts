// A spawn of a bare name walks PATH with a stat per entry — `sh` for every
// task, `git` for every git call: 200 tasks paid ~2,000 stats on a 100-package
// workspace for the same answer each time. The walk is done here once and
// the spawn is handed the absolute path.
//
// The PATH walked is vx's OWN, never a task's. A task's PATH starts with its
// project's and the workspace's `node_modules/.bin`, and `exec.env.define`
// may set it outright; the shell that parses the command and the git that
// enumerates the inputs are the machine's tools, not the task's, so a
// dependency that ships a `sh` bin must not become the interpreter of every
// command in its project. The task's PATH still decides what the COMMAND
// resolves, inside that shell.
//
// Memoized per PATH value rather than for the process's life: nothing in vx
// changes PATH mid-run, so a run pays one walk, and a process whose PATH does
// change (an embedder, a test) is answered for the PATH it has. A miss is
// not remembered: it ends the spawn that asked, and a long-lived process
// (`vx watch`) finds the tool once the user installs it.

let memoPath: string | undefined
const found = new Map<string, string>()

/**
 * `name`'s absolute path on vx's own PATH. Throws Bun's own shape for a
 * spawn that could not run (`code: 'ENOENT'`) when it is not there, so a
 * call inside a spawn site's `try` reaches the same `isExecutableMissing`
 * refusal the spawn's throw did.
 */
export function executablePath(name: string): string {
  const PATH = process.env['PATH'] ?? ''
  if (PATH !== memoPath) {
    found.clear()
    memoPath = PATH
  }
  const hit = found.get(name)
  if (hit !== undefined) return hit
  const at = Bun.which(name, { PATH })
  if (at === null) {
    throw Object.assign(new Error(`Executable not found in $PATH: "${name}"`), {
      code: 'ENOENT',
      path: name,
    })
  }
  // Absolute even for a relative PATH entry (Bun.which resolves it against
  // this process's cwd), so it holds in whatever cwd the spawn is given.
  found.set(name, at)
  return at
}

let dashMissedOn: string | undefined

/**
 * The shell vx runs commands in: `dash` on macOS when vx's PATH has it,
 * else `sh` on vx's PATH. macOS's `/bin/sh` is a stub that execs bash, two
 * images for one shell, and bash where Linux runs dash, so a command read
 * one way on a Mac and another on Linux CI (owner, 2026-10-04).
 */
export function taskShell(): string {
  if (process.platform === 'darwin') {
    const PATH = process.env['PATH'] ?? ''
    if (dashMissedOn !== PATH) {
      try {
        return executablePath('dash')
      } catch {
        dashMissedOn = PATH
      }
    }
  }
  return executablePath('sh')
}

/**
 * The argv that runs `script` in the task shell: `sh -c`.
 */
export function shellArgv(script: string): string[] {
  return [taskShell(), '-c', script]
}
