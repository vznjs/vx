// pnpm links only a root's direct dependencies into node_modules/.bin, so a
// Lerna repo on pnpm has no `nx` there; `lerna run` runs the nx Lerna
// depends on, and the export said "no node_modules/.bin/nx". Nx 20+'s bin
// then refuses outside a root that resolves nx (mui/base-ui, Nx 24), so the
// export goes through Nx's API, as Lerna does.
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

/**
 * pnpm's layout: lerna linked at the root, nx beside it in the store only.
 * Its bin refuses as Nx 20+'s does when nx does not resolve from the root;
 * its API is what Lerna calls.
 */
async function pnpmLerna(): Promise<void> {
  const store = path.join(root, 'node_modules', '.pnpm', 'lerna@10.1.2', 'node_modules')
  await mkdir(path.join(store, 'lerna'), { recursive: true })
  await writeFile(path.join(store, 'lerna', 'package.json'), '{ "name": "lerna" }')
  const nx = path.join(store, 'nx')
  await mkdir(path.join(nx, 'dist', 'bin'), { recursive: true })
  await mkdir(path.join(nx, 'dist', 'src'), { recursive: true })
  await writeFile(
    path.join(nx, 'package.json'),
    JSON.stringify({
      name: 'nx',
      bin: { nx: './dist/bin/nx.js' },
      exports: { './package.json': './package.json', './src/*': './dist/src/*.js' },
    }),
  )
  const bin = path.join(nx, 'dist', 'bin', 'nx.js')
  await writeFile(bin, `#!/bin/sh\necho 'Could not find Nx modules at "${root}".' >&2\nexit 1\n`)
  await chmod(bin, 0o755)
  await writeFile(
    path.join(nx, 'dist', 'src', 'devkit-exports.js'),
    `exports.createProjectGraphAsync = async () => ({
  nodes: { a: { name: 'a', data: { root: process.cwd() === ${JSON.stringify(root)} ? 'a' : 'wrong-cwd' } } },
  dependencies: { a: [] },
  externalNodes: { 'npm:x': {} },
})\n`,
  )
  await symlink(path.join(store, 'lerna'), path.join(root, 'node_modules', 'lerna'), 'dir')
}

it('exports through the API of the nx Lerna depends on when the root links none', async () => {
  await pnpmLerna()
  const snapshot = path.join(root, 'out', 'graph.json')
  expect(await exportGraph(root, snapshot)).toBeNull()
  expect(await Bun.file(snapshot).json()).toEqual({
    graph: { nodes: { a: { name: 'a', data: { root: 'a' } } }, dependencies: { a: [] } },
  })
})

it("a failing export names Lerna's nx and its error", async () => {
  await pnpmLerna()
  const api = path.join(
    root,
    'node_modules',
    '.pnpm',
    'lerna@10.1.2',
    'node_modules',
    'nx',
    'dist',
    'src',
    'devkit-exports.js',
  )
  await writeFile(
    api,
    "exports.createProjectGraphAsync = async () => { throw new Error('bad nx.json') }\n",
  )
  expect(await exportGraph(root, path.join(root, 'g.json'))).toBe(
    "Lerna's nx graph export exited 1: bad nx.json",
  )
})

it('control: neither nx nor lerna installed is the reason', async () => {
  expect(await exportGraph(root, path.join(root, 'g.json'))).toBe(
    "no node_modules/.bin/nx — install nx, or export a graph with `nx graph --file=<path>` and pass it as graph: '<path>'",
  )
})
