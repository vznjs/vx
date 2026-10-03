// A config whose default export is a function (Vite's
// `defineConfig(() => ({ … }))` shape) is told so, on the first load and
// on a repeat one, which evaluates in a worker and carries JSON back.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { loadProjectConfig, loadWorkspaceConfig } from '../src/workspace/project-loader.js'

const refused = (p: Promise<unknown>, file: string): Promise<string> =>
  p.then(
    () => 'loaded',
    (err: Error) => err.message.replace(file, '<file>'),
  )

it('a function default export is named, in-process and from the worker', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-fn-export-'))
  try {
    const file = path.join(dir, 'vx.config.mjs')
    await writeFile(file, 'export default () => ({ tasks: {} })\n')
    const fn =
      'did not export a default object: it exports a function, and vx reads the object itself — export what the function returns'
    expect(await refused(loadProjectConfig(file), file)).toBe(`Project config at <file> ${fn}`)
    // The repeat load runs in the worker.
    expect(await refused(loadProjectConfig(file), file)).toBe(`Project config at <file> ${fn}`)
    const ws = path.join(dir, 'vx.workspace.mjs')
    await writeFile(ws, 'export default async () => ({ plugins: [] })\n')
    expect(await refused(loadWorkspaceConfig(dir), ws)).toBe(`Workspace config at <file> ${fn}`)
    // CONTROL: a number keeps the bare message.
    const n = path.join(dir, 'n', 'vx.config.mjs')
    await Bun.write(n, 'export default 42\n')
    expect(await refused(loadProjectConfig(n), n)).toBe(
      'Project config at <file> did not export a default object',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
