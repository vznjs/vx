// The playground's platform shims (src/playground/shim/): the in-memory
// file system and the `node:fs`, `node:fs/promises` and `Bun` answers the
// bundled planner reads through it. Core's parity rows
// (packages/vx/tests/playground-parity.unsafe.test.ts) plan whole
// workspaces through them and held 4 of 28 mutations here; these rows hold
// the answers one at a time, each as the real call answers it (item 833).
import { beforeEach, describe, expect, it } from 'bun:test'
import * as fs from '../src/playground/shim/node-fs.js'
import * as fsp from '../src/playground/shim/node-fs-promises.js'
import { bun, proc, setEnv } from '../src/playground/shim/platform.js'
import { Vfs, useVfs } from '../src/playground/shim/vfs.js'

let vfs: Vfs
beforeEach(() => {
  vfs = new Vfs('/ws', {
    'package.json': '{}',
    'a/y.txt': 'why',
    'ab/x.txt': 'ex',
    'a/deep/z.txt': 'zed',
  })
  useVfs(vfs)
})
const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'resolved',
    (e: { code?: string }) => e.code ?? 'no code',
  )
const syncCode = (f: () => unknown): string => {
  try {
    f()
    return 'returned'
  } catch (e) {
    return (e as { code?: string }).code ?? 'no code'
  }
}
const names = (xs: { name: string; isDirectory(): boolean }[]) =>
  xs.map((d) => `${d.name}${d.isDirectory() ? '/' : ''}`).sort()

describe('the VFS', () => {
  it('a path with `.` and `..` segments reads the file it names, and the read is recorded normalised', () => {
    expect(new TextDecoder().decode(vfs.read('/ws/a/./deep/../y.txt'))).toBe('why')
    expect(vfs.reads).toEqual(['/ws/a/y.txt'])
  })

  it('stat: a directory implied by its files exists as a directory; a file has its size', () => {
    const dir = vfs.stat('/ws/a/deep')!
    const file = vfs.stat('/ws/a/y.txt')!
    expect([dir.isDirectory(), dir.isFile(), file.isDirectory(), file.isFile(), file.size]).toEqual(
      [true, false, false, true, 3],
    )
    expect(vfs.stat('/ws/nope')).toBeUndefined()
  })

  it('list: a directory’s own entries, files and directories told apart; the root; nothing for a missing one', () => {
    expect(names(vfs.list('/ws/a')!)).toEqual(['deep/', 'y.txt'])
    expect(names(vfs.list('/ws')!)).toEqual(['a/', 'ab/', 'package.json'])
    expect(names(vfs.list('/')!)).toEqual(['ws/'])
    expect(vfs.list('/ws/nope')).toBeUndefined()
    // A file is not a directory to list.
    expect(vfs.list('/ws/a/y.txt')).toBeUndefined()
  })
})

describe('node:fs over the VFS', () => {
  it('lstatSync throws ENOENT, or answers undefined when asked not to throw', () => {
    expect(syncCode(() => fs.lstatSync('/ws/nope'))).toBe('ENOENT')
    expect(fs.lstatSync('/ws/nope', { throwIfNoEntry: false })).toBeUndefined()
  })

  it('existsSync is true for a directory too; readFileSync is bytes without an encoding', () => {
    expect([fs.existsSync('/ws/a'), fs.existsSync('/ws/nope')]).toEqual([true, false])
    expect(fs.readFileSync('/ws/a/y.txt')).toBeInstanceOf(Uint8Array)
    expect(fs.readFileSync('/ws/a/y.txt', 'utf8')).toBe('why')
    expect(syncCode(() => fs.readFileSync('/ws/nope'))).toBe('ENOENT')
  })
})

describe('node:fs/promises over the VFS', () => {
  it('stat, readdir, readFile and realpath reject a missing path with ENOENT', async () => {
    expect(await code(fsp.stat('/ws/nope'))).toBe('ENOENT')
    expect(await code(fsp.readdir('/ws/nope'))).toBe('ENOENT')
    expect(await code(fsp.readFile('/ws/nope'))).toBe('ENOENT')
    expect(await code(fsp.realpath('/ws/nope'))).toBe('ENOENT')
    expect(await fsp.realpath('/ws/a')).toBe('/ws/a')
  })

  it('readdir is names unless asked for entries; readFile is bytes without an encoding', async () => {
    expect(((await fsp.readdir('/ws/a')) as string[]).sort()).toEqual(['deep', 'y.txt'])
    const entries = (await fsp.readdir('/ws/a', { withFileTypes: true })) as Parameters<
      typeof names
    >[0]
    expect(names(entries)).toEqual(['deep/', 'y.txt'])
    expect(await fsp.readFile('/ws/a/y.txt')).toBeInstanceOf(Uint8Array)
    expect(await fsp.readFile('/ws/a/y.txt', 'utf8')).toBe('why')
  })
})

describe('Bun and process over the VFS', () => {
  it('Bun.file: exists() is false for a directory, as Bun’s is; a missing file’s read is ENOENT', async () => {
    expect([
      await bun.file('/ws/a/y.txt').exists(),
      await bun.file('/ws/a').exists(),
      await bun.file('/ws/nope').exists(),
    ]).toEqual([true, false, false])
    expect(await code(bun.file('/ws/nope').text())).toBe('ENOENT')
  })

  it('Bun.semver.satisfies answers the range, not yes', () => {
    expect([
      bun.semver.satisfies('1.2.3', '^1.0.0'),
      bun.semver.satisfies('1.2.3', '^2.0.0'),
    ]).toEqual([true, false])
  })

  it('setEnv replaces the environment, dropping what the last one set', () => {
    setEnv({ A: '1' })
    setEnv({ B: '2' })
    expect({ ...proc.env }).toEqual({ B: '2' })
  })
})
