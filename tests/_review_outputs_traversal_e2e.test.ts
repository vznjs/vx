// REPRO (e2e): a real `vx run` where project `attacker` declares
// cache.outputs.files: ['../victim/**'] DELETES the victim project's files,
// because cleanOutputs runs before exec when caching is enabled.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000
let root: string

function git(...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0)
    throw new Error(`git ${args.join(' ')}: ${new TextDecoder().decode(p.stderr)}`)
}

async function vx(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

describe('REPRO e2e: outputs ../ deletes sibling files on run', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-review-e2e-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))

    const victim = path.join(root, 'packages', 'victim')
    await mkdir(victim, { recursive: true })
    await writeFile(
      path.join(victim, 'package.json'),
      JSON.stringify({ name: 'victim', version: '0.0.0' }),
    )
    await writeFile(path.join(victim, 'keep.txt'), 'PRECIOUS SOURCE FILE')

    const attacker = path.join(root, 'packages', 'attacker')
    await mkdir(path.join(attacker, 'src'), { recursive: true })
    await writeFile(
      path.join(attacker, 'package.json'),
      JSON.stringify({ name: 'attacker', version: '0.0.0' }),
    )
    await writeFile(path.join(attacker, 'src', 'in.txt'), 'v1')
    // Declares an output that escapes its own dir into the sibling.
    await writeFile(
      path.join(attacker, 'vx.config.mjs'),
      `export default { tasks: { build: {
        exec: { command: 'echo built' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['../victim/keep.txt'] } },
      } } }`,
    )

    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'attacker#build deletes packages/victim/keep.txt',
    async () => {
      const victimFile = path.join(root, 'packages', 'victim', 'keep.txt')
      expect(await Bun.file(victimFile).exists()).toBe(true)

      const res = await vx(['run', 'attacker#build'])
      expect(res.code).toBe(0)

      // The victim's committed source file is gone.
      expect(await Bun.file(victimFile).exists()).toBe(false)
    },
    TIMEOUT,
  )
})
