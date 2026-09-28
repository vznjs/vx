// On Windows `realpathSync` kept the temp dir's 8.3 short name
// (`RUNNER~1`) where `fs.promises.realpath` and git say `runneradmin`,
// and a config's import closure was keyed under the short spelling
// (O-16). The Windows job is the platform with a short-named temp dir.
import { realpath } from 'node:fs/promises'
import os from 'node:os'
import { expect, it } from 'bun:test'
import { realPath } from '../src/util/index.js'

it('realPath spells a path as the OS and fs.promises.realpath do', async () => {
  expect(realPath(os.tmpdir())).toBe(await realpath(os.tmpdir()))
})
