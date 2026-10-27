// A member directory this user may not open: a scanned glob refuses naming
// the glob, and a listed member is named and skipped (D-132; core's until
// 2026-10-14, when package discovery left core).
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { listPackages } from '../src/packages.js'
import { skipAsRoot } from './helpers/nonroot-gate.js'

describe.skipIf(skipAsRoot('a member directory this user may not open'))(
  'a member directory this user may not open',
  () => {
    let root: string
    beforeEach(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-unreadable-')))
      await writeFile(path.join(root, 'package.json'), '{"name":"r","workspaces":["packages/*"]}')
      for (const p of ['a', 'b']) {
        await mkdir(path.join(root, 'packages', p), { recursive: true })
        await writeFile(path.join(root, 'packages', p, 'package.json'), `{"name":"${p}"}`)
      }
    })
    afterEach(async () => {
      await chmod(path.join(root, 'packages', 'b'), 0o755)
      await rm(root, { recursive: true, force: true })
    })

    it('refuses a directory a scanned glob may not open, naming the glob', async () => {
      await writeFile(path.join(root, 'package.json'), '{"name":"r","workspaces":["packages/**"]}')
      await chmod(path.join(root, 'packages', 'b'), 0o000)
      await expect(listPackages(root)).rejects.toThrow(
        'packages/b: not readable by this user (EACCES), and the workspace glob "packages/**" walks into it',
      )
    })

    it('names and skips a member directory it may not search', async () => {
      await chmod(path.join(root, 'packages', 'b'), 0o000)
      expect((await listPackages(root)).map((m) => m.name)).toEqual(['a'])
    })

    it('CONTROL: every member readable lists both', async () => {
      expect((await listPackages(root)).map((m) => m.name)).toEqual(['a', 'b'])
    })
  },
)
