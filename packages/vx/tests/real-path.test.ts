// A config's import closure was once keyed under one spelling of a
// path while every caller compared another (O-16).
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { realPath, realpathOf } from '../src/util/index.js'

it('realPath spells a path as the OS and fs.promises.realpath do', async () => {
  expect(realPath(os.tmpdir())).toBe(await realpath(os.tmpdir()))
})

// Bun's realpath answers ENOENT for any path holding a backslash (1.4.2).
it('realpathOf resolves a chain of links whose names hold a backslash', async () => {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-realof-')))
  try {
    await mkdir(path.join(tmp, 'real\\dir', 'sub'), { recursive: true })
    await writeFile(path.join(tmp, 'real\\dir', 'sub', 'f'), 'x')
    await symlink('real\\dir', path.join(tmp, 'l\\1'))
    await symlink(path.join(tmp, 'l\\1', 'sub'), path.join(tmp, 'l\\2'))
    await symlink('../l\\2/f', path.join(tmp, 'real\\dir', 'l\\3'))
    const real = path.join(tmp, 'real\\dir', 'sub', 'f')
    expect(realpathOf(path.join(tmp, 'real\\dir', 'l\\3'))).toBe(real)
    // `..` after a link is taken from where it leads, as the kernel does.
    expect(realpathOf(`${tmp}/l\\2/../sub/f`)).toBe(real)
    expect(realpathOf(path.join(tmp, 'real\\dir'))).toBe(path.join(tmp, 'real\\dir'))
    expect(() => realpathOf(path.join(tmp, 'l\\1', 'gone'))).toThrow('ENOENT')
    await symlink('loop\\b', path.join(tmp, 'loop\\a'))
    await symlink('loop\\a', path.join(tmp, 'loop\\b'))
    expect(() => realpathOf(path.join(tmp, 'loop\\a'))).toThrow('ELOOP')
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})
