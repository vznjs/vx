// nx-exec reads Nx's cached project graph. A cache written before a
// project existed (one added since Nx last ran; a migrated config has no
// `nx()` re-exporting the graph) does not hold it, and the task failed
// with "no project … in the Nx project graph" where `nx run` computes the
// graph and runs it. A cache that lacks the project is computed once.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { fakeNx } from './helpers/fake-nx.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'nx-exec.cjs')
const node = (root: string) => ({ name: root, type: 'lib', data: { root, targets: {} } })
const OLD = { nodes: { app: node('packages/app') }, dependencies: { app: [] } }
const NEW = {
  nodes: { app: node('packages/app'), web: node('packages/web') },
  dependencies: { app: [], web: [] },
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-exec-stale-'))
  await mkdir(path.join(root, 'packages', 'web'), { recursive: true })
  await mkdir(path.join(root, '.nx', 'workspace-data'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), '{"name":"ws","private":true}')
  await writeFile(path.join(root, 'nx.json'), '{}')
  await writeFile(
    path.join(root, '.nx', 'workspace-data', 'project-graph.json'),
    JSON.stringify(OLD),
  )
  await writeFile(path.join(root, 'fallback-graph.json'), JSON.stringify(NEW))
  await fakeNx(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function run(project: string): Promise<number> {
  const clean = { ...process.env }
  delete clean['NX_DAEMON']
  const p = Bun.spawn(['node', BIN, 'x:y', '--project', project, '--target', 't'], {
    cwd: path.join(root, 'packages', 'web'),
    env: clean,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return p.exited
}

const computed = () => Bun.file(path.join(root, 'computed.marker')).exists()

describe('nx-exec with a stale graph cache', () => {
  it('a project the cache lacks is found in the computed graph', async () => {
    expect(await run('web')).toBe(0)
    expect(await computed()).toBe(true)
  })

  // Control: a project the cache holds runs from the cache, no compute.
  it('a project the cache holds is not computed', async () => {
    expect(await run('app')).toBe(0)
    expect(await computed()).toBe(false)
  })
})
