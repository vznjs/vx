import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sandboxAvailable, sandboxed } from '../src/sandbox.ts'

const SUPERVISE = path.join(import.meta.dir, '..', 'src', 'supervise.ts')

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
  const sh = (script: string) => sandboxed(root, root, ['sh', '-c', script], {}, {})

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

  // Run as a user other than root, a root-owned `/` would read as nobody's
  // (65534) through bwrap's user namespace: Nx 24.0.6 then refuses its daemon.
  test("the root directory is not shown as nobody's", async () => {
    expect((await sh('stat -c %u /')).out.trim()).not.toBe('65534')
  })

  test('nothing can be made at the root', async () => {
    expect((await sh('touch /escaped')).exit).not.toBe(0)
  })

  test('there is no network', async () => {
    const r = await sh('bun -e "await fetch(\'https://registry.npmjs.org\')"')
    expect(r.exit).not.toBe(0)
  })

  // A sandbox case shares the host's /proc: every process of the machine
  // was "left running", and one the run left without its tag (a tool's
  // sandbox clears the environment) was found by nothing but the subreaper.
  test('on the host’s /proc, what a run left behind is its own processes only', async () => {
    const left = async (script: string) => {
      const argv = [
        process.execPath,
        SUPERVISE,
        JSON.stringify({ left: '.left' }),
        'sh',
        '-c',
        script,
      ]
      expect((await sandboxed(root, root, argv, {}, { hostProc: true })).exit).toBe(0)
      return JSON.parse(readFileSync(path.join(root, '.left'), 'utf8')) as string[]
    }
    expect(await left('true')).toEqual([])
    expect(await left("(env -i setsid sh -c 'sleep 36' >/dev/null 2>&1 &) ; sleep 0.3")).toContain(
      'sleep 36',
    )
  })

  test('a process left in the background dies with the run', async () => {
    const r = await sh('(sleep 30; echo late > late) >/dev/null 2>&1 & echo $!')
    expect(r.exit).toBe(0)
    await Bun.sleep(200)
    expect(Bun.spawnSync(['pgrep', '-f', 'sleep 30; echo late']).exitCode).toBe(1)
  })
})

// A tool that isolates its own work (Nix's build sandbox) runs outside
// bubblewrap: it still gets the case's home, and nothing it starts outlives
// the run or its time limit.
describe('unboxed', () => {
  let root: string
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'conf-unboxed-')))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const sh = (script: string, timeoutMs?: number) =>
    sandboxed(
      root,
      root,
      ['sh', '-c', script],
      {},
      {
        boxed: false,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
    )

  test('the home and the temporary directory are the case’s', async () => {
    const home = path.join(root, '.home')
    expect((await sh('echo "$HOME $TMPDIR"')).out.trim()).toBe(`${home} ${path.join(home, 'tmp')}`)
  })

  test('a process left in the background dies with the run', async () => {
    const r = await sh('(sleep 31; echo late > late) >/dev/null 2>&1 & echo $!')
    expect(r.exit).toBe(0)
    await Bun.sleep(200)
    expect(Bun.spawnSync(['pgrep', '-f', 'sleep 31; echo late']).exitCode).toBe(1)
  })

  test('a process that leaves the run’s session still dies with it', async () => {
    expect((await sh("setsid sh -c 'sleep 34' >/dev/null 2>&1 & sleep 0.3")).exit).toBe(0)
    await Bun.sleep(200)
    expect(Bun.spawnSync(['pgrep', '-x', '-f', 'sleep 34']).exitCode).toBe(1)
  })

  test('what a run left behind is its own processes, never the host’s', async () => {
    const left = async (script: string) => {
      const argv = [
        process.execPath,
        SUPERVISE,
        JSON.stringify({ left: '.left' }),
        'sh',
        '-c',
        script,
      ]
      expect((await sandboxed(root, root, argv, {}, { boxed: false })).exit).toBe(0)
      return JSON.parse(readFileSync(path.join(root, '.left'), 'utf8')) as string[]
    }
    expect(await left('true')).toEqual([])
    expect(await left("setsid sh -c 'sleep 35' >/dev/null 2>&1 & sleep 0.3")).toContain('sleep 35')
  })

  test('a run past its time limit is killed with what it started', async () => {
    const r = await sh('sleep 32 & sleep 33', 300)
    expect(r.timedOut).toBe(true)
    await Bun.sleep(200)
    expect(Bun.spawnSync(['pgrep', '-f', 'sleep 3[23]']).exitCode).toBe(1)
  })
})
