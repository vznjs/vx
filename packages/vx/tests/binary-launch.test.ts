// release.ts and check-binary.ts compare `<bin> --version` to `vx <version>`.
// A CI env that forces colour made the binary print it styled, and
// v0.0.647's release refused a binary that reported the right version.
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { launchVersion } from '../scripts/binary-launch.ts'

it('reads the version a binary prints in colour as its plain text', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vx-launch-'))
  const bin = path.join(dir, 'vx')
  await writeFile(
    bin,
    "#!/bin/sh\nprintf '\\033[1mvx\\033[0m \\033[38;2;6;182;212m0.0.7\\033[0m\\n'\n",
  )
  await chmod(bin, 0o755)
  expect(launchVersion(bin)).toEqual({ exitCode: 0, version: 'vx 0.0.7', stderr: '' })
})
