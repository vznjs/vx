// A task's shell, started before the task is asked for. A slot that frees
// on a cold run starts its next task at once, and sh's own exec was part of
// that turn: 200 `sleep 0.02` took 4.4 ms each past their sleep spawned
// fresh, 2.7 ms in a shell already waiting (2026-11-01). The spare holds
// no task's directory or env: it waits on a pipe, and the task's script,
// written when it is taken, moves it to the task's directory and exports
// the task's env before the command runs, so each task still has a shell
// of its own (its CPU and memory are the shell's) and vx keeps no process
// beyond a run. Linux only, where a task's pipes are vx's own descriptors.

import { closeSync, writeSync } from 'node:fs'
import { taskShell } from '../util/index.js'
import { guardLine, spawnGuarded } from './kill-tree.js'
import { heldPipe, TaskPipes } from './pipes.js'
import { type OffChild, spawnOff } from './spawn-off.js'

/** A shell waiting for its task's script on descriptor 3. */
export interface Spare {
  readonly child: Promise<OffChild>
  readonly pipes: TaskPipes
  /** The write end of the script's pipe; closed once the script is in. */
  readonly script: number
}

/**
 * Spares kept waiting. Two: a cold run's slots free one at a time, and a
 * burst (the run's first tasks) spawns fresh while the pool fills.
 */
const SPARES = 2

const spares: Spare[] = []
/** A spare that could not start (no libc pipes, a refused spawn): no more are tried. */
let off = false

// `exec 3<&-` first: dash reads the script through its own descriptor,
// opened on /dev/fd/3 and closed on exec, so the task inherits no 3.
const WAIT = '. /dev/fd/3'

function start(): Spare | undefined {
  const fds = heldPipe()
  if (fds === undefined) return undefined
  let cmd: (guard: number | undefined) => string[]
  try {
    const sh = taskShell()
    cmd = (guard) => [sh, '-c', (guard === undefined ? '' : guardLine(4)) + WAIT]
  } catch {
    // No shell on vx's PATH: the task's own spawn says so.
    closeSync(fds[0]!)
    closeSync(fds[1]!)
    return undefined
  }
  const pipes = new TaskPipes()
  const child = spawnGuarded((guard) =>
    spawnOff({
      cmd: cmd(guard),
      argv0: 'sh',
      cwd: '/',
      env: {},
      detached: true,
      held: false,
      stdio: [
        'ignore',
        ...(pipes.stdio as [number, number]),
        fds[0]!,
        ...(guard === undefined ? [] : [guard]),
      ],
    }),
  )
  const settled = child.finally(() => {
    pipes.spawned()
    closeSync(fds[0]!)
  })
  settled.catch(() => {
    off = true
    pipes.close()
    closeSync(fds[1]!)
  })
  return { child: settled, pipes, script: fds[1]! }
}

/** A spare for the next task, or undefined; starts another in its place. */
export function takeSpare(): Spare | undefined {
  const taken = spares.shift()
  while (!off && spares.length < SPARES) {
    const s = start()
    if (s === undefined) {
      off = true
      break
    }
    spares.push(s)
  }
  return taken
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const quote = (v: string): string => `'${v.replaceAll("'", "'\\''")}'`

/**
 * The script a spare runs as the task: its directory (127 when it is gone,
 * as a spawn into it fails; the OLDPWD `cd` sets is not the task's), its
 * env, then `command`. Undefined when an env
 * name is one sh cannot export: that task spawns fresh.
 */
export function spareScript(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  command: string,
): string | undefined {
  // A script past what one pipe write lands whole would hold vx's thread.
  if (command.length > SCRIPT_BYTES) return undefined
  let out = `exec 3<&-\ncd -- ${quote(cwd)} 2>/dev/null || exit 127\nunset OLDPWD\n`
  for (const k in env) {
    const v = env[k]
    // Undefined unsets the name: a spawn drops it.
    if (v === undefined) continue
    if (!NAME.test(k)) return undefined
    out += `export ${k}=${quote(v)}\n`
  }
  out += `${command}\n`
  return Buffer.byteLength(out) > SCRIPT_BYTES ? undefined : out
}

/** A pipe holds 64 KiB: a script under it is written without waiting on the shell's read. */
const SCRIPT_BYTES = 60 * 1024

/**
 * Hand `spare` its script. False when the spare is gone (killed, or its
 * spawn refused): the task then spawns fresh.
 */
export async function runOnSpare(spare: Spare, script: string): Promise<OffChild | undefined> {
  let child: OffChild
  try {
    child = await spare.child
  } catch {
    return undefined
  }
  try {
    writeSync(spare.script, script)
  } catch {
    child.kill('SIGKILL')
    return undefined
  } finally {
    closeSync(spare.script)
  }
  child.hold()
  return child
}
