// A package.json saved with a byte-order mark (Windows editors write one)
// is one npm, pnpm, yarn and Bun read: each strips the mark. vx upgrade
// and vx init parsed it raw and JSON.parse threw: a project listing
// @vzn/vx was refused as "no package.json lists @vzn/vx", and init's
// `next` never named the tool that maps its scripts.

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { managedInstall, projectManager } from '../src/cli/upgrade.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
function tmp(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-bom-')))
  roots.push(root)
  return root
}

describe('a package.json with a byte-order mark', () => {
  it('vx upgrade reads the field that lists vx, its plugins and packageManager', () => {
    const root = tmp()
    writeFileSync(
      path.join(root, 'package.json'),
      '﻿{"packageManager":"pnpm@10.0.0","devDependencies":{"@vzn/vx":"^0.0.1","@vzn/vx-otel":"^0.0.1"}}\n',
    )
    const bin = path.join(root, 'node_modules/@vzn/vx-linux-x64/vx')
    expect(managedInstall(bin, root)).toEqual({
      manager: 'pnpm',
      scope: 'project',
      cwd: root,
      field: 'devDependencies',
      plugins: ['@vzn/vx-otel'],
    })
    expect(projectManager(root, bin)).toBe('pnpm')
  })

  it("vx init's next names vx-migrate for its scripts", async () => {
    const root = tmp()
    expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0)
    writeFileSync(path.join(root, 'package.json'), '﻿{"name":"r","scripts":{"build":"tsc"}}\n')
    const { npm_config_user_agent: _, ...env } = process.env
    const proc = Bun.spawn([process.execPath, BIN, 'init', '--dry', '--format', 'json'], {
      cwd: root,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect([code, (JSON.parse(out) as { next: string }).next]).toEqual([
      0,
      'bunx @vzn/vx-migrate to make package.json scripts tasks, or declare a task in vx.config.ts, then vx lock && vx run <task>',
    ])
  })
})
