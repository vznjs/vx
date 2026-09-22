// The gate's floor check (scripts/bun-floor.ts, the `check.bun` task every
// core task waits on through `install`). The verdict is a pure function of
// the version so both sides are testable on one runtime; the spawn proves
// the script's exit follows the verdict on the Bun that runs this suite,
// which is at or above the floor wherever the suite is green.
import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import { CI_BUN, floorVerdict, RELEASE_ASSET } from '../scripts/bun-floor.js'
import { isUnsupportedBun, MIN_BUN } from '../src/util/index.js'

const script = path.resolve(import.meta.dir, '..', 'scripts', 'bun-floor.ts')

describe('floorVerdict', () => {
  it('refuses below MIN_BUN and names the release asset; accepts at and above it', () => {
    const below = floorVerdict('1.3.11')
    expect(below.ok).toBe(false)
    expect(below.message).toContain(`Bun >= ${MIN_BUN.join('.')}`)
    expect(below.message).toContain(RELEASE_ASSET(CI_BUN))
    expect(below.message).toContain('refuses to run below the floor')
    const at = floorVerdict(MIN_BUN.join('.'))
    expect(at).toEqual({
      ok: true,
      message: `bun ${MIN_BUN.join('.')} (floor ${MIN_BUN.join('.')})`,
    })
    expect(floorVerdict(CI_BUN).ok).toBe(true)
  })

  it('CI pins a version at or above the floor, and the asset name follows the platform', () => {
    expect(isUnsupportedBun(CI_BUN)).toBe(false)
    expect(RELEASE_ASSET('1.4.2', 'linux', 'x64')).toBe(
      'https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip',
    )
    expect(RELEASE_ASSET('1.4.2', 'darwin', 'arm64')).toBe(
      'https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-darwin-aarch64.zip',
    )
  })
})

describe('scripts/bun-floor.ts', () => {
  it('exits by the verdict on the running Bun, printing the version on success', () => {
    const r = Bun.spawnSync({ cmd: [process.execPath, script], stdout: 'pipe', stderr: 'pipe' })
    const verdict = floorVerdict(Bun.version)
    expect(r.exitCode).toBe(verdict.ok ? 0 : 1)
    const out = new TextDecoder().decode(verdict.ok ? r.stdout : r.stderr)
    expect(out.trim()).toBe(verdict.message)
  })
})
