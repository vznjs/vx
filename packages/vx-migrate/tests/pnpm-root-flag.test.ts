// pnpm refuses `-w` outside a workspace ("--workspace-root may only be used
// inside a workspace"), and a single-package pnpm repo has no
// pnpm-workspace.yaml: the install vx-migrate ran there failed, and so did
// the removal. `-w` only where pnpm-workspace.yaml makes the repo one.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { installArgv, removeArgv } from '../src/adopt.js'

const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

describe("pnpm's -w", () => {
  it('is passed in a pnpm workspace and not in a single-package repo', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-pnpm-w-'))
    roots.push(root)
    await writeFile(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    const single = [installArgv(root, 'pnpm', ['@vzn/vx']), removeArgv(root, 'pnpm', ['x'])]
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    expect([
      ...single,
      installArgv(root, 'pnpm', ['@vzn/vx']),
      removeArgv(root, 'pnpm', ['x']),
    ]).toEqual([
      ['pnpm', 'add', '-D', '@vzn/vx'],
      ['pnpm', 'remove', 'x'],
      ['pnpm', 'add', '-D', '-w', '@vzn/vx'],
      ['pnpm', 'remove', '-w', 'x'],
    ])
  })
})
