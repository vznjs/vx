// A Linux task's peak is its own, not vx's (docs/design/peak-memory-exact-2026-11.md).
// Bun spawns with vfork, and at exec the kernel keeps the parent's memory
// mark in the child's maxrss, so the wait of a shell vx spawned read at least
// vx's size: a task lighter than vx reported no peak (`report/memory`, a
// 64 MB dd under a 69 MB vx). The shell is now a fork of `vx-measure`, one
// small process per vx, which reads its true peak; the rows below hold the peak, and hold the exit
// status, the session and group, and the kill of what it left, to what a
// shell vx spawned itself gave.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { ownRssHighWater, runCommand } from '../src/exec/runner.js'
import { measureHelper } from '../src/exec/measure-helper.js'
import * as spawnOffModule from '../src/exec/spawn-off.js'
import { primeSpares } from '../src/exec/warm-shell.js'
import { isAlive, killIfAlive, waitForDead } from './helpers/alive.js'

const MB = 1024 * 1024
const env = { PATH: process.env.PATH ?? '' }
const linux = process.platform === 'linux'

let cwd: string
// This process held well above the task's peak: the mark a vforked shell
// inherits, and under which the old floor dropped the task's own.
let hold: Uint8Array | undefined
beforeAll(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'vx-peak-exact-'))
  hold = new Uint8Array(160 * MB).fill(1)
})
afterAll(async () => {
  hold = undefined
  await rm(cwd, { recursive: true, force: true })
})

describe.skipIf(!linux)('a task lighter than vx reports its own peak', () => {
  it('the helper runs here', async () => {
    // A skip is a silent pass: the rows below need the helper.
    expect(await measureHelper()).toBeString()
  })

  // Fresh, then on a spare (the first run starts the spares; the next take
  // one), a program exec'd by the shell and one it forks.
  for (const command of [
    'dd if=/dev/zero of=/dev/null bs=32M count=1 2>/dev/null',
    'dd if=/dev/zero of=/dev/null bs=32M count=1 2>/dev/null; true',
  ]) {
    it(`a 32 MB peak reads 32 MB under a 160 MB vx: ${command}`, async () => {
      expect(hold![5]).toBe(1)
      for (let run = 0; run < 3; run++) {
        const r = await runCommand({ command, cwd, env })
        expect(r.exitCode).toBe(0)
        // The positive first: the old floor (vx's own mark) is above the
        // task's peak, so a reading near the task's is not vx's.
        expect(ownRssHighWater()).toBeGreaterThan(150 * MB)
        expect(r.peakRssBytes).toBeGreaterThanOrEqual(32 * MB)
        // dd's 32 MB buffer, its image and the shell's: far under vx's mark.
        expect(r.peakRssBytes!).toBeLessThan(48 * MB)
      }
    })
  }

  it('every ready shell of a primed wave is a fork of the helper, with its own peak', async () => {
    primeSpares(6)
    await runCommand({ command: 'true', cwd, env })
    // The pool's refill has spawned: the wave below only takes ready shells.
    await new Promise((r) => setTimeout(r, 300))
    const spy = spyOn(spawnOffModule, 'spawnOff')
    try {
      const wave = await Promise.all(
        Array.from({ length: 6 }, () => runCommand({ command: 'cat /proc/$PPID/comm', cwd, env })),
      )
      // No task spawned its own shell: the only spawns are the pool's refills.
      expect(spy.mock.calls.filter(([o]) => o.cmd.join(' ').includes('comm'))).toEqual([])
      for (const r of wave) {
        expect(r.stdout).toStartWith('vx-measure')
        expect(r.peakRssBytes).toBeGreaterThan(0)
        expect(r.peakRssBytes!).toBeLessThan(16 * MB)
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('a builtin-only task reports the shell’s own few megabytes', async () => {
    const r = await runCommand({ command: 'true', cwd, env })
    expect(r.exitCode).toBe(0)
    expect(r.peakRssBytes).toBeGreaterThan(0)
    expect(r.peakRssBytes!).toBeLessThan(16 * MB)
  })
})

/** What `sh -c` itself ends with, spawned as vx spawned it before. */
async function bare(
  command: string,
): Promise<{ exitCode: number | null; signal: string | number | null }> {
  const p = Bun.spawn(['sh', '-c', command], {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  await p.exited
  return { exitCode: p.exitCode, signal: p.signalCode }
}

describe('the shell ends as `sh -c` does', () => {
  for (const command of [
    'true',
    'exit 7',
    'exit 255',
    'exec false',
    'kill -TERM $$',
    'kill -KILL $$',
    'kill -INT $$',
    'kill -USR2 $$',
    'sh -c "kill -TERM \\$\\$"; exit $?',
    'exec sh -c "exit 42"',
  ]) {
    it(command, async () => {
      // Two runs: the first spawns fresh, the second takes a spare.
      for (let run = 0; run < 2; run++) {
        const r = await runCommand({ command, cwd, env })
        const want = await bare(command)
        expect({
          exitCode: r.signal === undefined ? r.exitCode : null,
          signal: r.signal ?? null,
        }).toEqual(want)
      }
    })
  }
})

describe.skipIf(!linux)('the task keeps its own session and group', () => {
  it('the shell leads both, as Bun’s detached spawn made it', async () => {
    // `<pid> (<comm>) <state> <ppid> <pgrp> <session>`: from the last ')'.
    const command =
      'read -r s < /proc/$$/stat; s=${s##*) }; set -- $s; [ "$3" = $$ ] && [ "$4" = $$ ] && echo leader'
    for (let run = 0; run < 2; run++) {
      const r = await runCommand({ command, cwd, env })
      expect({ exitCode: r.exitCode, stdout: r.stdout }).toEqual({
        exitCode: 0,
        stdout: 'leader\n',
      })
    }
  })

  it('a timeout still kills what the task backgrounded', async () => {
    const marker = path.join(cwd, 'bg.pid')
    const r = await runCommand({
      command: `sleep 60 & echo $! > ${marker}; wait`,
      cwd,
      env,
      timeoutMs: 1500,
    })
    expect(r.timedOut).toBe(true)
    const pid = Number(await readFile(marker, 'utf8'))
    expect(pid).toBeGreaterThan(0)
    // Within the kill grace past the timeout's SIGTERM.
    expect(await waitForDead(pid, 10_000)).toBe(true)
  })

  it('what a task leaves running is still seen as a leftover of its group', async () => {
    const marker = path.join(cwd, 'left.pid')
    const r = await runCommand({
      command: `sleep 60 > /dev/null 2>&1 & echo $! > ${marker}`,
      cwd,
      env,
    })
    const pid = Number(readFileSync(marker, 'utf8'))
    try {
      expect(r.exitCode).toBe(0)
      expect(r.leftRunning).toBe(true)
      expect(isAlive(pid)).toBe(true)
    } finally {
      killIfAlive(pid)
    }
  })
})
