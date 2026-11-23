// The vx CLI in a child process as a user drives it: through vx-locked.ts
// (a run reads configs only from the lock, so the verb locks first), plain
// (no colour) and off CI, since CI and GITHUB_ACTIONS change the output
// flow and the cache policy and the runner sets them. `env` adds to or
// overrides that; an `undefined` value drops the variable.
import path from 'node:path'

/** `src/bin.ts`, the CLI itself, for a test of what it does with no lock or a stale one. */
export const BIN = path.resolve(import.meta.dir, '..', '..', 'src', 'bin.ts')
const LOCKED_BIN = path.resolve(import.meta.dir, 'vx-locked.ts')

export interface VxOptions {
  env?: Record<string, string | undefined>
  /** The entry to run (default: vx-locked.ts). */
  bin?: string | undefined
}

export interface VxResult {
  code: number
  out: string
  err: string
  /** `out` then `err`. */
  text: string
}

function spec(cwd: string, args: readonly string[], o: VxOptions) {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries({
    ...process.env,
    NO_COLOR: '1',
    CI: '',
    GITHUB_ACTIONS: '',
    ...o.env,
  }))
    if (v !== undefined) env[k] = v
  return {
    cmd: [process.execPath, o.bin ?? LOCKED_BIN, ...args],
    cwd,
    env,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
  }
}

export async function vx(
  cwd: string,
  args: readonly string[],
  o: VxOptions = {},
): Promise<VxResult> {
  const proc = Bun.spawn(spec(cwd, args, o))
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err, text: out + err }
}

export function vxSync(cwd: string, args: readonly string[], o: VxOptions = {}): VxResult {
  const p = Bun.spawnSync(spec(cwd, args, o))
  const out = p.stdout.toString()
  const err = p.stderr.toString()
  return { code: p.exitCode, out, err, text: out + err }
}
