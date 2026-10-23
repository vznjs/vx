// Sandbox-runtime tests: port bridges, signals and the runtime lifecycle.
//
// These tests are gated on SRT's runtime deps (bwrap on Linux,
// sandbox-exec on macOS). CI installs bubblewrap + socat + strace,
// disables AppArmor's unprivileged-userns restriction, and sets
// VX_REQUIRE_SANDBOX — so an unavailable runtime FAILS there rather than
// skipping, because a skipped suite reports green and this one covers
// the isolation boundary. A local host without the deps still skips.

import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { freePort } from './helpers/free-port.js'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import {
  initSandbox,
  probeSandbox,
  resetSandbox,
  resolveSandboxConfig,
  wrapSandboxedCommand,
} from '../src/exec/sandbox-runtime.js'
import { buildCustomConfig, punchWritePaths } from '../src/exec/sandbox-binds.js'
import {
  bridgedPorts,
  portBridgeHostArgv,
  portBridgeInner,
  portBridgeSocket,
} from '../src/exec/sandbox-runtime.js'
import { localBindingOn } from '../src/exec/sandbox-paths.js'
import { run } from './helpers/orchestrator.js'
import { isAlive, waitForDead } from './helpers/alive.js'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { validateProjectConfig } from '../src/workspace/index.js'
import { prepareSandbox } from '../src/orchestrator/sandbox-request.js'
import type { TaskNode } from '../src/graph/index.js'
import {
  TIMEOUT,
  type Fixture,
  expectOk,
  taskRoot,
  collectingLogger,
  makeWorkspace,
} from './helpers/sandbox-fixture.js'

const available = await sandboxAvailable('sandbox-runtime tests')

/**
 * Item 652: the probe's own gates, driven through the runtime's wrapper.
 * On a host where the secure sandbox works, a probe that ignored the
 * wrapper's exit, swallowed nothing, forgot the weaker mode or never
 * memoized answers exactly what the real one does — so the rows below
 * hand it a wrapper that fails, and count what it asked for.
 */
describe.skipIf(!available || process.platform !== 'linux')(
  'the probe, through its wrapper',
  () => {
    afterEach(async () => {
      await resetSandbox()
    })

    it('is memoized per mode, and the weaker mode asks for the weaker wrapper', async () => {
      await resetSandbox()
      const spy = spyOn(SandboxManager, 'wrapWithSandbox')
      try {
        const secure = await probeSandbox()
        const again = await probeSandbox()
        const weaker = await probeSandbox({ weakerNested: true })
        expect(again).toBe(secure)
        expect(weaker).not.toBe(secure)
        expect(spy.mock.calls.map((c) => c[2])).toEqual([
          undefined,
          { enableWeakerNestedSandbox: true },
        ])
      } finally {
        spy.mockRestore()
      }
    })

    it('a wrapper that exits non-zero, or throws, is an unavailable verdict', async () => {
      await resetSandbox()
      const spy = spyOn(SandboxManager, 'wrapWithSandbox').mockImplementation(
        async () => 'echo nope >&2; exit 3',
      )
      try {
        expect(await probeSandbox()).toEqual({
          available: false,
          reason: 'a sandboxed `true` failed (exit 3): nope',
        })
        await resetSandbox()
        spy.mockImplementation(async () => {
          throw new Error('boom')
        })
        expect(await probeSandbox()).toEqual({
          available: false,
          reason: 'sandbox probe threw: boom',
        })
      } finally {
        spy.mockRestore()
      }
    })
  },
)

