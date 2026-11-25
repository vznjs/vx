// A task sees only the variables `passThrough` and `define` name. A shell
// that exports `DATABASE_URL` ran `prisma migrate` under vx and got
// "Environment variable not found: DATABASE_URL", with no word on why
// (2026-11-12). A failure whose last output names a variable vx holds and
// the task does not now says so, by name only.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { unpassedEnv } from '../src/orchestrator/shell-verdict.js'
import { SANDBOX_SET_ENV } from '../src/sandbox/session.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const LINE = (names: string, one: boolean): string =>
  `[vx] ${names} ${one ? 'is' : 'are'} set in your environment, but this task does not get ` +
  `${one ? 'it' : 'them'}: a task sees only the variables inputs.env, exec.env.passThrough and define name — add ` +
  `${one ? 'it' : 'them'} to inputs.env if the output depends on ${one ? 'it' : 'them'}, else to passThrough`

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

  // `curl -H "Authorization: $API_TOKEN" …` fails on an empty header and
  // prints nothing that names it: the command does.
  it('names a variable the command expands, though the output does not', () => {
    expect(
      unpassedEnv('exit 1\n', { PATH: '/bin' }, host, 'deploy --db "${DATABASE_URL}" $API_KEY'),
    ).toBe(LINE('API_KEY, DATABASE_URL', false))
  })

  it('reads no name from the command that the shell sets itself', () => {
    expect(
      unpassedEnv('', {}, { OLDPWD: '/', HOSTNAME: 'h' }, 'cd $OLDPWD && echo $HOSTNAME'),
    ).toBeUndefined()
  })

  // The sandbox sets its own proxy variables over the task's, so a
  // passThrough of one never arrives: a sandboxed task that printed
  // HTTPS_PROXY was told to pass it through (2026-11-24).
  it('names none the sandbox sets over the task, for a sandboxed task', () => {
    const proxy = { HTTPS_PROXY: 'http://corp:3128', DATABASE_URL: 'x' }
    expect(unpassedEnv('HTTPS_PROXY refused', {}, proxy, '', true)).toBeUndefined()
    expect(unpassedEnv('HTTPS_PROXY and DATABASE_URL', {}, proxy, '', true)).toBe(
      LINE('DATABASE_URL', true),
    )
    expect(unpassedEnv('HTTPS_PROXY refused', {}, proxy)).toBe(LINE('HTTPS_PROXY', true))
  })

  it("holds the sandbox's names to the ones the runtime sets", async () => {
    const srt = await import('@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js')
    const set = srt
      .generateProxyEnvVars(3128, 3128, undefined, 'token', false, 'cmd')
      .map((v: string) => v.split('=')[0]!)
      .filter((n: string) => /^[A-Z][A-Z0-9_]{3,}$/.test(n))
    // bwrap sets these two itself (linux-sandbox-utils.js); vx repairs
    // JAVA_TOOL_OPTIONS so the task's own value arrives.
    set.push('CLAUDE_CODE_HOST_HTTP_PROXY_PORT', 'CLAUDE_CODE_HOST_SOCKS_PROXY_PORT')
    expect([...SANDBOX_SET_ENV].sort()).toEqual([...new Set(set)].sort())
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
