// A remote artifact holding an output symlink, too big to keep inline, is
// unpacked into a cache tree (`<tree>/outputs`, `<tree>/workspace-outputs`).
// The link check bounded it by `workspace-outputs`, so `dist/link -> big.bin`
// "pointed out of the workspace": the ingest failed and the task missed on
// every machine. The restore into the workspace is where links are checked.

import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache } from '../src/cache/cache.js'
import { storedArtifact } from './helpers/stored-artifact.js'
import { TAR_STORE } from './helpers/tar-store.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-ingest-link-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const hash = 'aaaaaaaaaaaaaaaa'
const entry = { taskId: 'pkg#build', command: 'x', durationMs: 1 }

async function artifact(to: string): Promise<{ projectDir: string; bytes: Uint8Array }> {
  const projectDir = path.join(root, 'pkg')
  await mkdir(path.join(projectDir, 'dist'), { recursive: true })
  // Incompressible, past the embed threshold: kept as a tree, not inline.
  await writeFile(path.join(projectDir, 'dist', 'big.bin'), randomBytes(256 * 1024))
  await symlink(to, path.join(projectDir, 'dist', 'link'))
  const producer = new Cache(
    path.join(root, 'a'),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    TAR_STORE,
  )
  await producer.save({
    hash,
    projectDir,
    workspaceRoot: root,
    outputFiles: [path.join(projectDir, 'dist', 'big.bin'), path.join(projectDir, 'dist', 'link')],
    entry: { ...entry, stdout: '' },
  })
  const bytes = storedArtifact(producer, hash)!
  producer.close()
  return { projectDir, bytes }
}

it('a remote artifact holding an output symlink ingests into the default store and restores', async () => {
  const { projectDir, bytes } = await artifact('big.bin')
  const consumer = new Cache(path.join(root, 'b'))
  try {
    await consumer.ingest(hash, new Blob([bytes]), entry)
    await rm(path.join(projectDir, 'dist'), { recursive: true })
    await consumer.restoreOutputs(hash, projectDir, root)
    expect(await readlink(path.join(projectDir, 'dist', 'link'))).toBe('big.bin')
  } finally {
    consumer.close()
  }
})