describe.skipIf(process.platform !== 'linux')(
  'punchWritePaths — a read grant is never an ancestor of a write grant (linux)',
  () => {
    // bwrap emits `--bind <out>` then `--ro-bind <readPath>`; when the read
    // path is an ANCESTOR the read-only mount lands on top and every write
    // fails with `Read-only file system` (verified in a Linux container,
    // 2026-09-05: read=[proj] write=[proj/dist] → mkdir fails; read=[proj/src]
    // → ok). Expanding the ancestor into its children fixes it.
    let dir: string

    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'vx-punch-'))
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await mkdir(path.join(dir, 'dist'), { recursive: true })
      await mkdir(path.join(dir, 'nested', 'deep'), { recursive: true })
      await writeFile(path.join(dir, 'package.json'), '{}')
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('returns the grant untouched when no write path is under it', () => {
      expect(punchWritePaths(dir, [])).toEqual([dir])
      expect(punchWritePaths(dir, ['/elsewhere/out'])).toEqual([dir])
      // a write path EQUAL to the grant is not an ancestor relationship
      expect(punchWritePaths(dir, [dir])).toEqual([dir])
    })

    it("a SIBLING sharing the grant's name prefix is not under it", () => {
      // `under` tests `startsWith(readPath + path.sep)`. Without the
      // separator, a write grant on `<dir>-out` counts as being inside
      // `<dir>` and punches it apart — the read grant loses the directory
      // ENTRY, which is what makes a command that stats its own cwd die
      // (`bun build`, per the note above). The existing row above uses an
      // unrelated absolute path, which fails `startsWith` outright and so
      // never reaches this cut.
      const sibling = `${dir}-out`
      expect(punchWritePaths(dir, [sibling])).toEqual([dir])
      // CONTROL, on its own path: a write grant genuinely under the grant
      // still punches, so the row above is the SEPARATOR's doing and not a
      // punch that stopped working.
      expect(punchWritePaths(dir, [path.join(dir, 'dist')])).not.toEqual([dir])
    })

    it('passes a glob-shaped write grant to SRT as written', () => {
      // A file-shaped grant is widened to its directory because bwrap
      // cannot rename onto an active mount point. A GLOB is neither a file
      // nor a directory: `statSync` throws on it, so without the glob
      // check it falls through to `path.dirname` and the pattern the user
      // wrote is replaced by a plain directory.
      const write = (grants: string[]): string[] => {
        const c = buildCustomConfig(
          { config: { allowRead: [], allowWrite: grants, ignore: undefined } as never },
          { allowRead: [], denyRead: [] },
        ) as { filesystem?: { allowWrite?: string[] } }
        return c.filesystem?.allowWrite ?? []
      }
      expect(write([path.join(dir, 'dist', '**')])).toEqual([path.join(dir, 'dist', '**')])
      // CONTROLS on their own grants: a directory stays exact, and a FILE
      // is still widened to its directory — so the row above is the glob
      // branch and not a widening that stopped happening.
      expect(write([path.join(dir, 'dist')])).toEqual([path.join(dir, 'dist')])
      expect(write([path.join(dir, 'dist', 'out.bin')])).toEqual([path.join(dir, 'dist')])
    })

    it('replaces the ancestor with its children, dropping the write path', () => {
      const got = punchWritePaths(dir, [path.join(dir, 'dist')]).sort()
      expect(got).toEqual(
        [path.join(dir, 'src'), path.join(dir, 'nested'), path.join(dir, 'package.json')].sort(),
      )
    })

    it('recurses only along the branch that contains a write path', () => {
      const deepOut = path.join(dir, 'nested', 'deep')
      const got = punchWritePaths(dir, [deepOut])
      // `nested` is expanded because the write path is under it; `src` and
      // `package.json` are handed over whole.
      expect(got).toContain(path.join(dir, 'src'))
      expect(got).toContain(path.join(dir, 'package.json'))
      expect(got).not.toContain(path.join(dir, 'nested'))
      expect(got).not.toContain(deepOut)
    })

    it('names the symlinked entries a punch would flatten, once per grant', async () => {
      // The one diagnostic for a failure with no other symptom. bwrap
      // resolves a bind SOURCE, so punching a directory mounts each
      // symlinked child as the directory it points AT — inside the
      // sandbox the link is gone, and a package resolved through it
      // loses the siblings its own dependencies need. That cost four
      // days of red CI (astro / `yargs-parser`, 2026-09-09) and SRT's
      // config carries no `--symlink`, so the warning IS the fix: it
      // says which grant to move. Silencing it breaks nothing else in
      // the repo, which is why this row exists.
      await symlink(path.join(dir, 'src'), path.join(dir, 'linked'))
      const written: string[] = []
      const real = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: unknown): boolean => {
        written.push(String(chunk))
        return true
      }) as typeof process.stderr.write
      try {
        punchWritePaths(dir, [path.join(dir, 'dist')])
        // Once per grant: a second punch of the same read path is silent,
        // so a thousand-task run says it once.
        punchWritePaths(dir, [path.join(dir, 'dist')])
      } finally {
        process.stderr.write = real
      }
      const notices = written.filter((w) => w.includes('symlinked'))
      expect(notices).toHaveLength(1)
      // It has to name BOTH halves to be actionable: what got flattened
      // and which grant to move.
      expect(notices[0]).toContain('linked')
      expect(notices[0]).toContain('dist')
    })

    // Item 652: the row above has a symlink in every punch it makes, so the
    // notice could lose its `linked.length > 0` gate — and tell every
    // punched grant it flattened "0 symlinked entries" — with the suite
    // green.
    it('says nothing when the punched directory holds no symlink', async () => {
      const written: string[] = []
      const real = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: unknown): boolean => {
        written.push(String(chunk))
        return true
      }) as typeof process.stderr.write
      try {
        punchWritePaths(dir, [path.join(dir, 'dist')])
        // CONTROL, on a directory of its own: one symlink there is named.
        await symlink(path.join(dir, 'src'), path.join(dir, 'nested', 'linked'))
        punchWritePaths(path.join(dir, 'nested'), [path.join(dir, 'nested', 'deep')])
      } finally {
        process.stderr.write = real
      }
      const notices = written.filter((w) => w.includes('symlinked'))
      expect(notices.map((n) => n.includes(`under ${path.join(dir, 'nested')} `))).toEqual([true])
    })

    // Item 652: two file-shaped grants in one directory both widen to it.
    // The rows above widen one file at a time, so the dedup after the
    // widening could go and SRT would be handed the directory twice.
    it('two file grants in one directory widen to that directory once', () => {
      const c = buildCustomConfig(
        {
          config: {
            allowRead: [],
            allowWrite: [path.join(dir, 'dist', 'a.bin'), path.join(dir, 'dist', 'b.bin')],
          } as never,
        },
        { allowRead: [], denyRead: [] },
      ) as { filesystem?: { allowWrite?: string[] } }
      expect(c.filesystem?.allowWrite).toEqual([path.join(dir, 'dist')])
    })

    it('hands over a path it cannot read rather than dropping the grant', () => {
      const missing = path.join(dir, 'does-not-exist')
      expect(punchWritePaths(missing, [path.join(missing, 'out')])).toEqual([missing])
    })
  },
)

/**
 * Item 652: every capability the resolved config carries reaches SRT's
 * per-task config as SRT's own field. No row read this object, so each of
 * the eleven hand-offs below could be deleted with the whole suite green:
 * the sandboxed rows that declare a capability either run where it cannot
 * be observed (no network in CI's sandbox, no macOS rules on Linux) or
 * declare one SRT reads off `initialize()` instead. Each row names the
 * field, the value vx was handed and the value SRT must receive — written
 * out, not derived from `buildCustomConfig`.
 */
