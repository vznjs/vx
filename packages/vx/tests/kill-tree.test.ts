// `exec/kill-tree.ts` unit rows: what reaches the signal channel and what
// the group, and the guards a fake child can drive (a pid of 0, EPERM,
// ESRCH). The /proc read is kill-tree-proc.unsafe.test.ts. The
// end-to-end rows (a timeout, a Ctrl-C, a trap) are task-tree-kill.test.ts
// and the sandbox runtime's own suite.

import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import {
  closeSignalChannel,
  killTree,
  signalThrough,
  untilGroupsGone,
  type Child,
} from '../src/exec/kill-tree.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-kill-tree-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A child that is never spawned: its `kill` and `exited` are what the rows read. */
function fakeChild(pid: number): Child & { signals: string[] } {
  const signals: string[] = []
  return {
    pid,
    signals,
    exited: Promise.resolve(0),
    kill: (signal?: string | number) => void signals.push(String(signal)),
  } as unknown as Child & { signals: string[] }
}

/** `process.kill`, recorded; `answer` decides what each call does. */
let calls: Array<[number, string | number | undefined]> = []
const realKill = process.kill
function stubKill(answer: (pid: number, signal?: string | number) => void): void {
  calls = []
  process.kill = ((pid: number, signal?: string | number) => {
    calls.push([pid, signal])
    answer(pid, signal)
    return true
  }) as typeof process.kill
}
const errno = (code: string) => Object.assign(new Error(code), { code })
afterEach(() => {
  process.kill = realKill
})

describe('killTree', () => {
  it('a polite signal goes down the channel by its bare name, never to the group', () => {
    // The watcher runs `kill -s "$s"`; a POSIX sh (dash) refuses `SIGTERM`
    // there and takes `TERM`, so the name goes without its prefix.
    const file = path.join(dir, 'channel')
    const fd = openSync(file, 'w')
    const child = fakeChild(4_000_000)
    signalThrough(child, fd)
    stubKill(() => {})
    killTree(child, 'SIGTERM')
    killTree(child, 'SIGINT')
    expect(readFileSync(file, 'utf8')).toBe('TERM\nINT\n')
    expect(calls).toEqual([])
    closeSignalChannel(child)
  })

  it('a closed channel is gone: its descriptor is closed, and a later signal goes to the group', () => {
    const child = fakeChild(4_000_001)
    const fd = openSync(path.join(dir, 'closed'), 'w')
    signalThrough(child, fd)
    closeSignalChannel(child)
    expect(() => fstatSync(fd)).toThrow()
    // The lowest free number is the one just closed: a file opened now
    // takes it, and a signal written to the stale entry would land here.
    const reused = path.join(dir, 'reused')
    const again = openSync(reused, 'w')
    try {
      stubKill(() => {})
      killTree(child, 'SIGTERM')
      expect(readFileSync(reused, 'utf8')).toBe('')
      expect(calls).toEqual([[-4_000_001, 'SIGTERM']])
    } finally {
      closeSync(again)
    }
  })

  it('a child with no pid signals nothing: kill(0) would name our own group', () => {
    const child = fakeChild(0)
    stubKill(() => {})
    killTree(child, 'SIGKILL')
    expect(calls).toEqual([])
    expect(child.signals).toEqual([])
  })

  it('a group gone (ESRCH) is done; a group not ours (EPERM) falls back to the child', () => {
    const gone = fakeChild(4_000_002)
    stubKill(() => {
      throw errno('ESRCH')
    })
    killTree(gone, 'SIGTERM')
    expect(gone.signals).toEqual([])
    const foreign = fakeChild(4_000_003)
    stubKill(() => {
      throw errno('EPERM')
    })
    killTree(foreign, 'SIGTERM')
    expect(foreign.signals).toEqual(['SIGTERM'])
  })
})

describe('untilGroupsGone', () => {
  it('a group it may not signal (EPERM) is still there, so it is left to SIGKILL', async () => {
    const child = fakeChild(4_000_004)
    stubKill(() => {
      throw errno('EPERM')
    })
    expect(await untilGroupsGone([child], 30)).toEqual([child])
  })

  it('a child with no pid has no group to poll', async () => {
    const child = fakeChild(0)
    stubKill(() => {})
    expect(await untilGroupsGone([child], 30)).toEqual([])
    expect(calls).toEqual([])
  })
})
