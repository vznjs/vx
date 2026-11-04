import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sandboxAvailable, sandboxed } from '../src/sandbox.ts'

// The suite's claim that no tool escapes its case rests on these.
describe.skipIf(!sandboxAvailable() && !process.env['VX_REQUIRE_SANDBOX'])('sandbox', () => {
  let root: string
  let outside: string
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'conf-sbx-')))
    outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'conf-out-')))
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  const sh = (script: string) => sandboxed(root, root, ['sh', '-c', script], {})

  test('the case directory is writable', async () => {
    expect((await sh('echo hi > inside && cat inside')).out).toBe('hi\n')
  })

  test('nothing outside the case directory is', async () => {
    const r = await sh(`echo x > ${outside}/escaped`)
    expect(r.exit).not.toBe(0)
    expect(Bun.file(path.join(outside, 'escaped')).size).toBe(0)
  })

  test('the real home is not the home a tool sees', async () => {
    expect((await sh('echo $HOME')).out.trim()).toBe(path.join(root, '.home'))
  })

  test('a host file stays unwritable through an absolute path', async () => {
    writeFileSync(path.join(outside, 'f'), 'kept')
    await sh(`echo changed > ${outside}/f`)
    expect(await Bun.file(path.join(outside, 'f')).text()).toBe('kept')
  })

  test('there is no network', async () => {
    const r = await sh('bun -e "await fetch(\'https://registry.npmjs.org\')"')
    expect(r.exit).not.toBe(0)
  })

  test('a process left in the background dies with the run', async () => {
    const r = await sh('(sleep 30; echo late > late) >/dev/null 2>&1 & echo $!')
    expect(r.exit).toBe(0)
    await Bun.sleep(200)
    expect(Bun.spawnSync(['pgrep', '-f', 'sleep 30; echo late']).exitCode).toBe(1)
  })
})