describe('buildCustomConfig hands each capability to SRT', () => {
  const custom = (extra: Record<string, unknown>): Record<string, unknown> =>
    buildCustomConfig(
      { config: { allowRead: [], allowWrite: [], ...extra } as never },
      { allowRead: [], denyRead: [] },
    ) as Record<string, unknown>
  const at = (o: Record<string, unknown>, keys: string[]): unknown =>
    keys.reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], o)

  const ROWS: Array<[string, Record<string, unknown>, string[], unknown]> = [
    ['network: true is every domain', { network: true }, ['network', 'allowedDomains'], ['*']],
    [
      'a domain list is that list',
      { network: ['a.test', 'b.test'] },
      ['network', 'allowedDomains'],
      ['a.test', 'b.test'],
    ],
    ['no network is none', {}, ['network', 'allowedDomains'], []],
    ['deny.network', { denyNetwork: ['c.test'] }, ['network', 'deniedDomains'], ['c.test']],
    ['unixSockets: true', { unixSockets: true }, ['network', 'allowAllUnixSockets'], true],
    [
      'a unixSockets list',
      { unixSockets: ['/s.sock'] },
      ['network', 'allowUnixSockets'],
      ['/s.sock'],
    ],
    ['localBinding', { localBinding: true }, ['network', 'allowLocalBinding'], true],
    ['machLookup', { machLookup: ['com.x'] }, ['network', 'allowMachLookup'], ['com.x']],
    ['gitConfig', { gitConfig: true }, ['filesystem', 'allowGitConfig'], true],
    ['pty', { pty: true }, ['allowPty'], true],
    ['weakerWhenNested', { weakerWhenNested: true }, ['enableWeakerNestedSandbox'], true],
    [
      'weakerNetworkIsolation',
      { weakerNetworkIsolation: true },
      ['enableWeakerNetworkIsolation'],
      true,
    ],
  ]
  for (const [what, extra, keys, want] of ROWS) {
    it(`${what} → ${keys.join('.')}`, () => {
      expect(at(custom(extra), keys)).toEqual(want)
      // CONTROL: undeclared, the field is not invented (the domain lists
      // are always present, empty, because SRT insists on both).
      if (keys[0] !== 'network' || !keys[1]!.endsWith('Domains')) {
        expect(at(custom({}), keys)).toBeUndefined()
      }
    })
  }
})

describe('localBinding accepts a boolean or a port list', () => {
  const cfg = (localBinding: unknown) => ({
    tasks: { t: { exec: { command: 'true', sandbox: { allow: { localBinding } } } } },
  })
  const where = 'x'
  it('accepts true, false and a non-empty list of TCP ports', () => {
    for (const v of [true, false, [3000], [1, 65535, 8080]]) {
      expect(() => validateProjectConfig(cfg(v) as never, where)).not.toThrow()
    }
  })
  it('refuses an empty list, a non-integer, an out-of-range port and a string', () => {
    for (const v of [[], [0], [65536], [3000.5], ['3000'], 'true', 3000]) {
      expect(() => validateProjectConfig(cfg(v) as never, where)).toThrow(
        /localBinding must be a boolean or a non-empty list of ports/,
      )
    }
  })
})

describe('localBinding port list — the pure halves', () => {
  // Item 652: the bridge's socket lives in SRT's temp directory, resolved
  // exactly as SRT resolves it. No row set the variables, so an EMPTY
  // `CLAUDE_CODE_TMPDIR` (a socket at `/vx-port-…`, the filesystem root)
  // and the older `CLAUDE_TMPDIR` spelling were both unheld.
  it('the socket directory follows SRT: an empty variable is unset, and the older name counts', () => {
    const saved = [process.env['CLAUDE_CODE_TMPDIR'], process.env['CLAUDE_TMPDIR']]
    const set = (k: string, v: string | undefined): void => {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      set('CLAUDE_CODE_TMPDIR', '')
      set('CLAUDE_TMPDIR', undefined)
      expect(portBridgeSocket('t', 1)).toBe(
        `/tmp/claude/vx-tasks/vx-task-${process.pid}-t/vx-port-t-1.sock`,
      )
      set('CLAUDE_CODE_TMPDIR', undefined)
      set('CLAUDE_TMPDIR', '/legacy')
      expect(portBridgeSocket('t', 1)).toBe(
        `/legacy/vx-tasks/vx-task-${process.pid}-t/vx-port-t-1.sock`,
      )
      // CONTROL: the current name wins over the older one.
      set('CLAUDE_CODE_TMPDIR', '/current')
      expect(portBridgeSocket('t', 1)).toBe(
        `/current/vx-tasks/vx-task-${process.pid}-t/vx-port-t-1.sock`,
      )
    } finally {
      set('CLAUDE_CODE_TMPDIR', saved[0])
      set('CLAUDE_TMPDIR', saved[1])
    }
  })

  it('a list grants loopback like `true`; an empty list and `false` do not', () => {
    expect(localBindingOn({ localBinding: true })).toBe(true)
    expect(localBindingOn({ localBinding: [3000] })).toBe(true)
    expect(localBindingOn({ localBinding: [] })).toBe(false)
    expect(localBindingOn({ localBinding: false })).toBe(false)
    expect(localBindingOn({})).toBe(false)
  })

  it('bridges the listed ports once each; `true` bridges nothing', () => {
    expect(bridgedPorts({ localBinding: [3000, 3001, 3000] })).toEqual([3000, 3001])
    expect(bridgedPorts({ localBinding: true })).toEqual([])
    expect(bridgedPorts({})).toEqual([])
  })

  it("the task's side listens on the unix socket and relays into loopback; the host's side the reverse, with a retry", () => {
    const sock = portBridgeSocket('t1', 3000)
    expect(sock.endsWith('/vx-port-t1-3000.sock')).toBe(true)
    const inner = portBridgeInner([3000, 3001], 't1')
    const dial = path.join(path.dirname(sock), 'vx-port-dial-t1.sh')
    expect(inner).toContain(
      `socat UNIX-LISTEN:${sock},fork,unlink-early 'SYSTEM:sh ${dial} 3000' >/dev/null 2>&1 &`,
    )
    expect(inner).toContain(`'SYSTEM:sh ${dial} 3001'`)
    // Backgrounded socats are reaped with the shell, as SRT reaps its own.
    expect(inner.endsWith("trap 'kill $(jobs -p) 2>/dev/null' EXIT;")).toBe(true)
    expect(portBridgeHostArgv('t1', 3000)).toEqual([
      'socat',
      'TCP-LISTEN:3000,bind=127.0.0.1,fork,reuseaddr',
      `UNIX-CONNECT:${sock},retry=40,interval=0.25`,
    ])
  })
})

