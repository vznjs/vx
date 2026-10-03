// `vx upgrade` where this user cannot write beside the binary refuses
// before it downloads: the swap renames into the binary's directory, and
// a root-owned one failed at the rename with the whole release fetched
// and a hint to reinstall with npm, which a compiled binary is not.

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { replaceBinary } from '../src/cli/upgrade.js'
import { skipAsRoot } from './helpers/nonroot-gate.js'

let dir = ''
let fetched = 0
const real = globalThis.fetch
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-upgrade-pre-'))
  fetched = 0
  globalThis.fetch = (() => {
    fetched++
    return Promise.resolve(new Response('bytes'))
  }) as unknown as typeof fetch
})
afterEach(async () => {
  globalThis.fetch = real
  await chmod(dir, 0o755).catch(() => {})
  await rm(dir, { recursive: true, force: true })
})

const refusal = (where: string, code: string): string =>
  `vx upgrade: cannot write to ${where} (${code}), where this vx lives — nothing downloaded; re-run as a user who can (sudo vx upgrade), or install vx somewhere you can write`

async function refused(dest: string): Promise<string> {
  return await replaceBinary(dest, 'https://example.invalid/asset', 'a'.repeat(64)).then(
    () => 'installed',
    (err: Error) => err.message,
  )
}

it('a directory that is not there is refused before any download', async () => {
  const gone = path.join(dir, 'gone')
  expect([await refused(path.join(gone, 'vx')), fetched]).toEqual([refusal(gone, 'ENOENT'), 0])
})

it.skipIf(skipAsRoot('upgrade write preflight'))(
  'a directory this user cannot write is refused before any download',
  async () => {
    const bin = path.join(dir, 'bin')
    await mkdir(bin)
    await writeFile(path.join(bin, 'vx'), 'old')
    await chmod(bin, 0o555)
    expect([await refused(path.join(bin, 'vx')), fetched]).toEqual([refusal(bin, 'EACCES'), 0])
  },
)

it('a writable directory downloads (control)', async () => {
  await writeFile(path.join(dir, 'vx'), 'old')
  await refused(path.join(dir, 'vx'))
  expect(fetched).toBe(1)
})
