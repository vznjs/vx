// A member dir with a vx config and no package.json was skipped without a
// word: `--all` said no package matched, and a run from inside it "not
// inside a project" (D-128). Discovery names it, as it names a nameless one.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { listProjects, loadWorkspace } from '../src/workspace/workspace.js'

it('names a member dir that has a vx config but no package.json', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-no-manifest-'))
  const written: string[] = []
  const real = process.stderr.write.bind(process.stderr)
  try {
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    )
    const member = async (name: string, files: Record<string, string>) => {
      await mkdir(path.join(dir, 'packages', name), { recursive: true })
      for (const [file, body] of Object.entries(files)) {
        await writeFile(path.join(dir, 'packages', name, file), body)
      }
    }
    const config = 'export default { tasks: {} }\n'
    await member('lost', { 'vx.config.mjs': config })
    // CONTROLS: a member with both, and a dir with neither (no word).
    await member('kept', { 'package.json': '{"name":"kept"}', 'vx.config.mjs': config })
    await member('empty', { 'README.md': 'x\n' })
    process.stderr.write = ((chunk: unknown): boolean => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    const names = (await listProjects(await loadWorkspace(dir))).map((p) => p.name)
    process.stderr.write = real
    expect(names).toEqual(['kept'])
    expect(written).toEqual([
      'vx: packages/lost has a vx config but no package.json — skipped: vx names a project by its package.json "name"\n',
    ])
  } finally {
    process.stderr.write = real
    await rm(dir, { recursive: true, force: true })
  }
})

it('names the workspace root when it has a vx config but no package.json (D-154)', async () => {
  // A pnpm root keeps its member list in pnpm-workspace.yaml; with a root
  // vx config and no package.json the line read "vx:  has a vx config".
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-no-manifest-'))
  const written: string[] = []
  const real = process.stderr.write.bind(process.stderr)
  try {
    await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    await writeFile(path.join(dir, 'vx.config.mjs'), 'export default { tasks: {} }\n')
    await mkdir(path.join(dir, 'packages', 'a'), { recursive: true })
    await writeFile(path.join(dir, 'packages', 'a', 'package.json'), '{"name":"a"}')
    process.stderr.write = ((chunk: unknown): boolean => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    const names = (await listProjects(await loadWorkspace(dir))).map((p) => p.name)
    process.stderr.write = real
    expect(names).toEqual(['a'])
    expect(written).toEqual([
      'vx: the workspace root has a vx config but no package.json — skipped: vx names a project by its package.json "name"\n',
    ])
  } finally {
    process.stderr.write = real
    await rm(dir, { recursive: true, force: true })
  }
})
