import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { packArchive, tarPath, unpackArchive, uniqueStageDir } from '../src/cache-archive.js'

describe('packArchive + unpackArchive', () => {
  let stage: string
  let dest: string

  beforeEach(async () => {
    stage = await mkdtemp(path.join(os.tmpdir(), 'vzn-pack-'))
    dest = await mkdtemp(path.join(os.tmpdir(), 'vzn-dest-'))
  })

  afterEach(async () => {
    await rm(stage, { recursive: true, force: true })
    await rm(dest, { recursive: true, force: true })
  })

  it('round-trips a stage dir with meta.json and outputs/', async () => {
    await writeFile(path.join(stage, 'meta.json'), '{"taskId":"pkg#build"}')
    await mkdir(path.join(stage, 'outputs', 'dist'), { recursive: true })
    await writeFile(path.join(stage, 'outputs', 'dist', 'index.js'), 'console.log("hi")')
    await writeFile(path.join(stage, 'outputs', 'dist', 'index.js.map'), '{"version":3}')

    const tarball = await packArchive(stage)
    expect(tarball.byteLength).toBeGreaterThan(0)

    await unpackArchive(tarball, dest)
    expect(await readFile(path.join(dest, 'meta.json'), 'utf8')).toBe('{"taskId":"pkg#build"}')
    expect(await readFile(path.join(dest, 'outputs', 'dist', 'index.js'), 'utf8')).toBe(
      'console.log("hi")',
    )
    expect(await readFile(path.join(dest, 'outputs', 'dist', 'index.js.map'), 'utf8')).toBe(
      '{"version":3}',
    )
  })

  it('preserves binary content byte-for-byte', async () => {
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) bytes[i] = i
    await writeFile(path.join(stage, 'blob.bin'), bytes)

    const tarball = await packArchive(stage)
    await unpackArchive(tarball, dest)
    const restored = await Bun.file(path.join(dest, 'blob.bin')).bytes()
    expect(restored.length).toBe(256)
    for (let i = 0; i < 256; i++) expect(restored[i]).toBe(i)
  })

  it('handles empty stage dirs', async () => {
    const tarball = await packArchive(stage)
    expect(tarball.byteLength).toBeGreaterThan(0)
    await unpackArchive(tarball, dest)
    // dest is created but empty.
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dest)
    expect(entries).toEqual([])
  })

  it('handles deeply nested directory trees', async () => {
    const deep = path.join(stage, 'a', 'b', 'c', 'd', 'e', 'f')
    await mkdir(deep, { recursive: true })
    await writeFile(path.join(deep, 'leaf.txt'), 'leaf')

    const tarball = await packArchive(stage)
    await unpackArchive(tarball, dest)
    expect(await readFile(path.join(dest, 'a/b/c/d/e/f/leaf.txt'), 'utf8')).toBe('leaf')
  })

  it('packArchive rejects when the source dir does not exist', async () => {
    await expect(packArchive(path.join(stage, 'no-such-dir'))).rejects.toThrow(/tar exited/)
  })

  it('unpackArchive creates destDir if missing', async () => {
    await writeFile(path.join(stage, 'a.txt'), 'a')
    const tarball = await packArchive(stage)
    const fresh = path.join(dest, 'nested', 'newdir')
    await unpackArchive(tarball, fresh)
    expect(await readFile(path.join(fresh, 'a.txt'), 'utf8')).toBe('a')
  })

  it('unpackArchive rejects a corrupt tarball', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    await expect(unpackArchive(garbage, dest)).rejects.toThrow(/tar exited/)
  })

  it('accepts ArrayBuffer input', async () => {
    await writeFile(path.join(stage, 'a.txt'), 'a')
    const tarball = await packArchive(stage)
    // Re-wrap as ArrayBuffer
    const ab = tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength)
    await unpackArchive(ab as ArrayBuffer, dest)
    expect(await readFile(path.join(dest, 'a.txt'), 'utf8')).toBe('a')
  })
})

describe('tarPath', () => {
  it('joins segments with forward slashes', () => {
    expect(tarPath('outputs', 'dist', 'index.js')).toBe('outputs/dist/index.js')
  })

  it('normalizes backslashes', () => {
    expect(tarPath('outputs', 'dist\\index.js')).toBe('outputs/dist/index.js')
  })

  it('collapses repeated slashes', () => {
    expect(tarPath('outputs//dist', '/index.js')).toBe('outputs/dist/index.js')
  })
})

describe('uniqueStageDir', () => {
  it('produces a path under the parent with pid + timestamp suffix', () => {
    const p = uniqueStageDir('/tmp', 'vzn')
    expect(p.startsWith('/tmp/vzn.')).toBe(true)
    const parts = p.split('.')
    expect(Number(parts[1])).toBe(process.pid)
    expect(Number(parts[2])).toBeGreaterThan(0)
  })
})
