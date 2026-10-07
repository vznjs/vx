// `vx reset` and the migrate guide's `nx reset` row named a bare
// `vx cache prune`, which refuses without --older-than or --max-size. The
// command they name now runs. Both, and cli.md, told a reader to remove the
// cache directory to drop it all, but the entries live in the shared store
// `vx info` names (X-44).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
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

describe('the advice to drop the whole cache names the store', () => {
  it('vx reset says it exactly; the guide row and cli.md say the same', async () => {
    root ??= await mkdtemp(path.join(os.tmpdir(), 'vx-nx-reset-'))
    const r = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'reset'],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.stderr.toString()).toBe(
      '`nx reset` is `vx cache prune --older-than <age>` here, or delete the cache store `vx info` names to drop it all\n',
    )
    const row = readFileSync(GUIDE, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('| `nx reset`'))!
    expect(row).toContain('delete the cache store `vx info` names')
    const cli = readFileSync(path.resolve(import.meta.dir, '..', 'docs', 'cli.md'), 'utf8')
    expect(cli.replace(/\s+/g, ' ')).toContain('Delete the cache store `vx info` names')
  })

  it('vx info has a `cache store` line to name', async () => {
    root ??= await mkdtemp(path.join(os.tmpdir(), 'vx-nx-reset-'))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r' }))
    for (const git of [
      ['init', '-q'],
      ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'i'],
    ])
      expect(Bun.spawnSync({ cmd: ['git', ...git], cwd: root }).exitCode).toBe(0)
    const home = realpathSync(root)
    const env: Record<string, string | undefined> = { ...process.env, HOME: home }
    delete env['VX_CACHE_DIR']
    const r = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'info'],
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const line = r.stdout
      .toString()
      .split('\n')
      .find((l) => l.startsWith('cache store:'))
    expect(line?.replace(/^cache store:\s+/, '').startsWith(path.join(home, '.vx'))).toBe(true)
  })
})