describe.skipIf(!available || process.platform !== 'linux')(
  'a sandboxed task exposes a port on Linux (localBinding port list)',
  () => {
    let fixture: Fixture
    beforeEach(async () => {
      fixture = await makeWorkspace()
    })
    afterEach(async () => {
      await rm(fixture.root, { recursive: true, force: true })
    })

    /** A port nothing on this box listens on: bind it, read it, release it. */
    function ipv6Loopback(): boolean {
      try {
        Bun.listen({ hostname: '::1', port: 0, socket: { data() {} } }).stop(true)
        return true
      } catch {
        return false
      }
    }

    const files = (port: number, hostname = '127.0.0.1') => ({
      'serve.ts':
        `Bun.serve({ port: ${port}, hostname: '${hostname}', fetch: () => new Response('hi') })\n` +
        `console.log('serving')\n`,
      'client.ts':
        `const r = await fetch('http://127.0.0.1:${port}/')\n` +
        `await Bun.write('out.txt', await r.text())\n`,
    })
    const serverConfig = (localBinding: string): string => `
      export default {
        tasks: {
          serve: {
            exec: {
              command: 'bun serve.ts',
              persistent: { readyWhen: 'serving' },
              sandbox: { allow: { read: ['.'], localBinding: ${localBinding} } },
            },
          },
          // NOT sandboxed: the host's loopback is what a developer's browser
          // or a sibling task sees, and that is the claim.
          client: {
            dependsOn: ['serve'],
            exec: { command: 'bun client.ts' },
          },
        },
      }
    `

    /** Does anything on the host accept a connection on `port`? */
    function accepts(port: number): Promise<boolean> {
      return new Promise((resolve) => {
        const sock = createConnection({ host: '127.0.0.1', port })
        sock.once('connect', () => {
          sock.destroy()
          resolve(true)
        })
        sock.once('error', () => resolve(false))
      })
    }

    it(
      'a kill -9 of vx takes the host side of a port bridge with it',
      async () => {
        // The host socat was a plain child of vx, in no group the guard
        // lists (kill-tree.ts): a `kill -9` of vx left it listening on the
        // port under init, and the next run's bridge could not bind it
        // (item 873). It is spawned guarded now.
        const port = freePort()
        await addProject(fixture.root, 'srv', {
          files: files(port),
          config: serverConfig(`[${port}]`),
        })
        const proc = Bun.spawn(
          [
            process.execPath,
            path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts'),
            'run',
            'serve',
            '--all',
          ],
          { cwd: fixture.root, env: { ...process.env }, stdout: 'ignore', stderr: 'ignore' },
        )
        // A failed positive below must not leave vx behind: it holds its
        // server in the foreground forever, and sixteen such runs sat under
        // init with their sandboxes (item 883).
        try {
          const deadline = Date.now() + 20_000
          while (!(await accepts(port)) && Date.now() < deadline) await Bun.sleep(50)
          // The positive first: the bridge was up while vx ran.
          expect(await accepts(port)).toBe(true)
        } finally {
          process.kill(proc.pid, 'SIGKILL')
        }
        expect(await proc.exited).toBe(137)
        const until = Date.now() + 3_000
        while ((await accepts(port)) && Date.now() < until) await Bun.sleep(50)
        const left = await accepts(port)
        if (left) {
          // Leave no socat behind for the rest of the suite.
          for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
            try {
              if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(`TCP-LISTEN:${port},`)) {
                process.kill(Number(pid), 'SIGKILL')
              }
            } catch {
              // gone
            }
          }
        }
        expect(left).toBe(false)
      },
      TIMEOUT,
    )

    it(
      'a listed port is reachable from outside the sandbox while the server runs, and closed after the run',
      async () => {
        const port = freePort()
        await addProject(fixture.root, 'srv', {
          files: files(port),
          config: serverConfig(`[${port}]`),
        })
        const r = await run({
          cwd: fixture.root,
          tasks: ['client'],
          log: collectingLogger(fixture),
        })
        expectOk(r, fixture)
        expect(await readFile(path.join(fixture.root, 'packages', 'srv', 'out.txt'), 'utf8')).toBe(
          'hi',
        )
        // The bridge lives exactly as long as the server: the run tore the
        // server down, so the host's side is gone and the port is closed.
        await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
      },
      TIMEOUT,
    )

    // A box with no IPv6 has no ::1 to bind; the dial choice is then held
    // by port-bridge-dial.test.ts alone (X-91).
    it.skipIf(!ipv6Loopback())(
      'a server bound to ::1 alone is reachable through the bridge',
      async () => {
        // The task's side dialled 127.0.0.1 only, so Vite's `localhost` on
        // a host that resolves ::1 first was refused.
        const port = freePort()
        await addProject(fixture.root, 'srv', {
          files: files(port, '::1'),
          config: serverConfig(`[${port}]`),
        })
        const r = await run({
          cwd: fixture.root,
          tasks: ['client'],
          log: collectingLogger(fixture),
        })
        expectOk(r, fixture)
        expect(await readFile(path.join(fixture.root, 'packages', 'srv', 'out.txt'), 'utf8')).toBe(
          'hi',
        )
      },
      TIMEOUT,
    )

    it(
      'a held server keeps its port through its run’s reset and a later run’s, until it is stopped',
      async () => {
        // Each run resets the sandbox at its end, and that reset released
        // every host bridge: a server held past its run (a foreground
        // `vx run dev`, `vx watch`) lost its port ~40 ms after the
        // summary (item 882). The later run is a watch cycle's.
        const port = freePort()
        await addProject(fixture.root, 'srv', {
          files: files(port),
          config: serverConfig(`[${port}]`),
        })
        await addProject(fixture.root, 'other', {
          config: `export default { tasks: { t: { exec: { command: 'true', sandbox: { allow: { read: ['.'] } } } } } }`,
        })
        const reset = spyOn(SandboxManager, 'reset')
        // Restored whatever fails: a red here left the spy on SRT's reset
        // for every later row of the file (M-22).
        try {
          const held = await run({
            cwd: fixture.root,
            tasks: ['srv#serve'],
            holdPersistent: true,
            log: collectingLogger(fixture),
          })
          try {
            expect(held.persistent?.ids).toEqual(['srv#serve'])
            expect(await accepts(port)).toBe(true)
            const later = await run({
              cwd: fixture.root,
              tasks: ['other#t'],
              log: collectingLogger(fixture),
            })
            expectOk(later, fixture)
            expect(await accepts(port)).toBe(true)
            // Both runs' resets waited on the server.
            expect(reset).toHaveBeenCalledTimes(0)
          } finally {
            await held.persistent?.stop('SIGTERM')
          }
          const until = Date.now() + 3_000
          while ((await accepts(port)) && Date.now() < until) await Bun.sleep(50)
          expect(await accepts(port)).toBe(false)
          // The server's exit ran the reset they deferred.
          while (reset.mock.calls.length === 0 && Date.now() < until) await Bun.sleep(20)
          expect(reset).toHaveBeenCalledTimes(1)
        } finally {
          reset.mockRestore()
        }
      },
      TIMEOUT,
    )

    it(
      'the next run’s sandbox starts after the reset a stopped server deferred, never under it',
      async () => {
        // A watch cycle stops the held server and starts its run at once.
        // The server's exit runs the deferred reset unawaited, so the new
        // run's `initSandbox` found SRT still up and hot-reloaded it, and
        // the reset landing after tore it down under the cycle (item
        // 884). The reset is held 300 ms so the order is the claim.
        const port = freePort()
        await addProject(fixture.root, 'srv', {
          files: files(port),
          config: serverConfig(`[${port}]`),
        })
        await addProject(fixture.root, 'other', {
          config: `export default { tasks: { t: { exec: { command: 'true', sandbox: { allow: { read: ['.'] } } } } } }`,
        })
        const held = await run({
          cwd: fixture.root,
          tasks: ['srv#serve'],
          holdPersistent: true,
          log: collectingLogger(fixture),
        })
        const order: string[] = []
        const realReset = SandboxManager.reset.bind(SandboxManager)
        const reset = spyOn(SandboxManager, 'reset').mockImplementation(async () => {
          order.push('reset')
          await Bun.sleep(300)
          await realReset()
          order.push('reset done')
        })
        const realInit = SandboxManager.initialize.bind(SandboxManager)
        const init = spyOn(SandboxManager, 'initialize').mockImplementation(
          async (...a: Parameters<typeof SandboxManager.initialize>) => {
            order.push('initialize')
            return realInit(...a)
          },
        )
        try {
          await held.persistent?.stop('SIGTERM')
          // What a watch cycle does next: its run, straight away.
          const later = await run({
            cwd: fixture.root,
            tasks: ['other#t'],
            log: collectingLogger(fixture),
          })
          expectOk(later, fixture)
          expect(order.slice(0, 3)).toEqual(['reset', 'reset done', 'initialize'])
        } finally {
          reset.mockRestore()
          init.mockRestore()
        }
      },
      TIMEOUT,
    )

    it(
      'control: `localBinding: true` binds inside the namespace and the host sees nothing',
      async () => {
        const port = freePort()
        await addProject(fixture.root, 'srv', { files: files(port), config: serverConfig('true') })
        const r = await run({
          cwd: fixture.root,
          tasks: ['client'],
          log: collectingLogger(fixture),
        })
        expect(r.ok).toBe(false)
        const client = r.outcomes.find((o) => o.node.id === 'srv#client')
        expect(client?.status).toBe('failed')
        expect(fixture.log.join('\n')).toMatch(/ECONNREFUSED|Unable to connect|ConnectionRefused/)
      },
      TIMEOUT,
    )
  },
)

