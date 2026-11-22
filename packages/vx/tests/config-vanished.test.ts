// A config deleted between discovery and its read (a checkout, a branch
// switch, an editor's save-by-rename while `vx lock` ran) crashed the verb
// with a raw `Error: ENOENT` and a stack (2026-11-22, lockrun seed 163).
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { UserError } from '../src/util/index.js'
import { readOnce } from '../src/workspace/load-reads.js'
import { loadProjectConfigs } from '../src/workspace/project-loader.js'

it('a config gone before its read is a user error naming it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-vanished-'))
  try {
    const file = path.join(dir, 'vx.config.mjs')
    const err = await loadProjectConfigs([file]).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(UserError)
    expect((err as Error).message).toBe(
      `${file}: went away while vx read it; something moved or deleted it during this command — re-run`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('a root file gone between its probe and its read is no file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-vanished-'))
  try {
    const file = path.join(dir, 'package.json')
    await Bun.write(file, '{}')
    const real = Bun.file
    // The probe sees the file; the delete lands before the read.
    Bun.file = ((p: string) => {
      const f = real(p)
      if (p !== file) return f
      return {
        exists: async () => {
          const there = await f.exists()
          await rm(file)
          return there
        },
        bytes: () => real(p).bytes(),
      }
    }) as typeof Bun.file
    try {
      expect(await readOnce(undefined, file)).toBeNull()
    } finally {
      Bun.file = real
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
