// A vx upgrade may run the same task differently (#5112 changed what a
// spare shell gave a command and left CACHE_VERSION alone), and the new vx
// then restored what the old one saved. The vx version is in every key, so
// an upgrade misses once.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { CACHE_VERSION } from '../src/cache/index.js'
import { foldKey } from '../src/cache/key-fold.js'
import { relPosix, xxh3hex } from '../src/util/index.js'

const root = mkdtempSync(path.join(tmpdir(), 'vx-key-version-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

type Row = { kind: string; name: string; hash: string }
const key = (vxVersion: string, captureInto?: Row[]): Promise<string> =>
  foldKey(
    {
      taskId: 'pkg#build',
      taskConfigHash: 'cfg0123456789abc',
      envValues: [],
      inputFiles: [],
      workspaceRoot: root,
      upstreamHashes: [],
      vxVersion,
      ...(captureInto === undefined ? {} : { captureInto }),
    },
    (file) => Promise.resolve(xxh3hex(file)),
    (file) => relPosix(root, file),
  )

describe('the vx version is in every key', () => {
  it('keys one task apart under two vx versions', async () => {
    expect(await key('0.0.656')).not.toBe(await key('0.0.657'))
  })

  it('records the version beside the cache version, for vx why', async () => {
    const rows: Row[] = []
    await key('0.0.657', rows)
    expect(rows.slice(0, 2).map((r) => `${r.kind} ${r.name} ${r.hash}`)).toEqual([
      `format cache-version ${CACHE_VERSION}`,
      'format vx-version 0.0.657',
    ])
  })
})
