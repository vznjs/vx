// `vx reset` and the migrate guide's `nx reset` row named a bare
// `vx cache prune`, which refuses without --older-than or --max-size. The
// command they name now runs.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { FOREIGN_VERBS } from '../src/cli/foreign-flags.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const GUIDE = path.resolve(import.meta.dir, '../../vx-docs/src/content/docs/guides/migrate.md')
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe('the nx reset hint names a command that runs', () => {
  it('vx reset, and the migrate guide row, name it; it exits 0', async () => {
    const named = /is `(vx [^`]+)`/.exec(FOREIGN_VERBS['reset']!)![1]!
    const row = readFileSync(GUIDE, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('| `nx reset`'))!
    expect(row).toContain(`\`${named}\``)

    root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-reset-'))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r' }))
    const argv = named.slice(3).replace('<age>', '30d').split(' ')
    const r = Bun.spawnSync({
      cmd: [process.execPath, BIN, ...argv],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect({ argv, code: r.exitCode, err: r.stderr.toString() }).toEqual({ argv, code: 0, err: '' })
  })
})
