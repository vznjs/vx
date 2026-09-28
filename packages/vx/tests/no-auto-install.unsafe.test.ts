// Bun auto-installs a bare import from the npm registry when no
// `node_modules` is above the importer, and runs it. `project-loader.ts`
// refuses such an import in the config itself before evaluating, but a
// local file the config imports reached the registry: a fresh clone before
// its install, or a typo in a helper, downloaded and ran a package (L-22).
// `bin.ts`'s shebang runs Bun with --no-install, so no import vx evaluates
// installs; the npm launcher's source fallback passes the same flag
// (`npm-launcher.test.ts`), and a compiled binary never auto-installs.
//
// `.unsafe`: the row boots a registry on loopback, and core's shards grant
// no local binding (seatbelt refused the listen on macOS).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

// Windows has no shebang launch: `vx` there is a shim over `bun`.
describe.skipIf(process.platform === 'win32')('a config never installs a package', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-noinstall-'))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
    await writeFile(
      path.join(root, 'vx.config.mjs'),
      `import { x } from './helper.mjs'
export default { tasks: { a: { exec: { command: 'echo ' + x } } } }
`,
    )
    await writeFile(
      path.join(root, 'helper.mjs'),
      `import isOdd from 'is-odd'
export const x = typeof isOdd
`,
    )
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it("a helper's unprovided import is refused without asking the registry", async () => {
    const asked: string[] = []
    using registry = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        asked.push(new URL(req.url).pathname)
        return new Response('{}', { status: 404 })
      },
    })
    const url = `http://127.0.0.1:${registry.port}/`
    // The file itself, not `bun <file>`: the shebang is the launch under test.
    const p = Bun.spawn({
      cmd: [BIN, 'run', 'a'],
      cwd: root,
      env: {
        ...process.env,
        NO_COLOR: '1',
        BUN_CONFIG_REGISTRY: url,
        NPM_CONFIG_REGISTRY: url,
        BUN_INSTALL_CACHE_DIR: path.join(root, '.bun-cache'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ])
    expect(asked).toEqual([])
    expect(code).toBe(1)
    expect(out + err).toContain("cannot find 'is-odd'")
  })
})
