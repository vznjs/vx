// An absolute link is saved and restored only into one of the task's
// `cache.outputs.mount` paths: there the dependant's sandbox lays the tree,
// so the link means the same on every machine. Anywhere else it names this
// machine, and an artifact carrying one is refused at restore, nothing
// written.
import { mkdtemp, readlink, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { ArchiveSecurityError, extractArtifactStream, packArtifact } from '../src/cache/archive.js'
import { UserError } from '../src/util/index.js'
import { streamOf } from './helpers/stream.js'
import { withSum } from './helpers/artifact-sum.js'

describe('absolute links into a declared mount', () => {
  let src: string
  let dest: string
  beforeEach(async () => {
    src = await mkdtemp(path.join(os.tmpdir(), 'vx-mount-link-src-'))
    dest = await mkdtemp(path.join(os.tmpdir(), 'vx-mount-link-dest-'))
  })
  afterEach(async () => {
    await rm(src, { recursive: true, force: true })
    await rm(dest, { recursive: true, force: true })
  })

  const pack = async (to: string, mounts?: string[]) => {
    await symlink(to, path.join(src, 'node'))
    return await packArtifact({
      stdout: '',
      outputs: new Map([['outputs/bin/node', path.join(src, 'node')]]),
      root: src,
      ...(mounts === undefined ? {} : { mounts }),
    })
  }
  const restore = async (bytes: Uint8Array, mounts?: string[]) =>
    await extractArtifactStream(
      streamOf(await withSum(bytes)),
      dest,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mounts,
    )

  it('round-trips as written', async () => {
    const bytes = await pack('/nix/store/abc-node/bin/node', ['/nix/store'])
    await restore(bytes, ['/nix/store'])
    expect(await readlink(path.join(dest, 'bin/node'))).toBe('/nix/store/abc-node/bin/node')
  })

  it('a restore that declares no such mount refuses it, writing nothing', async () => {
    const bytes = await pack('/nix/store/abc-node/bin/node', ['/nix/store'])
    await expect(restore(bytes)).rejects.toThrow(ArchiveSecurityError)
    await expect(restore(bytes, ['/opt/tools'])).rejects.toThrow(/no cache.outputs.mount declares/)
  })

  it('a save refuses one outside its mounts', async () => {
    await expect(pack('/etc/passwd', ['/nix/store'])).rejects.toThrow(UserError)
  })

  it('the mount path itself, or a path that climbs out of it, is outside', async () => {
    await expect(pack('/nix/store', ['/nix/store'])).rejects.toThrow(/absolute path/)
    await rm(path.join(src, 'node'), { force: true })
    await expect(pack('/nix/store/../../etc/passwd', ['/nix/store'])).rejects.toThrow(
      /absolute path/,
    )
  })
})
