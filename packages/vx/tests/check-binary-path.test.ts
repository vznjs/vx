import { expect, it } from 'bun:test'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '..')

// `release` runs check.bun.binary and compile.bun.<host> on one worker: both
// compiled to dist/vx-<host>, so the build rewrote the file the check was
// launching, and the spawn failed EACCES (main, 2026-11-05).
it('check.bun.binary compiles to a path no compile.bun task writes', async () => {
  const check = await Bun.file(path.join(root, 'scripts/check-binary.ts')).text()
  const config = await Bun.file(path.join(root, 'vx.config.ts')).text()
  const out = /^const out = path\.join\(root, (.+)\)$/m.exec(check)?.[1]
  expect(out).toBeDefined()
  const segments = [...out!.matchAll(/'([^']+)'|`([^`]+)`/g)].map((m) => m[1] ?? m[2])
  const targets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']
  const built = [...config.matchAll(/--outfile (\S+?)[`']/g)].flatMap((m) =>
    targets.map((t) => m[1]!.replace('${target}', t)),
  )
  expect(built.length).toBeGreaterThan(0)
  for (const host of targets) {
    const file = segments.join('/').replace('${host}', host)
    expect(built).not.toContain(file)
  }
})
