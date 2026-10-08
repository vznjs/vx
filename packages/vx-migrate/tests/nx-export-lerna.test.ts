// pnpm links only a root's direct dependencies into node_modules/.bin, so a
// Lerna repo on pnpm has no `nx` there; `lerna run` runs the nx Lerna
// depends on, and the export said "no node_modules/.bin/nx".
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { exportGraph } from '../src/nx/export-graph.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-export-lerna-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** pnpm's layout: lerna linked at the root, nx beside it in the store only. */
async function pnpmLerna(): Promise<void> {
  const store = path.join(root, 'node_modules', '.pnpm', 'lerna@9.0.7', 'node_modules')
  await mkdir(path.join(store, 'lerna'), { recursive: true })
  await writeFile(path.join(store, 'lerna', 'package.json'), '{ "name": "lerna" }')
  const nx = path.join(store, 'nx')
  await mkdir(path.join(nx, 'dist', 'bin'), { recursive: true })
  await writeFile(
    path.join(nx, 'package.json'),
    '{ "name": "nx", "bin": { "nx": "./dist/bin/nx.js" } }',
  )
  const bin = path.join(nx, 'dist', 'bin', 'nx.js')
  await writeFile(bin, '#!/bin/sh\necho "{\\"from\\": \\"lerna\\"}" > "${2#--file=}"\n')
  await chmod(bin, 0o755)
  await symlink(path.join(store, 'lerna'), path.join(root, 'node_modules', 'lerna'), 'dir')
}

it('exports with the nx Lerna depends on when the root links none', async () => {
  await pnpmLerna()
  const snapshot = path.join(root, 'out', 'graph.json')
  expect(await exportGraph(root, snapshot)).toBeNull()
  expect(await Bun.file(snapshot).text()).toBe('{"from": "lerna"}\n')
})

it('control: neither nx nor lerna installed is the reason', async () => {
  expect(await exportGraph(root, path.join(root, 'g.json'))).toBe(
    "no node_modules/.bin/nx — install nx, or export a graph with `nx graph --file=<path>` and pass it as graph: '<path>'",
  )
})
