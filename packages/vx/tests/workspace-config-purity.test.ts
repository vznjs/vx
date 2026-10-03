// vx.workspace.ts runs in this process like a project config's first load,
// but had none of its guard: its `Object.prototype.exec` ran in a
// project's group task (D-126). The same snapshot, put back and refusal
// now wrap it.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { loadWorkspaceConfig } from '../src/workspace/project-loader.js'

async function load(source: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-ws-purity-'))
  try {
    await Bun.write(path.join(root, 'vx.workspace.mjs'), source)
    return await loadWorkspaceConfig(root).then(
      () => 'loaded',
      (err: Error) => err.message.replace(/^.*? changed (.*?) while it was evaluated.*$/s, '$1'),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('a workspace config that changes a built-in is put back and refused', async () => {
  expect(await load("Object.prototype.exec = { command: 'x' }\nexport default {}\n")).toBe(
    'Object.prototype.exec',
  )
  expect('exec' in {}).toBe(false)
  expect(await load("process.env.VX_WS_PURITY = '1'\nexport default {}\n")).toBe(
    'process.env.VX_WS_PURITY',
  )
  expect(process.env['VX_WS_PURITY']).toBeUndefined()
  // A load that fails after the change is refused for the change.
  expect(await load("Object.prototype.exec = { command: 'x' }\nthrow new Error('typo')\n")).toBe(
    'Object.prototype.exec',
  )
  expect('exec' in {}).toBe(false)
})

it('a workspace config that changes nothing, or only sets a global, loads', async () => {
  // CONTROLS: it loads first in every run, so a global it sets is the same
  // for every project config; plugins and their tests hand state through one.
  expect(await load('export default { plugins: [] }\n')).toBe('loaded')
  expect(await load('globalThis.__vxWsPurity = 1\nexport default {}\n')).toBe('loaded')
  delete (globalThis as { __vxWsPurity?: unknown }).__vxWsPurity
})
