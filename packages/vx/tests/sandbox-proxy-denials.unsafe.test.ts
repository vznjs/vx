// SRT's proxy records a refused connection as `deny network-outbound
// <host>:<port> (<reason>)` on both platforms, but on Linux vx read only
// the write observer's records: a task denied a host failed with its own
// `403` and no report, and one that survived the refusal passed. The line
// also lacks seatbelt's `deny(<n>)`, so `ignore.network` could not
// silence it on macOS (2026-10-02).
import { rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolveSandboxConfig } from '../src/exec/index.js'
import { refusedConnections, reportableViolations } from '../src/exec/sandbox-violations.js'
import { run } from '../src/orchestrator/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const DENY = 'deny network-outbound example.com:443 (host is not on the allow list)'

describe('refusedConnections', () => {
  it('reads the proxy records, once each, and nothing else', () => {
    const got = refusedConnections([
      'deny openat /p/x',
      DENY,
      DENY,
      'deny network-outbound b.test:80 (resolved address is denied)',
    ])
    expect(got.map((v) => [v.line, v.target, v.ignorable])).toEqual([
      [DENY, 'example.com:443', ['network']],
      ['deny network-outbound b.test:80 (resolved address is denied)', 'b.test:80', ['network']],
    ])
  })
})

describe('a proxy record in the report', () => {
  const PROJ = '/ws/p'
  const kept = (ignore?: Record<string, string[]>) =>
    reportableViolations([{ line: DENY, timestamp: new Date() }], {
      within: PROJ,
      config: resolveSandboxConfig(ignore === undefined ? {} : { ignore }, PROJ),
    }).map((v) => v.line)

  it('is silenced by ignore.network naming its host', () => {
    expect(kept({ network: ['example.com:443'] })).toEqual([])
  })

  it('CONTROL: is kept otherwise, and another list does not silence it', () => {
    expect([kept(), kept({ read: ['example.com:443'] })]).toEqual([[DENY], [DENY]])
  })

  // The proxy records the host as the client spelled it (curl sends
  // `CONNECT EXAMPLE.Com:443`, curl and Bun keep a trailing dot) and
  // matches its lists case- and dot-blind; the ignore list matched the
  // raw spelling, so a refusal the task named stayed and failed it.
  const keptLine = (line: string, network: string[]) =>
    reportableViolations([{ line, timestamp: new Date() }], {
      within: PROJ,
      config: resolveSandboxConfig({ ignore: { network } }, PROJ),
    }).map((v) => v.line)
  const deny = (target: string) => `deny network-outbound ${target} (host is not on the allow list)`

  it('is silenced whatever the case or trailing dot of either spelling', () => {
    expect([
      keptLine(deny('EXAMPLE.Com:443'), ['example.com:443']),
      keptLine(deny('example.com.:443'), ['example.com:443']),
      keptLine(DENY, ['Example.COM:443']),
      keptLine(deny('API.Example.com.:443'), ['*.example.com:443']),
    ]).toEqual([[], [], [], []])
  })

  it('CONTROL: another port or host stays', () => {
    expect([
      keptLine(deny('EXAMPLE.Com:8443'), ['example.com:443']),
      keptLine(deny('example.com.evil:443'), ['example.com:443']),
    ]).toEqual([[deny('EXAMPLE.Com:8443')], [deny('example.com.evil:443')]])
  })
})

const available = await sandboxAvailable('sandbox proxy denials test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe.skipIf(!available)('a refused connection, run for real', () => {
  let root: string
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-proxy-deny-' }))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  // Bun reads the cwd's `bunfig.toml`, so the project is granted.
  const project = (ignore: string) =>
    addProject(root, 'app', {
      config: `export default { tasks: { t: { exec: {
        command: "bun -e \\"await fetch('https://example.com').catch(() => {})\\"",
        sandbox: { allow: { read: ['.'] }${ignore} },
      } } } }\n`,
    })

  it('fails a task that survived it, naming the host', async () => {
    await project('')
    const r = await run({ cwd: root, tasks: ['t'], log: quiet })
    expect([r.outcomes[0]?.status, r.outcomes[0]?.sandboxViolationLines]).toEqual([
      'failed',
      [DENY],
    ])
  })

  it('CONTROL: ignore.network naming the host passes it', async () => {
    await project(`, ignore: { network: ['example.com:443'] }`)
    const r = await run({ cwd: root, tasks: ['t'], log: quiet })
    expect([r.outcomes[0]?.status, r.outcomes[0]?.sandboxViolationLines ?? []]).toEqual([
      'success',
      [],
    ])
  })
})
