// vx handed the run's domain union to SRT unchecked: a URL, a dotless
// host or a bad port matched nothing, so the grant reached no host with no
// word, and `'*'`, which SRT's own schema refuses as too broad, opened
// every host to every sandboxed task of the run. Refused now; and the
// refusal, the first thrown past the Linux probe, left the runtime up, so
// the process hung after the summary (2026-10-02).
import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const available = await sandboxAvailable('sandbox network patterns test')
const TIMEOUT = 30_000

describe.skipIf(!available)('a network entry SRT does not take', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-net-pat-' }))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  /** `vx run t`, killed after 20 s: a hung process reads as `killed`. */
  const vx = async (sandbox: string) => {
    await addProject(root, 'app', {
      config: `export default { tasks: { t: { exec: { command: 'true', sandbox: ${sandbox} } } } }\n`,
    })
    const p = Bun.spawn([process.execPath, BIN, 'run', 't', '--all'], {
      cwd: root,
      env: { ...process.env, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => p.kill('SIGKILL'), 20_000)
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    clearTimeout(timer)
    const said = `${out}${err}`.split('\n').find((l) => l.includes('is not a host pattern'))
    return { code: p.signalCode === 'SIGKILL' ? 'killed' : code, said }
  }

  const refusal = (entry: string) =>
    `[vx] app#t: sandbox: ${entry} is not a host pattern: name a host ("example.com"), a ` +
    `subdomain wildcard ("*.example.com") or either with a port ("example.com:443"); no ` +
    `scheme or path, and "*" or "*.com" is refused as too broad (a bare "*" only in deny)`

  it(
    'a URL is refused, named, and the run exits',
    async () => {
      expect(await vx(`{ allow: { network: ['https://example.com', 'example.org'] } }`)).toEqual({
        code: 1,
        said: refusal('allow.network "https://example.com"'),
      })
    },
    TIMEOUT,
  )

  it(
    '"*" is refused in allow',
    async () => {
      expect(await vx(`{ allow: { network: ['*'] } }`)).toEqual({
        code: 1,
        said: refusal('allow.network "*"'),
      })
    },
    TIMEOUT,
  )

  it(
    'CONTROL: a host, a wildcard, a port, and "*" in deny run',
    async () => {
      expect(
        await vx(
          `{ allow: { network: ['example.com:443', '*.npmjs.org'] }, deny: { network: ['*:22'] } }`,
        ),
      ).toEqual({ code: 0, said: undefined })
    },
    TIMEOUT,
  )
})
