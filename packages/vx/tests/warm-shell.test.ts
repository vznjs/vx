import { mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { runCommand } from '../src/exec/runner.js'
import * as spawnOffModule from '../src/exec/spawn-off.js'
import { spareScript } from '../src/exec/warm-shell.js'

const linux = process.platform === 'linux'

// A task's shell is started before the task is asked for, so the slot that
// frees does not wait for sh to exec: 4.4 → 2.7 ms of each task's time
// past its own work (200 `sleep 0.02`, 2026-11-01).
describe.skipIf(!linux)('a task runs in a shell started before it', () => {
  let cwd: string
  const env = { PATH: process.env.PATH ?? '', VX_W: "it's a\nvalue $HOME" }
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-warm-'))
    // The pool's first spare, started by this call.
    await runCommand({ command: 'true', cwd, env })
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('spawns no shell for the task it runs', async () => {
    const spy = spyOn(spawnOffModule, 'spawnOff')
    try {
      const res = await runCommand({ command: 'echo warm-out; exit 3', cwd, env })
      expect(res.exitCode).toBe(3)
      expect(res.stdout).toBe('warm-out\n')
      expect(spy.mock.calls.some(([o]) => o.cmd.join(' ').includes('warm-out'))).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('hands the task the env, directory and descriptors a fresh shell would', async () => {
    const probe = 'env | sort; pwd; ls /proc/self/fd; echo $0'
    const warm = await runCommand({ command: probe, cwd, env })
    // An env name sh cannot export keeps a task off the spare: it spawns.
    const spy = spyOn(spawnOffModule, 'spawnOff')
    try {
      const fresh = await runCommand({ command: probe, cwd, env: { ...env, 'A-B': '1' } })
      expect(warm.stdout).toBe(fresh.stdout)
      expect(spy.mock.calls.some(([o]) => o.cmd.join(' ').includes(probe))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  // sh sets these itself at start, whatever its env says (IFS, OPTIND,
  // PPID) or keeps PWD only when it names the directory; the spare is
  // already started, so exporting them changed what the command saw.
  it('gives a name sh sets at its start the value a fresh shell gives it', async () => {
    const probe =
      'X=a:b; for w in $X; do echo "[$w]"; done; echo "$PWD $OPTIND $PPID"; env | grep -E "^(IFS|OPTIND|PPID|PWD)=" | sort'
    const shellSet = { ...env, IFS: ':', PWD: '/etc', OPTIND: '5', PPID: '7' }
    const warm = await runCommand({ command: probe, cwd, env: shellSet })
    const fresh = await runCommand({ command: probe, cwd, env: { ...shellSet, 'A-B': '1' } })
    expect(warm.stdout).toBe(fresh.stdout)
    expect(warm.stdout).toStartWith('[a:b]\n')
  })

  // A fresh shell's PWD is the directory's physical path; `cd` alone kept
  // the spelling it was given.
  it('reads a directory reached through a link as a fresh shell does', async () => {
    const link = `${cwd}-link`
    await symlink(cwd, link)
    try {
      const warm = await runCommand({ command: 'pwd; echo "$PWD"', cwd: link, env })
      const fresh = await runCommand({
        command: 'pwd; echo "$PWD"',
        cwd: link,
        env: { ...env, 'A-B': '1' },
      })
      expect(warm.stdout).toBe(fresh.stdout)
    } finally {
      await rm(link, { force: true })
    }
  })

  // The script's own lines came before the command, one per env name, so
  // sh's "not found" named line 3 + that count: the same task printed a
  // different line as its env grew. The builtin the spare runs it through
  // still names itself (`eval:`): only an exec would drop it.
  it("numbers the command's lines as a fresh shell does, whatever its env", async () => {
    const many = { ...env, VX_A: '1', VX_B: '2', VX_C: '3' }
    const warm = await runCommand({ command: 'true\nvx_no_such_cmd', cwd, env: many })
    const fresh = await runCommand({
      command: 'true\nvx_no_such_cmd',
      cwd,
      env: { ...many, 'A-B': '1' },
    })
    expect(fresh.stderr).toBe('sh: 2: vx_no_such_cmd: not found\n')
    expect(warm.stderr).toBe('sh: 2: eval: vx_no_such_cmd: not found\n')
  })

  // A distro's sh may be bash, which counts SHLVL up and dies assigning
  // its read-only names: the script must read as `sh -c` under either.
  it.each(['dash', 'bash'].filter((s) => Bun.which(s) !== null))(
    'runs a script %s reads as a fresh sh -c',
    (shell) => {
      const probe = 'echo "$SHLVL $SHELLOPTS $BASHOPTS $UID $EUID $PPID [$IFS] $PWD $OPTIND"'
      const names = [
        'SHLVL',
        'SHELLOPTS',
        'BASHOPTS',
        'UID',
        'EUID',
        'PPID',
        'IFS',
        'PWD',
        'OPTIND',
      ]
      for (const name of names) {
        const taskEnv = { PATH: env.PATH, [name]: name === 'IFS' ? ':' : '7' }
        const script = spareScript('/', taskEnv, probe)
        // Undefined: the task spawns fresh, as `sh -c`.
        if (script === undefined) continue
        const run = (cmd: string, e: Record<string, string>): string => {
          const r = Bun.spawnSync([Bun.which(shell)!, '-c', cmd], { argv0: 'sh', cwd: '/', env: e })
          return r.stdout.toString() + r.stderr.toString()
        }
        expect(run(script, {})).toBe(run(probe, taskEnv))
      }
    },
  )

  // A run's env holds `undefined` for a name it unsets; a spawn drops it.
  it('leaves a name the env holds as undefined unset, as a spawn does', async () => {
    const res = await runCommand({
      command: 'echo "${VX_GONE-unset}"',
      cwd,
      env: { ...env, VX_GONE: undefined } as unknown as Record<string, string>,
    })
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe('unset\n')
  })

  it('fails a task whose directory is gone as a spawn that threw', async () => {
    const res = await runCommand({ command: 'true', cwd: path.join(cwd, 'gone'), env })
    expect(res.spawnFailed).toBe(true)
    expect(res.exitCode).toBe(127)
    expect(res.stderr).toContain('does not exist')
  })
})
