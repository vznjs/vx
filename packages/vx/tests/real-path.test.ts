// A config's import closure was once keyed under one spelling of a
// path while every caller compared another (O-16).
import { realpath } from 'node:fs/promises'
import os from 'node:os'
import { expect, it } from 'bun:test'
import { realPath } from '../src/util/index.js'

it('realPath spells a path as the OS and fs.promises.realpath do', async () => {
  expect(realPath(os.tmpdir())).toBe(await realpath(os.tmpdir()))
})