/**
 * Item 652: SRT's lifecycle as vx drives it. Every row that starts the
 * sandbox runs one init against a clean directory and asserts only that
 * tasks work, so what `initSandbox` hands SRT, what a SECOND init leaves
 * alone, and what `resetSandbox` stops had no witness of their own.
 */
describe.skipIf(!available || process.platform !== 'linux')('the runtime lifecycle', () => {
  afterEach(async () => {
    await resetSandbox()
  })

  // SRT's search for its JVM proxy agent lists `npm root -g` among its
  // candidates before trying any, so every init spawned npm (~110 ms of
  // `vx info`). vx names the jar SRT ships. Each arm is a fresh process:
  // SRT memoizes both answers. The control is SRT's own init, which asks.
  it('initializes without asking npm where the global root is', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-npm-'))
    try {
      await writeFile(path.join(tmp, 'npm'), `#!/bin/sh\necho x >> ${tmp}/asked\n`, { mode: 0o755 })
      const src = path.resolve(import.meta.dir, '../src/exec/sandbox-runtime.ts')
      const asked = async (init: string): Promise<boolean> => {
        await rm(path.join(tmp, 'asked'), { force: true })
        const p = Bun.spawn(['bun', '-e', `${init}; process.exit(0)`], {
          env: { ...process.env, PATH: `${tmp}:${process.env.PATH}` },
          stdout: 'ignore',
          stderr: 'ignore',
        })
        expect(await p.exited).toBe(0)
        return existsSync(path.join(tmp, 'asked'))
      }
      const srt = `const { SandboxManager: M } = await import('@anthropic-ai/sandbox-runtime'); await M.initialize({ network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } })`
      expect([
        await asked(srt),
        await asked(`const m = await import(${JSON.stringify(src)}); await m.initSandbox()`),
      ]).toEqual([true, false])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }, 30_000)

  it("hands SRT the run's domain union and vx's default ignore list", async () => {
    await resetSandbox()
    const spy = spyOn(SandboxManager, 'updateConfig')
    try {
      await initSandbox({ allowedDomains: ['a.test'], deniedDomains: ['ads.a.test'] })
      const cfg = spy.mock.calls.at(-1)?.[0] as {
        network?: { allowedDomains?: string[]; deniedDomains?: string[] }
        ignoreViolations?: unknown
      }
      expect(cfg.network?.allowedDomains).toEqual(['a.test'])
      // SRT's proxy checks this list first, for every task (B-21).
      expect(cfg.network?.deniedDomains).toEqual(['ads.a.test'])
      expect(cfg.ignoreViolations).toEqual({ '*': ['kern.iossupportversion'] })
    } finally {
      spy.mockRestore()
    }
  })

  it("arming a run hands SRT every task's domains, denied ones included", async () => {
    await resetSandbox()
    const node = (id: string, sandbox: Record<string, unknown>) =>
      ({ id, config: { exec: { command: 'true', sandbox } } }) as unknown as TaskNode
    const spy = spyOn(SandboxManager, 'updateConfig')
    try {
      await prepareSandbox([
        node('p#a', { allow: { network: ['*.a.test'] }, deny: { network: ['ads.a.test'] } }),
        node('p#b', { allow: { network: ['b.test'] } }),
      ])!.arm()
      const cfg = spy.mock.calls.at(-1)?.[0] as {
        network?: { allowedDomains?: string[]; deniedDomains?: string[] }
      }
      expect([cfg.network?.allowedDomains, cfg.network?.deniedDomains]).toEqual([
        ['*.a.test', 'b.test'],
        ['ads.a.test'],
      ])
    } finally {
      spy.mockRestore()
    }
  })

  it('a second init leaves the running sockets alone', async () => {
    // The stale-socket sweep is for a DEAD process's files. Once SRT is up
    // under this pid, the files are its own live listeners. A process of
    // its own: SRT's socket sequence keeps counting across resets, so only
    // a fresh process's first listener sits at the seq the sweep starts on.
    const script = [
      `import { initSandbox, resetSandbox } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'exec', 'sandbox-runtime.ts'))}`,
      `import { existsSync } from 'node:fs'`,
      `import path from 'node:path'`,
      `import os from 'node:os'`,
      `const live = path.join(os.tmpdir(), 'srt-mux-' + process.pid + '-0.sock')`,
      `await initSandbox()`,
      `const first = existsSync(live)`,
      `await initSandbox()`,
      `console.log(JSON.stringify([first, existsSync(live)]))`,
      `await resetSandbox()`,
    ].join('\n')
    const p = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect([p.exitCode, p.stdout.toString().trim()]).toEqual([0, '[true,true]'])
  })

  it('a stale path it cannot unlink is an error, not a silent pass', async () => {
    // A DIRECTORY at the socket path: `unlink` answers EISDIR, which is
    // not "nothing there", and SRT's listen would fail on it anyway.
    const stale = path.join(os.tmpdir(), `srt-mux-${process.pid}-0.sock`)
    await resetSandbox()
    await mkdir(stale)
    try {
      const err = await initSandbox().then(
        () => undefined,
        (e: unknown) => e,
      )
      expect((err as NodeJS.ErrnoException | undefined)?.code).toBe('EISDIR')
    } finally {
      await rm(stale, { recursive: true, force: true })
    }
  })

  it("reset stops a task's host-side port bridge", async () => {
    const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-bridge-reset-')))
    const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const port = l.port
    l.stop(true)
    const listening = async (): Promise<boolean> =>
      Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } }).then(
        (s) => (s.end(), true),
        () => false,
      )
    try {
      await initSandbox()
      await wrapSandboxedCommand({
        command: 'true',
        cwd: dir,
        env: {},
        config: resolveSandboxConfig({ allow: { localBinding: [port] } }, dir),
        baseAllowRead: [],
        baseDenyRead: [],
      })
      // The host's socat binds asynchronously: wait for it, bounded.
      let up = false
      for (let i = 0; i < 100 && !up; i++) {
        up = await listening()
        if (!up) await Bun.sleep(20)
      }
      expect(up).toBe(true)
      await resetSandbox()
      let down = false
      for (let i = 0; i < 100 && !down; i++) {
        down = !(await listening())
        if (!down) await Bun.sleep(20)
      }
      expect(down).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!available || process.platform !== 'linux')(
  'a stale mux socket under this pid does not stop the runtime',
  () => {
    it(
      "a dead process's socket file with a recycled pid is removed before SRT listens",
      async () => {
        // A regular file is enough: `listen` on any existing path is EADDRINUSE.
        const stale = path.join(os.tmpdir(), `srt-mux-${process.pid}-0.sock`)
        await resetSandbox()
        await writeFile(stale, '')
        try {
          const verdict = await probeSandbox()
          expect(verdict.available).toBe(true)
          expect(existsSync(stale)).toBe(false)
        } finally {
          await rm(stale, { force: true })
          await resetSandbox()
        }
      },
      TIMEOUT,
    )
  },
)

describe.skipIf(!available || process.platform !== 'linux')(
  'a brace in a write grant is a LITERAL to the sandbox, and the grant works',
  () => {
    // `MOUNT_WILDCARDS` (sandbox-paths.ts) leaves `{}` out on purpose, and
    // this row is the measurement its docblock cites: `write: ['g/{a,b}.txt']`
    // gets a placeholder file and is widened to `g/` like any file-shaped
    // grant, so the task writes `g/a.txt`. Counted as a wildcard instead,
    // the grant goes to the scan, matches nothing before the task has
    // written, and the write fails with `Read-only file system` (flip the
    // constant to `[*?[\]{}]` and this row reddens; item 577).
    let fixture: Fixture

    beforeEach(async () => {
      fixture = await makeWorkspace()
    })
    afterEach(async () => {
      await rm(fixture.root, { recursive: true, force: true })
    })

    it(
      'write: [g/{a,b}.txt] lets the task write g/a.txt',
      async () => {
        const dir = await addProject(fixture.root, 'app', {
          files: { 'src/x.txt': 'declared' },
          config: `
            export default {
              tasks: {
                build: {
                  exec: {
                    command: 'echo OUT > g/a.txt',
                    sandbox: { allow: { read: ['src/**'], write: ['g/{a,b}.txt'] } },
                  },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
                },
              },
            }
          `,
        })
        const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
        expectOk(r, fixture)
        expect(await readFile(path.join(dir, 'g', 'a.txt'), 'utf8')).toBe('OUT\n')
        expect(fixture.log.join('\n')).not.toContain('Read-only file system')
      },
      TIMEOUT,
    )
  },
)

// A cancellation reaches a sandboxed command as the signal vx got, and its
// trap runs (item 752). vx's group signal used to land on bwrap's monitor,
// which died of it; `--die-with-parent` then SIGKILLed the namespace, so no
// trap ran and `got.txt` stayed empty. The polite signal now goes down the
// task's fd 3 to a watcher in the sandbox. Each title a literal, as in
// signal-handling.test.ts, whose unsandboxed rows these mirror.
describe.skipIf(!available || process.platform !== 'linux')(
  'a signal to vx reaches a sandboxed task',
  () => {
    const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
    const TRAPS =
      "trap 'echo SIGINT > got.txt; exit 0' INT; trap 'echo SIGTERM > got.txt; exit 0' TERM"
    let root = ''
    beforeEach(async () => {
      root = await makeWorkspaceRoot({ prefix: 'vx-sbx-sig-' })
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    const reaches =
      (signal: 'SIGINT' | 'SIGTERM', code: number, persistent: boolean) => async () => {
        const dir = await addProject(
          root,
          'app',
          `
            export default {
              tasks: {
                t: {
                  exec: {
                    command: "${TRAPS}; echo up > ready.txt; echo READY; while :; do sleep 0.05; done",
                    sandbox: { allow: { read: ['.'], write: ['got.txt', 'ready.txt'] } },
                    ${persistent ? "persistent: { readyWhen: 'READY' }," : ''}
                  },
                },
              },
            }
          `,
        )
        const proc = Bun.spawn([process.execPath, BIN, 'run', 't', '--all'], {
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        // The write grant pre-creates the file empty: "started" is its text.
        const ready = path.join(dir, 'ready.txt')
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline) {
          if (existsSync(ready) && readFileSync(ready, 'utf8').trim() === 'up') break
          await Bun.sleep(20)
        }
        proc.kill(signal)
        expect(await proc.exited).toBe(code)
        expect(readFileSync(path.join(dir, 'got.txt'), 'utf8').trim()).toBe(signal)
      }

    it(
      'SIGINT to vx reaches a sandboxed one-shot task as SIGINT',
      reaches('SIGINT', 130, false),
      TIMEOUT,
    )
    it(
      'SIGINT to vx reaches a ready sandboxed persistent task as SIGINT',
      reaches('SIGINT', 130, true),
      TIMEOUT,
    )
    it(
      'SIGTERM to vx reaches a sandboxed one-shot task as SIGTERM',
      reaches('SIGTERM', 143, false),
      TIMEOUT,
    )
    it(
      'SIGTERM to vx reaches a ready sandboxed persistent task as SIGTERM',
      reaches('SIGTERM', 143, true),
      TIMEOUT,
    )

    // A signal exit is `process.exit`, which never reaches the task's own
    // unlink: one strace log per sandboxed task stayed in the temp dir
    // (item 848). Since item 849 a first signal lets the run end and read
    // the log, so only the second signal's immediate exit leaves it to the
    // exit hook. The second goes once the task has heard the first; a task
    // that died on the first ended the run the normal way, and the row
    // held nothing (item 863). A short TMPDIR, directly under the temp
    // dir: the runtime's socket lives there too, and `sun_path` is 108
    // bytes.
    it(
      'a second signal exit leaves no strace log behind',
      async () => {
        const dir = await addProject(
          root,
          'app',
          `export default { tasks: { t: { exec: {
            command: "trap 'echo int > int.txt' INT; echo up > ready.txt; while :; do sleep 0.05; done",
            sandbox: { allow: { read: ['.'], write: ['ready.txt', 'int.txt'] } },
          } } } }`,
        )
        const tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-st-'))
        try {
          const proc = Bun.spawn([process.execPath, BIN, 'run', 't', '--all'], {
            cwd: root,
            stdout: 'pipe',
            stderr: 'pipe',
            env: { ...process.env, TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp },
          })
          const ready = path.join(dir, 'ready.txt')
          const deadline = Date.now() + 20_000
          while (Date.now() < deadline) {
            if (existsSync(ready) && readFileSync(ready, 'utf8').trim() === 'up') break
            await Bun.sleep(20)
          }
          const logs = (): string[] =>
            readdirSync(taskRoot({ CLAUDE_CODE_TMPDIR: tmp })).filter((n) =>
              n.startsWith('vx-strace-'),
            )
          // The positive first: the running task has its log here.
          expect(logs().length).toBe(1)
          proc.kill('SIGINT')
          const heard = path.join(dir, 'int.txt')
          const until = Date.now() + 10_000
          while (!existsSync(heard) && Date.now() < until) await Bun.sleep(20)
          expect(existsSync(heard)).toBe(true)
          proc.kill('SIGINT')
          expect(await proc.exited).toBe(130)
          expect(logs()).toEqual([])
        } finally {
          await rm(tmp, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )
  },
)

// A `kill -9` of vx runs no teardown (kill-tree.md). A sandboxed task's
// bwrap is vx's own child — the shell `exec`s it — so its
// `--die-with-parent` fires with vx, and the pid namespace takes every
// descendant down, one that left the task's group with `setsid` included
// (turborepo#9666). Behind a waiting shell, bwrap's parent was the shell,
// which outlived vx, and the server's tree ran on under init. The
// unsandboxed control is the limit that remains: the group guard
// (kill-tree.ts) takes the task's group, so the backgrounded child dies
// and the one that left the group with `setsid` survives.
describe.skipIf(!available || process.platform !== 'linux')(
  'a SIGKILLed vx takes a sandboxed task’s whole tree with it',
  () => {
    const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
    let root = ''
    beforeEach(async () => {
      root = await makeWorkspaceRoot({ prefix: 'vx-sbx-kill9-' })
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    /** Host pids whose command line is exactly `sleep <arg>`: a pid namespace hides the task's own `$!`. */
    const sleepers = (arg: string): number[] =>
      readdirSync('/proc')
        .filter((d) => /^\d+$/.test(d))
        .filter((d) => {
          try {
            return readFileSync(`/proc/${d}/cmdline`, 'utf8') === `sleep\0${arg}\0`
          } catch {
            return false
          }
        })
        .map(Number)

    const survivors = async (
      sandboxed: boolean,
      persistent = true,
      // Blocks vx three seconds after each task spawn returns, so the task
      // runs before vx's next step, as on a loaded box (B-9).
      stall = false,
    ): Promise<{ started: number; alive: number[]; leaders: number[] }> => {
      const nonce = `${1000 + Math.floor(Math.random() * 1000)}.${process.pid}`
      await addProject(
        root,
        'app',
        `
          export default {
            tasks: {
              dev: {
                exec: {
                  command: 'sleep ${nonce} & setsid sleep ${nonce} & echo READY; wait',
                  ${persistent ? "persistent: { readyWhen: 'READY' }," : ''}
                  ${sandboxed ? 'sandbox: {},' : ''}
                },
              },
            },
          }
        `,
      )
      const preload = path.join(root, 'stall-spawns.ts')
      if (stall)
        await writeFile(
          preload,
          `const spawn = Bun.spawn
Bun.spawn = (cmd, opts) => {
  const child = spawn(cmd, opts)
  if (opts?.argv0 === 'sh' || opts?.argv0 === 'strace') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000)
  return child
}
`,
        )
      const proc = Bun.spawn(
        [process.execPath, ...(stall ? ['--preload', preload] : []), BIN, 'run', 'dev', '--all'],
        { cwd: root, stdout: 'ignore', stderr: 'ignore' },
      )
      let pids: number[] = []
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        pids = sleepers(nonce)
        if (pids.length === 2) break
        await Bun.sleep(20)
      }
      process.kill(proc.pid, 'SIGKILL')
      expect(await proc.exited).toBe(137)
      await Promise.all(pids.map((p) => waitForDead(p, 2_000)))
      const alive = pids.filter(isAlive)
      // A session leader's session id is its own pid: the `setsid` child.
      // One that exits after the filter has no entry, and is no leader.
      const leaders = alive.filter((p) => {
        try {
          return Number(readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1]!.split(' ')[3]) === p
        } catch {
          return false
        }
      })
      for (const p of alive) process.kill(p, 'SIGKILL')
      return { started: pids.length, alive, leaders }
    }

    it(
      'a sandboxed server’s backgrounded and setsid children die with vx',
      async () => {
        expect(await survivors(true)).toEqual({ started: 2, alive: [], leaders: [] })
      },
      TIMEOUT,
    )

    // A one-shot sandboxed task is traced: strace, not bwrap, is the
    // spawn and bwrap's parent, and strace outlived vx with the whole
    // tree under it. The group guard's SIGKILL takes strace, and bwrap's
    // `--die-with-parent` the rest (item 860).
    it(
      'a traced sandboxed one-shot task’s children die with vx',
      async () => {
        expect(await survivors(true, false)).toEqual({ started: 2, alive: [], leaders: [] })
      },
      TIMEOUT,
    )

    it(
      'a traced sandboxed one-shot task’s children die with vx that is descheduled after the spawn',
      async () => {
        expect(await survivors(true, false, true)).toEqual({
          started: 2,
          alive: [],
          leaders: [],
        })
      },
      TIMEOUT,
    )

    it(
      'CONTROL: unsandboxed, the backgrounded child dies with vx and the setsid one lives',
      async () => {
        const { started, alive, leaders } = await survivors(false)
        expect(started).toBe(2)
        expect(alive).toHaveLength(1)
        expect(leaders).toEqual(alive)
      },
      TIMEOUT,
    )
  },
)
