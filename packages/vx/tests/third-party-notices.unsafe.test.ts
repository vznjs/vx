// The compiled binary embeds Bun and npm code whose licenses require their
// notices in every copy, so the platform packages ship
// THIRD_PARTY_NOTICES.txt beside it (scripts/third-party-notices.ts). The
// committed file must be what the generator derives from today's bundle
// and Bun pin: a dependency that joins the binary, or a Bun bump, fails
// here until the file is regenerated.
//
// `.unsafe`: it reads the repo-root manifest and LICENSE and the hoisted
// node_modules, outside this project.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { TARGETS, emitPlatformPackages } from '../scripts/build-npm.ts'
import {
  NOTICES,
  committedBunLicense,
  pinnedBun,
  renderNotices,
} from '../scripts/third-party-notices.ts'

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-notices-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('third-party notices', () => {
  it('are current for the bundle and the pinned Bun', async () => {
    const committed = readFileSync(NOTICES, 'utf8')
    const bun = committedBunLicense(committed, pinnedBun())
    expect(bun).toContain('JavaScriptCore')
    expect(await renderNotices(pinnedBun(), bun!)).toBe(committed)
    // Floor: the sandbox runtime is in the binary, so a bundle walk that
    // finds no package cannot pass.
    expect(committed).toContain('\n@anthropic-ai/sandbox-runtime@')
  })

  it('render the same from the repo root, where the docs say to run it', async () => {
    const committed = readFileSync(NOTICES, 'utf8')
    const cwd = process.cwd()
    process.chdir(path.resolve(import.meta.dir, '..', '..', '..'))
    try {
      expect(await renderNotices(pinnedBun(), committedBunLicense(committed, pinnedBun())!)).toBe(
        committed,
      )
    } finally {
      process.chdir(cwd)
    }
  })

  it('ship with LICENSE in every platform package', async () => {
    const dist = path.join(root, 'dist')
    mkdirSync(dist)
    for (const t of TARGETS) writeFileSync(path.join(dist, `vx-${t.target}`), '')
    const out = path.join(root, 'npm')
    await emitPlatformPackages({
      mainName: '@vzn/vx',
      base: 'vx',
      distPrefix: 'vx',
      targets: TARGETS,
      version: '9.9.9',
      outDir: out,
      distDir: dist,
    })
    for (const t of TARGETS) {
      const dir = path.join(out, `@vzn/vx-${t.target}`)
      const files: string[] = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).files
      expect(files).toEqual(['vx', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'])
      for (const f of files) expect(existsSync(path.join(dir, f))).toBe(true)
      expect(readFileSync(path.join(dir, 'THIRD_PARTY_NOTICES.txt'), 'utf8')).toBe(
        readFileSync(NOTICES, 'utf8'),
      )
    }
  })
})
