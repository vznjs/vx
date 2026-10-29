// A Yarn 2+ repo before its first install has no yarn.lock, only
// `packageManager: yarn@4…`; Berry has no `-W` ("Unsupported option name"),
// and vx-migrate passed it, reading Yarn 1 from the missing lockfile.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { installArgv, removeArgv } from '../src/adopt.js'

const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

describe('Yarn 2+ named by packageManager alone', () => {
  it('adds and removes without -W', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-berry-nolock-'))
    roots.push(root)
    await writeFile(
      path.join(root, 'package.json'),
      '{"name":"r","packageManager":"yarn@4.5.0","workspaces":["packages/*"]}\n',
    )
    expect([installArgv(root, 'yarn', ['@vzn/vx']), removeArgv(root, 'yarn', ['x'])]).toEqual([
      ['yarn', 'add', '-D', '@vzn/vx'],
      ['yarn', 'remove', 'x'],
    ])
  })

  it('Yarn 1 named by packageManager still gets -W', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-yarn1-nolock-'))
    roots.push(root)
    await writeFile(
      path.join(root, 'package.json'),
      '{"name":"r","packageManager":"yarn@1.22.22","workspaces":["packages/*"]}\n',
    )
    expect(installArgv(root, 'yarn', ['@vzn/vx'])).toEqual(['yarn', 'add', '-D', '-W', '@vzn/vx'])
  })
})
