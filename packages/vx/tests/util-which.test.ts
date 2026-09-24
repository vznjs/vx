// `executablePath` walks PATH once per tool and PATH value: every task spawn
// used to hand Bun the bare `sh`, and Bun walked the task's PATH for it
// again — 14 stats a task on this box's PATH, 2,800 on a 200-task run.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { executablePath, isExecutableMissing } from '../src/util/index.js'

describe('executablePath', () => {
  let dir: string
  let savedPath: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-which-'))
    savedPath = process.env['PATH']
  })

  afterEach(async () => {
    process.env['PATH'] = savedPath
    await rm(dir, { recursive: true, force: true })
  })

  async function tool(name: string): Promise<string> {
    const at = path.join(dir, name)
    await writeFile(at, '#!/bin/sh\n')
    await chmod(at, 0o755)
    return at
  }

  it('walks PATH once for repeated asks under one PATH', async () => {
    const at = await tool('vx-which-once')
    process.env['PATH'] = `${dir}${path.delimiter}${savedPath ?? ''}`
    const which = spyOn(Bun, 'which')
    try {
      expect([1, 2, 3].map(() => executablePath('vx-which-once'))).toEqual([at, at, at])
      expect(which.mock.calls.map((c) => c[0])).toEqual(['vx-which-once'])
    } finally {
      which.mockRestore()
    }
  })

  it('answers for the PATH the process has now, not the one it first asked under', async () => {
    const first = await tool('vx-which-moved')
    process.env['PATH'] = dir
    expect(executablePath('vx-which-moved')).toBe(first)
    const other = await mkdtemp(path.join(os.tmpdir(), 'vx-which-other-'))
    try {
      const second = path.join(other, 'vx-which-moved')
      await writeFile(second, '#!/bin/sh\n')
      await chmod(second, 0o755)
      process.env['PATH'] = other
      expect(executablePath('vx-which-moved')).toBe(second)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it("throws Bun's missing-executable shape, and does not remember the miss", async () => {
    process.env['PATH'] = dir
    let thrown: unknown
    try {
      executablePath('vx-which-late')
    } catch (err) {
      thrown = err
    }
    expect(isExecutableMissing(thrown)).toBe(true)
    expect((thrown as Error).message).toBe('Executable not found in $PATH: "vx-which-late"')
    // Installed afterwards, under the same PATH: found.
    const at = await tool('vx-which-late')
    expect(executablePath('vx-which-late')).toBe(at)
  })
})
