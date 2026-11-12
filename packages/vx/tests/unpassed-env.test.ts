// A task sees only the variables `passThrough` and `define` name. A shell
// that exports `DATABASE_URL` ran `prisma migrate` under vx and got
// "Environment variable not found: DATABASE_URL", with no word on why
// (2026-11-12). A failure whose last output names a variable vx holds and
// the task does not now says so, by name only.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { unpassedEnv } from '../src/orchestrator/shell-verdict.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const LINE = (names: string, one: boolean): string =>
  `[vx] ${names} ${one ? 'is' : 'are'} set in your environment, but this task does not get ` +
  `${one ? 'it' : 'them'}: a task sees only the variables exec.env.passThrough and define name — add ` +
  `${one ? 'it' : 'them'} to passThrough, and to inputs.env if the output depends on ${one ? 'it' : 'them'}`

describe('unpassedEnv', () => {
  const host = {
    DATABASE_URL: 'postgres://secret',
    API_KEY: 'k',
    PATH: '/bin',
    lower_case: 'x',
    ABC: '1',
  }

  it('names a variable the output names, the host holds and the task lacks', () => {
    expect(unpassedEnv('Error: missing DATABASE_URL.\n', { PATH: '/bin' }, host)).toBe(
      LINE('DATABASE_URL', true),
    )
  })

  it('names several, sorted, and never a value', () => {
    const line = unpassedEnv('need $DATABASE_URL and API_KEY=', { PATH: '/bin' }, host)
    expect(line).toBe(LINE('API_KEY, DATABASE_URL', false))
    expect(line).not.toContain('postgres')
  })

  it.each([
    ['one the task was given', 'missing DATABASE_URL', { DATABASE_URL: 'x' }],
    ['one the host does not hold', 'missing REDIS_URL', {}],
    ['a part of a longer word', 'MY_DATABASE_URL_2 and xDATABASE_URL', {}],
    ['a short or lower-case name', 'ABC lower_case', {}],
    ['an inherited property name', 'constructor TOSTRING', {}],
  ])('says nothing of %s', (_what, tail, given) => {
    expect(unpassedEnv(tail, given, host)).toBeUndefined()
  })
})

describe('a failed task whose output names a variable it was not given', () => {
  const made: string[] = []
  afterEach(async () => {
    for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
  })

  function vx(cwd: string, env: Record<string, string>): { code: number; text: string } {
    const p = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'run', 't', '--all'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1', CI: '', ...env },
    })
    return {
      code: p.exitCode ?? 1,
      text: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
    }
  }

  async function workspace(passThrough: string): Promise<string> {
    const root = await makeWorkspace({ prefix: 'vx-unpassed-env-' })
    made.push(root)
    await addProject(root, 'app', {
      config: `export default { tasks: { t: { exec: {
        command: 'test -n "$VX_TEST_DB_URL" || { echo "not found: VX_TEST_DB_URL" >&2; exit 1; }',
        env: { passThrough: ${passThrough} },
      } } } }\n`,
    })
    return root
  }

  it('is told the variable is set but not passed', async () => {
    const r = vx(await workspace('[]'), { VX_TEST_DB_URL: 'postgres://secret' })
    expect(r.code).toBe(1)
    expect(r.text).toContain(LINE('VX_TEST_DB_URL', true))
    expect(r.text).not.toContain('postgres://secret')
  }, 30_000)

  it('gets no line once the variable is passed, or when the shell lacks it too', async () => {
    const passed = vx(await workspace("['VX_TEST_DB_URL']"), { VX_TEST_DB_URL: 'x' })
    expect([passed.code, passed.text.includes('set in your environment')]).toEqual([0, false])
    const absent = vx(await workspace('[]'), {})
    expect([absent.code, absent.text.includes('set in your environment')]).toEqual([1, false])
  }, 30_000)
})
