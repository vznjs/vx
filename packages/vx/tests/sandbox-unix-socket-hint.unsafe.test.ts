// A task refused a unix socket (Linux blocks socket(AF_UNIX) unless
// `allow.unixSockets` grants it) failed with only its client's own
// `Operation not permitted`, and the one hint vx added was to grant read
// of the working directory, which changed nothing (2026-11-24). With no
// path known it names how to find one, never a bare `true`: that admits
// every socket, docker.sock included.
import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox unix socket hint test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe.skipIf(!available || process.platform !== 'linux')('a refused unix socket', () => {
  let root: string
  let server: ReturnType<typeof Bun.spawn> | undefined
  beforeEach(async () => {
    root = realpathSync(await makeWorkspace({ prefix: 'vx-unix-hint-' }))
  })
  afterEach(async () => {
    server?.kill()
    await rm(root, { recursive: true, force: true })
  })

  const outcome = async (command: string, allow: string) => {
    const sock = path.join(root, 's.sock')
    server ??= Bun.spawn(['socat', `UNIX-LISTEN:${sock},fork`, 'OPEN:/dev/null'])
    for (let i = 0; i < 100 && !(await Bun.file(sock).exists()); i++) await Bun.sleep(20)
    await addProject(root, 'app', {
      config: `export default { tasks: { t: { exec: {
        command: ${JSON.stringify(command.replace('$SOCK', sock))},
        sandbox: { allow: { ${allow.includes('read:') ? '' : "read: ['.'], "}${allow} } },
      } } } }\n`,
    })
    const r = await run({ cwd: root, tasks: ['t'], log: quiet })
    return { status: r.outcomes[0]?.status, lines: r.outcomes[0]?.sandbox?.lines ?? [], sock }
  }

  it('names the path the command connects to (socat), and that grant passes', async () => {
    const cmd = 'socat -u OPEN:/dev/null UNIX-CONNECT:$SOCK'
    const refused = await outcome(cmd, '')
    expect(refused.status).toBe('failed')
    const grant = `unixSockets: [${JSON.stringify(refused.sock)}]`
    expect(refused.lines.find((l) => l.includes('unixSockets'))).toContain(`allow: { ${grant} }`)
    // Not the working directory's hint, which changed nothing.
    expect(refused.lines.join('\n')).not.toContain("read: ['.']")
    // A socket outside the project is hidden too: the next run names its read.
    const granted = await outcome(cmd, grant)
    expect(granted.lines.join('\n')).toContain("allow: { read: ['../../s.sock'] }")
    expect((await outcome(cmd, `${grant}, read: ['.', '../../s.sock']`)).status).toBe('success')
  }, 60_000)

  it('names the path a client names (Docker: dial unix <path>)', async () => {
    const refused = await outcome(
      'echo "dial unix $SOCK: socket: operation not permitted" >&2; exit 1',
      '',
    )
    expect(refused.lines.find((l) => l.includes('unixSockets'))).toContain(
      `allow: { unixSockets: [${JSON.stringify(refused.sock)}] }`,
    )
  }, 60_000)

  it('offers no bare unixSockets: true when no path is known (Python)', async () => {
    const refused = await outcome('python3 -c "import socket; socket.socket(socket.AF_UNIX)"', '')
    const line = refused.lines.find((l) => l.includes('unixSockets')) ?? ''
    expect(line).toContain("allow: { unixSockets: ['<socket path>'] }")
    expect(line).not.toContain('allow: { unixSockets: true }')
    expect(line).toContain('every socket')
    expect(line).toContain('docker.sock')
  }, 60_000)

  it('stays quiet on a refusal no socket is near (a plain failure that says unix)', async () => {
    const refused = await outcome(
      'echo "converting unix time"; echo "chmod: changing permissions of x: Operation not permitted" >&2; exit 1',
      '',
    )
    expect(refused.lines.filter((l) => l.includes('unixSockets'))).toEqual([])
  }, 60_000)
})
