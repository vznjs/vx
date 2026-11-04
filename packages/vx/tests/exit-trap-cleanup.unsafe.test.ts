// A test script's EXIT trap cleans up and keeps the script's own status.
// Under `set -e` a trap command that fails ends the script 1: `docker rm
// -f` of a container `--rm` had already removed failed the relay's smoke
// after every test in it passed. Unsafe: it reads every package's scripts.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const repo = path.resolve(import.meta.dir, '..', '..', '..')

const scripts = [
  ...new Bun.Glob('{packages,private}/*/tests/**/*.sh').scanSync({ cwd: repo }),
].filter((rel) => !rel.includes('node_modules'))

describe('every test script with an EXIT trap', () => {
  it('finds the trapped scripts', () => {
    expect(
      scripts.filter((rel) => /^trap .* EXIT$/m.test(readFileSync(path.join(repo, rel), 'utf8')))
        .length,
    ).toBeGreaterThan(0)
  })

  for (const rel of scripts) {
    const text = readFileSync(path.join(repo, rel), 'utf8')
    const trap = /^trap '(.*)' EXIT$/m.exec(text)?.[1]
    if (trap === undefined || !/^set -e/m.test(text)) continue
    it(`${rel}: a failing cleanup step neither fails the script nor skips the next`, () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'vx-trap-'))
      const calls = path.join(dir, 'calls')
      writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\necho "$*" >> ${calls}\nexit 1\n`, {
        mode: 0o755,
      })
      // A pid no process holds: `kill` fails, as when the issuer already exited.
      const script = `set -eu\nname=c tag=t issuer=2147483646\ntrap '${trap}' EXIT\nexit 3\n`
      const run = Bun.spawnSync(['sh', '-c', script], {
        cwd: dir,
        env: { ...process.env, PATH: `${dir}:${process.env['PATH']}` },
      })
      expect(run.exitCode).toBe(3)
      const ran = readFileSync(calls, 'utf8').trim().split('\n')
      expect(ran.length).toBe((trap.match(/docker /g) ?? []).length)
    })
  }
})
