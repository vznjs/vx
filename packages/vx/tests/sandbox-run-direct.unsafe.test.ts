// Sandbox-runtime tests: runSandboxed, driven directly.
//
// These tests are gated on SRT's runtime deps (bwrap on Linux,
// sandbox-exec on macOS). CI installs bubblewrap + socat + strace,
// disables AppArmor's unprivileged-userns restriction, and sets
// VX_REQUIRE_SANDBOX — so an unavailable runtime FAILS there rather than
// skipping, because a skipped suite reports green and this one covers
// the isolation boundary. A local host without the deps still skips.

import { sandboxAvailable } from './helpers/sandbox-gate.js'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import {
  initSandbox,
  releaseBridges,
  resetSandbox,
  type SandboxViolation,
  resolveSandboxConfig,
  runSandboxed,
  wrapSandboxedCommand,
} from '../src/exec/sandbox-runtime.js'
import { portBridgeSocket } from '../src/exec/sandbox-runtime.js'
import { killTree } from '../src/exec/kill-tree.js'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import * as violations from '../src/exec/sandbox-violations.js'
import { taskRoot } from './helpers/sandbox-fixture.js'
import { skipAsRoot } from './helpers/nonroot-gate.js'

const available = await sandboxAvailable('sandbox-runtime tests')

/**
 * Item 652: `runSandboxed`'s own plumbing, driven directly. Every other
 * row reaches it through `run()`, which forwards no arguments, captures
 * everything, never times a task out and tears the whole runtime down at
 * the end — so what THIS function owes its caller (the arguments, the tag,
 * the bridge release, the spawn failure, the process group, the live-child
 * set, the timeout, the capture flags) could each go with the suite green.
 */
/**
 * The tracer's argv and the task's tag, from the command a spy saw handed to
 * SRT: strace runs inside the sandbox, `exec`'d by the command's shell (B-11),
 * its words written by `shellQuote`.
 */
function traced(calls: ReadonlyArray<ReadonlyArray<unknown>>): {
  argv: string[] | undefined
  tag: string | undefined
} {
  const last = calls.at(-1)?.[0]
  const inner = typeof last === 'string' ? last : ''
  const words = (inner.match(/'(?:[^']|'\\'')*'|\S+/g) ?? []).map((w) =>
    w.startsWith("'") ? w.slice(1, -1).replaceAll("'\\''", "'") : w,
  )
  const at = words.findIndex((w) => w.endsWith('/strace'))
  return {
    argv: at < 0 ? undefined : words.slice(at),
    tag: /^: 'vx-([^']+)'/.exec(inner)?.[1],
  }
}

describe.skipIf(!available || process.platform !== 'linux')('runSandboxed, driven directly', () => {
  let dir = ''
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-runsbx-')))
    await initSandbox()
  })
  afterEach(async () => {
    await resetSandbox()
    await rm(dir, { recursive: true, force: true })
  })
  const args = (command: string, extra: Record<string, unknown> = {}) => ({
    command,
    cwd: dir,
    env: process.env,
    baseAllowRead: [dir],
    baseDenyRead: [],
    reportWithin: dir,
    reportLinked: [],
    config: resolveSandboxConfig({}, dir),
    ...extra,
  })

  // The task's temp directory is removed once it exits, and a task may
  // leave it unremovable: a read-only subdirectory (a Go module cache, a
  // `chmod -R a-w` of a fixture) threw EACCES out of the release, and the
  // task that had passed failed as a worker fault (dte, 2026-10-29).
  it.skipIf(skipAsRoot('a read-only directory in the task temp dir'))(
    'a read-only directory a task leaves in its temp dir fails nothing, and goes',
    async () => {
      const r = await runSandboxed(
        args(
          'mkdir "$TMPDIR/ro" && touch "$TMPDIR/ro/f" && chmod 500 "$TMPDIR/ro" && echo "$TMPDIR"',
        ),
      )
      expect([r.exitCode, existsSync(r.stdout.trim())]).toEqual([0, false])
    },
  )

  it('appends forwarded arguments, each shell-quoted', async () => {
    const r = await runSandboxed(args("printf '%s|'", { forwardArgs: ['a b', "c'd"] }))
    expect([r.exitCode, r.stdout]).toEqual([0, "a b|c'd|"])
  })

  // A run's reset waits while a server lives (item 882), and the LAST
  // server's release runs it. One server of two stopping must not: the
  // reset releases every bridge no server owns, a one-shot's still running
  // (sweep of B-11, `rb-deferred`). A task's temp directory goes with its
  // bridges, synchronously, so it is what the row reads.
  it("a server that stops while another runs leaves a running task's bridge alone", async () => {
    const port = (): number => {
      const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
      const p = l.port
      l.stop(true)
      return p
    }
    const wrap = (server: boolean) =>
      wrapSandboxedCommand(
        args('true', {
          config: resolveSandboxConfig({ allow: { localBinding: [port()] } }, dir),
          ...(server ? { server: true } : {}),
        }),
      )
    const tmpOf = (w: { taggedCommand: string }): string =>
      /export TMPDIR=([^;]+);/.exec(w.taggedCommand)![1]!.replaceAll("'", '')
    const a = await wrap(true)
    const b = await wrap(true)
    await resetSandbox()
    const one = await wrap(false)
    try {
      releaseBridges(a.tag)
      const kept = existsSync(tmpOf(one))
      // Positive: the last server's release runs the deferred reset.
      releaseBridges(b.tag)
      expect([kept, existsSync(tmpOf(one))]).toEqual([true, false])
    } finally {
      releaseBridges(one.tag)
    }
  })

  // A later run's `initSandbox` takes over the session a server's run
  // left up: the last server's release then ran the reset that run had
  // deferred, under the later run's tasks, and its next wrap threw "Linux
  // HTTP bridge socket does not exist" (the bridge-socket row's gate
  // failure, M-15). The second init waits out any reset the release began.
  it("a server released after a later run's init leaves that run's sandbox up", async () => {
    const localPort = (): number => {
      const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
      const p = l.port
      l.stop(true)
      return p
    }
    const server = await wrapSandboxedCommand(
      args('true', {
        config: resolveSandboxConfig({ allow: { localBinding: [localPort()] } }, dir),
        server: true,
      }),
    )
    const sock = /\S*claude-http-[0-9a-f]+\.sock/.exec(server.wrapped)![0]
    await resetSandbox()
    await initSandbox()
    const up = existsSync(sock)
    releaseBridges(server.tag)
    await initSandbox()
    expect([up, existsSync(sock)]).toEqual([true, true])
  })

  // bwrap stubs each absent mandatory deny under a write grant on the host
  // (`.bashrc`, `.vscode`, … at the runtime's cwd), and SRT removes them
  // once every wrap is cleaned up. A server's never was, so after one
  // stopped every later task left its stubs in the workspace. A child
  // process: the stubs land in its cwd, not the suite's.
  it("a stopped server's release lets a later task's bwrap stubs go", async () => {
    const ws = path.join(dir, 'ws')
    await mkdir(ws)
    const script = [
      `import { initSandbox, resetSandbox, runSandboxed, resolveSandboxConfig, wrapSandboxedCommand, releaseBridges } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'exec', 'sandbox-runtime.ts'))}`,
      `import { readdirSync } from 'node:fs'`,
      `const dir = process.cwd()`,
      `const args = (command) => ({ command, cwd: dir, env: process.env, baseAllowRead: [dir], baseDenyRead: [], reportWithin: dir, reportLinked: [], config: resolveSandboxConfig({ allow: { read: ['.'], write: ['.'] } }, dir) })`,
      `await initSandbox()`,
      `const w = await wrapSandboxedCommand({ ...args('true'), server: true })`,
      `await Bun.spawn(['sh', '-c', w.wrapped], { cwd: dir }).exited`,
      `const stubbed = readdirSync(dir).includes('.bashrc')`,
      `releaseBridges(w.tag)`,
      `await runSandboxed(args('true'))`,
      `console.log(JSON.stringify([stubbed, readdirSync(dir)]))`,
      `await resetSandbox()`,
    ].join('\n')
    const p = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      cwd: ws,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect([p.stdout.toString().trim(), p.stderr.toString()]).toEqual([
      JSON.stringify([true, []]),
      '',
    ])
  }, 20_000)

  // A literal `ignore` entry is realpath'd WHOLE: a denial through a link
  // lands on the link's target, which is what the record names, so the
  // entry naming the link silences it (sweep of B-11, `ign-nowild-dirname`).
  it('an `ignore` entry naming a link silences the denial it leads to', async () => {
    await mkdir(path.join(dir, 'proj'))
    await mkdir(path.join(dir, 'other'))
    await writeFile(path.join(dir, 'other', 'secret'), 's')
    await symlink('../other/secret', path.join(dir, 'proj', 'link'))
    const proj = path.join(dir, 'proj')
    const cat = async (ignore?: string[]) =>
      (
        await runSandboxed({
          ...args('cat < link'),
          cwd: proj,
          baseAllowRead: [],
          baseDenyRead: [dir],
          config: resolveSandboxConfig(
            { allow: { read: ['.'] }, ...(ignore ? { ignore: { read: ignore } } : {}) },
            proj,
          ),
        })
      ).violations.map((v) => v.line)
    // Positive first: unsilenced, the record names the target.
    expect([await cat(), await cat(['link'])]).toEqual([
      [`openat(link) = -1 ENOENT  [${dir}/other/secret]`],
      [],
    ])
  })

  // A relative `../x` in the trace resolves against the cwd the KERNEL
  // walked: reached through a link, its physical parent, not the lexical
  // one (sweep of B-11, `base-cwd`).
  it('reports a relative denial under a linked cwd at its physical path', async () => {
    await mkdir(path.join(dir, 'a', 'proj'), { recursive: true })
    await mkdir(path.join(dir, 'a', 'sib'))
    await writeFile(path.join(dir, 'a', 'sib', 'secret'), 's')
    await symlink(path.join(dir, 'a', 'proj'), path.join(dir, 'link'))
    const cwd = path.join(dir, 'link')
    const r = await runSandboxed({
      ...args('cat < ../sib/secret'),
      cwd,
      baseAllowRead: [],
      baseDenyRead: [dir],
      config: resolveSandboxConfig({ allow: { read: ['.'] } }, cwd),
    })
    expect(r.violations.map((v) => v.line)).toEqual([
      `openat(../sib/secret) = -1 ENOENT  [${dir}/a/sib/secret]`,
    ])
  })

  // The task's socat unlinks its port's socket on a graceful exit, so the
  // host-side unlink shows only when the namespace dies by SIGKILL: a task
  // that ignores the timeout's TERM (sweep of B-11, `rb-unlinksock`).
  it("a SIGKILLed task's port bridge leaves no socket behind", async () => {
    const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const port = l.port
    l.stop(true)
    // Each task's socket sits in its own directory under the walled root
    // (L-10), so the host looks in every task's — this process's alone: a
    // `kill -9`'d run leaves its directory (no sweep, item 965), and one
    // whose socket shared this run's ephemeral port read as a second
    // socket here, then as the one left behind (the gate, 2026-10-01).
    const root = path.dirname(path.dirname(portBridgeSocket('x', port)))
    const own = `vx-task-${process.pid}-`
    const socks = (): string[] =>
      (existsSync(root) ? readdirSync(root) : []).flatMap((t) => {
        if (!t.startsWith(own)) return []
        try {
          return readdirSync(path.join(root, t)).filter((n) => n.endsWith(`-${port}.sock`))
        } catch {
          return []
        }
      })
    // That dead run's socket, made for this port so the case is every run's.
    const dead = path.join(root, 'vx-task-0-dead')
    mkdirSync(dead, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(dead, `vx-port-dead-${port}.sock`), '')
    // A port list's bridge needs a unix socket inside: the run lifts
    // SRT's AF_UNIX filter for it, as `prepareSandbox` does.
    await resetSandbox()
    await initSandbox({ allowAllUnixSockets: true })
    const grace = process.env['VX_TEST_KILL_GRACE']
    process.env['VX_TEST_KILL_GRACE'] = '200ms'
    let during: string[] = []
    try {
      const r = await runSandboxed(
        // It says `up` once its side of the bridge is listening.
        args(
          `trap '' TERM; until ls "$TMPDIR"/vx-port-*-${port}.sock >/dev/null 2>&1; do sleep 0.02; done; echo up; sleep 10`,
          {
            config: resolveSandboxConfig({ allow: { localBinding: [port] } }, dir),
            timeoutMs: 1_000,
            onStdout: () => void (during = socks()),
          },
        ),
      )
      // Positive first: the socket existed while the task ran, and the
      // kill was the grace's.
      expect([during.length, r.timedOut, socks()]).toEqual([1, true, []])
    } finally {
      rmSync(dead, { recursive: true, force: true })
      if (grace === undefined) delete process.env['VX_TEST_KILL_GRACE']
      else process.env['VX_TEST_KILL_GRACE'] = grace
    }
  })

  // The command vx spawns runs with the TASK's environment, and SRT wrote
  // a bare `bwrap` into it: a dependency's `node_modules/.bin/bwrap` first
  // on that PATH ran in its place, and the task ran unsandboxed, exit 0
  // (B-19). The sandbox's tools are vx's, by path.
  it("a `bwrap` or `socat` first on the task's PATH is not the sandbox's", async () => {
    const bin = path.join(dir, 'bin')
    await mkdir(bin)
    for (const tool of ['bwrap', 'socat']) {
      await writeFile(path.join(bin, tool), `#!/bin/sh\necho ESCAPED-${tool}\n`, { mode: 0o755 })
    }
    const env = { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` }
    // Sandboxed: the command ran, and its undeclared write was refused.
    const r = await runSandboxed({ ...args('echo inside; touch made'), env })
    expect([r.stdout, r.exitCode, existsSync(path.join(dir, 'made'))]).toEqual([
      'inside\n',
      1,
      false,
    ])
    await resetSandbox()
    await initSandbox({ allowedDomains: ['example.com'] })
    const w = await wrapSandboxedCommand({
      ...args('true', {
        config: resolveSandboxConfig({ allow: { network: ['example.com'] } }, dir),
      }),
      env,
    })
    try {
      // socat runs behind vx's env-cutting wrapper (#4821), which `exec`s
      // the socat vx found, by path.
      const socat = /(\/[^\s'"]*socat[^\s'"]*)'*"* TCP-LISTEN/.exec(w.wrapped)?.[1] ?? ''
      expect([
        w.wrapped
          .replace(/^SOCAT_DEFAULT_LISTEN_IP=4 /, '')
          .startsWith(`exec ${Bun.which('bwrap')} `),
        socat.startsWith(bin),
        socat === Bun.which('socat') ||
          readFileSync(socat, 'utf8').includes(` ${Bun.which('socat')} "$@"`),
      ]).toEqual([true, false, true])
    } finally {
      releaseBridges(w.tag)
    }
  })

  // A networked task reaches the run's proxy, whose verdict on a domain
  // off the list is its own 403. On a host without IPv6, SRT's in-sandbox
  // bridge (`socat TCP-LISTEN`, IPv6 by default in socat 1.8) never
  // listened, and curl met "connection refused" (exit 7) instead (B-22).
  it('a networked task reaches the proxy, which refuses a domain off the list', async () => {
    await resetSandbox()
    await initSandbox({ allowedDomains: ['a.test'] })
    const r = await runSandboxed(
      args(`curl -s -m 5 -o /dev/null -w '%{http_code}' http://b.test/`, {
        config: resolveSandboxConfig({ allow: { network: ['a.test'] } }, dir),
      }),
    )
    expect([r.exitCode, r.stdout]).toEqual([0, '403'])
  })

  // A task's `deny.network` is the run's: SRT's one proxy checks the
  // denied list before the allowed one, and only from `initialize()`.
  // Before B-21 the list never reached it, so a domain the allow glob
  // covered passed the proxy (a 502 from its failed lookup, never the
  // proxy's 403). The allowed control shows the glob does let one through.
  it('the proxy refuses a denied domain the allow glob covers', async () => {
    await resetSandbox()
    await initSandbox({ allowedDomains: ['*.a.test'], deniedDomains: ['ads.a.test'] })
    const config = resolveSandboxConfig(
      { allow: { network: ['*.a.test'] }, deny: { network: ['ads.a.test'] } },
      dir,
    )
    const code = async (host: string) =>
      (
        await runSandboxed(
          args(`curl -s -m 5 -o /dev/null -w '%{http_code}' http://${host}/`, { config }),
        )
      ).stdout
    expect([await code('ads.a.test'), await code('cdn.a.test')]).toEqual(['403', '502'])
  })

  it('tags each wrap uniquely and puts the tag first in the command', async () => {
    // SRT's macOS store keys a record by the command's first 100 bytes, so
    // two tasks running one command in one directory must still differ.
    const a = await wrapSandboxedCommand(args('echo hi'))
    const b = await wrapSandboxedCommand(args('echo hi'))
    expect(a.tag).not.toBe(b.tag)
    // Then the task's own TMPDIR (item 965), after the tag.
    expect(a.taggedCommand.startsWith(`: 'vx-${a.tag}'; export TMPDIR=`)).toBe(true)
    expect(a.taggedCommand).toMatch(new RegExp(`vx-task-${process.pid}-${a.tag}'?; echo hi$`))
    releaseBridges(a.tag)
    releaseBridges(b.tag)
  })

  // The row above met a host that sets JAVA_TOOL_OPTIONS (a proxied
  // container) with a quoted prefix before its command: the task passes the
  // host's value through, SRT's composition was already right, and the
  // prefix only quoted it twice (item 1007). A differing value still gets
  // one; that is item 995's own row.
  it("no JAVA_TOOL_OPTIONS prefix when the task's value is the host's", async () => {
    const previous = process.env['JAVA_TOOL_OPTIONS']
    process.env['JAVA_TOOL_OPTIONS'] = '-Dsame=1'
    try {
      const same = await wrapSandboxedCommand(
        args('echo hi', { env: { JAVA_TOOL_OPTIONS: '-Dsame=1' } }),
      )
      expect(same.taggedCommand).toMatch(
        new RegExp(`vx-task-${process.pid}-${same.tag}'?; echo hi$`),
      )
      releaseBridges(same.tag)
      // CONTROL: a task value of its own still gets the prefix.
      const own = await wrapSandboxedCommand(
        args('echo hi', { env: { JAVA_TOOL_OPTIONS: '-Down=1' } }),
      )
      expect(own.taggedCommand).toContain('__vx_t=-Down=1;')
      releaseBridges(own.tag)
    } finally {
      if (previous === undefined) delete process.env['JAVA_TOOL_OPTIONS']
      else process.env['JAVA_TOOL_OPTIONS'] = previous
    }
  })

  // bwrap enters the old cwd only if a mount holds it, else `$HOME`, with
  // no word: a project granted no read ran there, and `cat x.txt` read
  // `~/x.txt` under a green run.
  it('runs in its own cwd when no grant holds it, and its read there is reported', async () => {
    const proj = path.join(dir, 'proj')
    await mkdir(proj)
    await writeFile(path.join(proj, 'x.txt'), 'x')
    const run = (command: string) =>
      runSandboxed(
        args(command, {
          cwd: proj,
          // The project's own `node_modules`, absent here, as a project
          // without one has it: a grant that mounts nothing.
          baseAllowRead: [path.join(proj, 'node_modules')],
          baseDenyRead: [dir],
          reportWithin: proj,
        }),
      )
    const pwd = await run('pwd')
    expect([pwd.exitCode, pwd.stdout.trim()]).toEqual([0, proj])
    const cat = await run('cat < x.txt')
    expect([cat.exitCode === 0, cat.violations.map((v) => v.line.includes('x.txt'))]).toEqual([
      false,
      [true],
    ])
  })

  // SRT reads any Linux read path holding `[` as a glob, where a bracket
  // opens a class: a Next.js route granted by its escaped name matched,
  // was never mounted, and its denial went unreported (a listed grant),
  // and a workspace under a bracketed directory was never walled.
  const bracketed = async (ws: string) => {
    const proj = path.join(ws, 'app')
    await mkdir(path.join(proj, 'pages'), { recursive: true })
    await mkdir(path.join(ws, 'other'))
    await writeFile(path.join(proj, 'pages', '[id].tsx'), 'route')
    await writeFile(path.join(ws, 'other', 'x.txt'), 'sibling')
    return (command: string, read: string[]) =>
      runSandboxed(
        args(command, {
          cwd: proj,
          baseAllowRead: [],
          baseDenyRead: [ws],
          reportWithin: proj,
          config: resolveSandboxConfig({ allow: { read } }, proj),
        }),
      )
  }

  it('mounts a granted path whose name holds a bracket', async () => {
    const run = await bracketed(path.join(dir, 'ws'))
    const route = await run("cat 'pages/[id].tsx'", ['pages/\\[id\\].tsx'])
    expect([route.exitCode, route.stdout]).toEqual([0, 'route'])
  })

  // A grant under such a workspace does not resolve yet (vx's own scan
  // reads the bracket too; ws-b.md lead 7), so the row pins the wall alone.
  it('walls a workspace whose directory name holds a bracket', async () => {
    const run = await bracketed(path.join(dir, '[ws]'))
    const sibling = await run('cat ../other/x.txt', ['.'])
    expect([sibling.exitCode === 0, sibling.stdout]).toEqual([false, ''])
  })

  it('reports a denial under the directory the task changed into', async () => {
    const proj = path.join(dir, 'proj')
    await mkdir(path.join(proj, 'src'), { recursive: true })
    await writeFile(path.join(proj, 'src', 'secret.txt'), 's')
    await writeFile(path.join(proj, 'src', 'x.txt'), 'x')
    const r = await runSandboxed(
      args('cd src && cat < secret.txt; (cd .. && cat < src/secret.txt); true', {
        cwd: proj,
        baseAllowRead: [],
        baseDenyRead: [dir],
        reportWithin: proj,
        config: resolveSandboxConfig({ allow: { read: ['src/x.txt'] } }, proj),
      }),
    )
    // One file, read from two cwds: one denial.
    expect(r.violations.map((v) => v.target)).toEqual([path.join(proj, 'src', 'secret.txt')])
  })

  // An exec or an access probe of a hidden file was untraced, so
  // `./gen.sh || fallback` passed with no report. A hidden path answers
  // ENOENT, as a missing one does: only the host's file is a refusal.
  it('reports a refused exec or access probe, not a probe of a missing file', async () => {
    const proj = path.join(dir, 'proj')
    await mkdir(path.join(proj, 'src'), { recursive: true })
    await writeFile(path.join(proj, 'src', 'gen.sh'), '#!/bin/sh\necho gen\n', { mode: 0o755 })
    await writeFile(path.join(proj, 'src', 'x.txt'), 'x')
    await writeFile(path.join(proj, 'package.json'), '{}')
    const r = await runSandboxed(
      args(
        './src/gen.sh || test -r src/x.txt || ./src/gone.sh || test -x src/gone || echo fell back',
        {
          cwd: proj,
          baseAllowRead: [],
          baseDenyRead: [dir],
          reportWithin: proj,
          config: resolveSandboxConfig({ allow: { read: ['package.json'] } }, proj),
        },
      ),
    )
    // `test -r` is `faccessat2`, `faccessat` or `access` by libc and kernel.
    const call = (line: string): string =>
      line.split('(')[0]!.replace(/^f?access(at2?)?$/, 'access')
    expect([r.exitCode, r.stdout, r.violations.map((v) => `${call(v.line)} ${v.target}`)]).toEqual([
      0,
      'fell back\n',
      [`execve ${path.join(proj, 'src', 'gen.sh')}`, `access ${path.join(proj, 'src', 'x.txt')}`],
    ])
  })

  // A stat is untraced (a stop per stat cost vx's own no-op run 69%), so
  // a tool that stats before it opens, as Ubuntu 26's cat (uutils) does,
  // reports nothing. What keeps its run keyed is the wall: an ungranted
  // file is absent in the sandbox on every run, whatever the host holds.
  it('shows a stat no ungranted file, however the host has it', async () => {
    const proj = path.join(dir, 'proj')
    await mkdir(path.join(proj, 'src'), { recursive: true })
    await writeFile(path.join(proj, 'src', 'x.txt'), 'x')
    await writeFile(path.join(proj, 'package.json'), '{}')
    const r = await runSandboxed(
      args('test -e src/x.txt && echo seen || echo absent', {
        cwd: proj,
        baseAllowRead: [],
        baseDenyRead: [dir],
        reportWithin: proj,
        config: resolveSandboxConfig({ allow: { read: ['package.json'] } }, proj),
      }),
    )
    expect([r.exitCode, r.stdout]).toEqual([0, 'absent\n'])
  })

  it('a spawn that throws is exit 127 with the reason, not a rejection', async () => {
    const r = await runSandboxed(args('true', { cwd: path.join(dir, 'gone') }))
    // spawnFailed: no shell ran, so execute-task says nothing of a missing command (A-41).
    expect([r.exitCode, r.violations, r.spawnFailed]).toEqual([127, [], true])
    expect(r.stderr).toContain('[vx] failed to spawn sandboxed task')
  })

  // bwrap stubs each absent mandatory deny under a write grant on the host
  // (`.bashrc`, `.vscode`, … at the runtime's cwd), and the runtime removes
  // them only once every wrap has been cleaned up. A wrap with no spawn
  // after it kept every later task's stubs on the host until the reset.
  it.each(['spawn', 'abort', 'held'])(
    'a wrap that never ran (%s) leaves no later task its bwrap stubs',
    async (mode) => {
      const ws = path.join(dir, 'ws')
      await mkdir(ws)
      const script = [
        `import { initSandbox, resetSandbox, runSandboxed, resolveSandboxConfig } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'exec', 'sandbox-runtime.ts'))}`,
        `import { readdirSync } from 'node:fs'`,
        `const dir = process.cwd()`,
        `const args = (command, extra = {}) => ({ command, cwd: dir, env: process.env, baseAllowRead: [dir], baseDenyRead: [], reportWithin: dir, reportLinked: [], config: resolveSandboxConfig({ allow: { read: ['.'], write: ['.'] } }, dir), ...extra })`,
        `await initSandbox()`,
        `const mode = ${JSON.stringify(mode)}`,
        `if (mode === 'spawn') await runSandboxed(args('true', { cwd: dir + '/gone' }))`,
        `if (mode === 'abort') await runSandboxed(args('true', { signal: AbortSignal.abort() }))`,
        `if (mode === 'held') {`,
        `  const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })`,
        `  await runSandboxed(args('true', { config: { ...args('').config, localBinding: [l.port] } })).catch(() => {})`,
        `  l.stop(true)`,
        `}`,
        `const r = await runSandboxed(args('ls -A'))`,
        `console.log(JSON.stringify([r.stdout.split('\\n').includes('.bashrc'), readdirSync(dir)]))`,
        `await resetSandbox()`,
      ].join('\n')
      const p = Bun.spawnSync({
        cmd: [process.execPath, '-e', script],
        cwd: ws,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect([p.stdout.toString().trim(), p.stderr.toString()]).toEqual([
        JSON.stringify([true, []]),
        '',
      ])
    },
    20_000,
  )

  it('the child leads its own process group, and is a live child only while it runs', async () => {
    const live = new Set<ReturnType<typeof Bun.spawn>>()
    const seen: boolean[] = []
    const r = await runSandboxed(
      args('echo up; sleep 0.2', {
        liveChildren: live,
        onStdout: () => {
          for (const p of live) {
            try {
              process.kill(-p.pid, 0)
              seen.push(true)
            } catch {
              seen.push(false)
            }
          }
        },
      }),
    )
    expect([r.exitCode, seen, live.size]).toEqual([0, [true], 0])
  })

  it('a timeout ends the task and says so', async () => {
    const t0 = Date.now()
    const r = await runSandboxed(args('sleep 10', { timeoutMs: 300 }))
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(5000)
    // The SIGTERM goes down the signal channel to the command's group
    // (item 752); the command dies of it and the runtime exits with its
    // status. Before, the tracer died of the SIGTERM itself.
    expect([r.exitCode, r.signal]).toEqual([143, undefined])
  })

  it("a timeout reaches the command's TERM trap, and a command that ignores it is killed at the grace (item 752)", async () => {
    // The timeout counts from the spawn, so it is also the window in which
    // bwrap, the tracer and `sh` start and the trap is set: at 300 ms a
    // loaded gate delivered TERM first (exit 143, no got.txt, 2026-09-25).
    const trapped = await runSandboxed(
      args(`trap 'echo trapped > got.txt; exit 0' TERM; echo up; while :; do sleep 0.05; done`, {
        config: resolveSandboxConfig({ allow: { write: ['.'] } }, dir),
        timeoutMs: 1000,
      }),
    )
    const got = existsSync(path.join(dir, 'got.txt'))
      ? readFileSync(path.join(dir, 'got.txt'), 'utf8').trim()
      : null
    expect([trapped.timedOut, trapped.exitCode, got]).toEqual([true, 143, 'trapped'])
    const deaf = await runSandboxed(
      args(`trap '' TERM; echo up; while :; do sleep 0.05; done`, { timeoutMs: 1000 }),
    )
    expect([deaf.timedOut, deaf.exitCode, deaf.signal]).toEqual([true, 137, 'SIGKILL'])
  })

  it("a command that signals its own group ends its own tree, not the runtime's shell (item 751)", async () => {
    // The line exits 0 unsandboxed; sharing bwrap's session group with
    // the runtime's shells, it ended them and the run read 143.
    const r = await runSandboxed(args(`sleep 10 & trap 'trap "" TERM; kill 0' EXIT; echo done`))
    expect([r.exitCode, r.stdout]).toEqual([0, 'done\n'])
  })

  it("CONTROL: in its own group the command's exit, a signal death included, is still its own", async () => {
    const exited = await runSandboxed(args('exit 3'))
    const killed = await runSandboxed(args('kill -9 $$'))
    expect([exited.exitCode, killed.exitCode]).toEqual([3, 137])
  })

  it('traces the reads, execs and access probes, through the seccomp filter', async () => {
    // The flag is the difference between tracing a few syscalls and stopping
    // on every one: without it the cache perf baselines ran 2.5-7x over.
    const spy = spyOn(SandboxManager, 'wrapWithSandbox')
    try {
      await runSandboxed(args('true'))
      // The tracer runs by its absolute path (util/which.ts), detached
      // (`-DD`) so a backgrounded grandchild is not a tracee it waits for.
      const { argv } = traced(spy.mock.calls)
      expect(argv?.[0]).toBe(Bun.which('strace')!)
      expect(argv?.slice(1, 10)).toEqual([
        '-DD',
        '-f',
        '--seccomp-bpf',
        '-qq',
        '-e',
        'trace=openat,execve,?access,faccessat,?faccessat2,chdir,fchdir,clone,?clone3,?fork,?vfork',
        '-o',
        '/dev/fd/5',
        '--',
      ])
    } finally {
      spy.mockRestore()
    }
  })

  it('removes its trace log, and reports no usage that is not the task’s', async () => {
    // The tmpdir is shared with every process on the box, so the row
    // follows this task's own log (the one its tag names), not a listing
    // another suite's sandbox can change mid-run.
    const spy = spyOn(SandboxManager, 'wrapWithSandbox')
    const during: boolean[] = []
    const logOf = (): string | undefined => {
      const { tag } = traced(spy.mock.calls)
      return tag === undefined ? undefined : path.join(taskRoot(), `vx-strace-${tag}.log`)
    }
    try {
      const r = await runSandboxed(
        args('echo up; sleep 0.1', { onStdout: () => during.push(existsSync(logOf() ?? '')) }),
      )
      const log = logOf() ?? ''
      // Positive first: the log was there while the task ran.
      expect([path.basename(log).startsWith('vx-strace-'), during, existsSync(log)]).toEqual([
        true,
        [true],
        false,
      ])
      expect([r.cpuMs, r.peakRssBytes]).toEqual([undefined, undefined])
    } finally {
      spy.mockRestore()
    }
  })

  // Listed for the exit hook alone, a `vx watch` kept one log per failed
  // spawn until it quit.
  it('a spawn that throws leaves neither its trace log nor its task directory', async () => {
    const spy = spyOn(SandboxManager, 'wrapWithSandbox')
    try {
      const r = await runSandboxed(args('true', { cwd: path.join(dir, 'gone') }))
      const { argv, tag } = traced(spy.mock.calls)
      expect([
        r.spawnFailed,
        argv !== undefined,
        existsSync(path.join(taskRoot(), `vx-strace-${tag}.log`)),
        existsSync(path.join(taskRoot(), `vx-task-${process.pid}-${tag}`)),
      ]).toEqual([true, true, false, false])
    } finally {
      spy.mockRestore()
    }
  })

  it('hands the runtime back its per-command cleanup', async () => {
    const spy = spyOn(SandboxManager, 'cleanupAfterCommand')
    try {
      await runSandboxed(args('true'))
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  // macOS adds rules to the wrapped profile and refuses one of an
  // unexpected shape, after the wrap counted. Stubbed to darwin from the
  // wrap on: what precedes it is Linux's, the refusal is darwin's.
  it('hands the cleanup back, and drops the task dir, when the profile is refused', async () => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!
    let tmp = ''
    let during = false
    const wrap = spyOn(SandboxManager, 'wrapWithSandbox').mockImplementation(async (c) => {
      tmp = path.join(taskRoot(), /vx-task-\d+-[0-9a-f]{16}/.exec(c)?.[0] ?? '-')
      during = existsSync(tmp)
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      return `sh -c ${c}`
    })
    const cleanup = spyOn(SandboxManager, 'cleanupAfterCommand')
    try {
      const config = { ...resolveSandboxConfig({}, dir), systemInfo: ['hw.ncpu'] }
      const err = await runSandboxed(args('true', { config })).then(
        () => undefined,
        (e: Error) => e.message,
      )
      Object.defineProperty(process, 'platform', real)
      expect([
        err?.includes('did not have the expected shape'),
        during,
        existsSync(tmp),
        cleanup.mock.calls.length,
      ]).toEqual([true, true, false, 1])
    } finally {
      Object.defineProperty(process, 'platform', real)
      wrap.mockRestore()
      cleanup.mockRestore()
    }
  })

  // The note macOS needs (it logs nothing when the cwd is not granted) is
  // added on any platform when a task FAILED, reported nothing, and its
  // cwd lies outside every read grant. Each of the three is a row here.
  describe('the ungranted-cwd note', () => {
    const NOTE = "vx: this sandbox grants no read access to the task's own working directory"
    const notes = (r: { violations: SandboxViolation[] }): boolean[] =>
      r.violations.map((v) => v.line.startsWith(NOTE))

    it('is added to a failure with nothing to show, when no grant covers the cwd', async () => {
      await mkdir(path.join(dir, 'sub'))
      await mkdir(path.join(dir, 'proj'))
      const r = await runSandboxed(
        args('exit 3', { cwd: path.join(dir, 'proj'), baseAllowRead: [path.join(dir, 'sub')] }),
      )
      expect([r.exitCode, notes(r)]).toEqual([3, [true]])
    })

    // A root's `read: ['.']` is bound as its children around the walls
    // (`wallOff`), and bwrap builds the path to a bind: the cwd lists. The
    // note fired on every failing root task that listed its cwd (B-20).
    it.skipIf(process.platform !== 'linux')(
      'is not added on Linux when a grant lies inside the cwd, which then lists',
      async () => {
        await mkdir(path.join(dir, 'sub'))
        const r = await runSandboxed(
          args('ls >/dev/null && exit 3', {
            baseAllowRead: [path.join(dir, 'sub')],
            baseDenyRead: [dir],
            config: resolveSandboxConfig({}, dir),
          }),
        )
        expect([r.exitCode, notes(r)]).toEqual([3, []])
      },
    )

    it('is added when the only grant is a sibling whose name prefixes the cwd', async () => {
      // `<dir>/proj` is a string prefix of `<dir>/proj-x` and covers none
      // of it; the separator is what keeps it from reading as the grant.
      await mkdir(path.join(dir, 'proj'))
      await mkdir(path.join(dir, 'proj-x'))
      const r = await runSandboxed(
        args('exit 3', { cwd: path.join(dir, 'proj-x'), baseAllowRead: [path.join(dir, 'proj')] }),
      )
      expect([r.exitCode === 0, notes(r)]).toEqual([false, [true]])
      // CONTROL: a grant that does cover the cwd adds no note.
      const granted = await runSandboxed(args('exit 3'))
      expect([granted.exitCode, notes(granted)]).toEqual([3, []])
    })

    it('is not added when the task already reported a denial', async () => {
      await mkdir(path.join(dir, 'sub'))
      const r = await runSandboxed(
        args(`cat < ${dir}/secret.txt; exit 3`, {
          baseAllowRead: [path.join(dir, 'sub')],
          baseDenyRead: [dir],
        }),
      )
      expect([r.exitCode, notes(r)]).toEqual([3, [false]])
    })
  })

  // Whether to trace is decided once per runtime, from `strace --version`.
  // CI's strace answers 0 and a modern version, so a detector that ignored
  // the exit, never memoized, or let a missing binary through unrecorded
  // answered the same there. These rows put a different strace on PATH —
  // in a process of its own, since the verdict is memoized per process.
  // `which strace` is the PATH lookup (util/which.ts), `strace --version`
  // the probe.
  describe('strace detection', () => {
    const detecting = (pathDirs: string, together = false): unknown => {
      const src = path.resolve(import.meta.dir, '..', 'src', 'exec', 'sandbox-runtime.ts')
      const script = [
        `import { initSandbox, resetSandbox, runSandboxed, resolveSandboxConfig } from ${JSON.stringify(src)}`,
        `const calls = []`,
        `const spawn = Bun.spawn`,
        `const which = Bun.which`,
        `Bun.which = (name, ...rest) => { if (name === 'strace') calls.push('which strace'); return which(name, ...rest) }`,
        `Bun.spawn = (cmd, ...rest) => { if (Array.isArray(cmd) && cmd[0].endsWith('/strace')) calls.push(cmd.includes('-o') ? 'trace' : ['strace', ...cmd.slice(1)].join(' ')); return spawn(cmd, ...rest) }`,
        `await initSandbox()`,
        `const dir = ${JSON.stringify(dir)}`,
        `const outs = []`,
        `const task = async () => (await runSandboxed({ command: 'echo ok', cwd: dir, env: process.env, baseAllowRead: [dir], baseDenyRead: [], reportWithin: dir, reportLinked: [], config: resolveSandboxConfig({}, dir) })).stdout`,
        together
          ? `outs.push(...(await Promise.all([task(), task()])))`
          : `for (let i = 0; i < 2; i++) outs.push(await task())`,
        `console.log(JSON.stringify({ outs, calls }))`,
        `await resetSandbox()`,
      ].join('\n')
      const p = Bun.spawnSync({
        cmd: [process.execPath, '-e', script],
        env: { ...process.env, PATH: pathDirs },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const out = p.stdout.toString().trim()
      if (out === '') return { exit: p.exitCode, stderr: p.stderr.toString().slice(0, 400) }
      // What vx told the user, once for the two runs.
      const said = p.stderr
        .toString()
        .split('\n')
        .filter((l) => l.startsWith('[vx] sandbox:'))
      return { ...JSON.parse(out), said }
    }
    const untraced = (why: string): string[] => [
      `[vx] sandbox: ${why}, so sandboxed tasks run without the report of the reads the sandbox denied; the sandbox still enforces`,
    ]

    it('an strace before 5.3 traces without --seccomp-bpf, one after with it', async () => {
      // `--seccomp-bpf` came in strace 5.3; an older one refuses the flag.
      const real = Bun.which('strace')!
      const src = path.resolve(import.meta.dir, '..', 'src', 'exec', 'sandbox-runtime.ts')
      const seccomp = async (version: string): Promise<unknown> => {
        const bin = path.join(dir, `bin-${version}`)
        await mkdir(bin)
        await writeFile(
          path.join(bin, 'strace'),
          `#!/bin/sh\n[ "$1" = --version ] && { echo "strace -- version ${version}"; exit 0; }\nexec ${real} "$@"\n`,
          { mode: 0o755 },
        )
        const script = [
          `import { initSandbox, resetSandbox, runSandboxed, resolveSandboxConfig } from ${JSON.stringify(src)}`,
          `const forms = []`,
          `const spawn = Bun.spawn`,
          `Bun.spawn = (cmd, ...rest) => { if (Array.isArray(cmd) && cmd[0].endsWith('/strace') && cmd.includes('-o')) forms.push(cmd.includes('--seccomp-bpf')); return spawn(cmd, ...rest) }`,
          `await initSandbox()`,
          `const dir = ${JSON.stringify(dir)}`,
          `await runSandboxed({ command: 'true', cwd: dir, env: process.env, baseAllowRead: [dir], baseDenyRead: [], reportWithin: dir, reportLinked: [], config: resolveSandboxConfig({}, dir) })`,
          `console.log(JSON.stringify(forms))`,
          `await resetSandbox()`,
        ].join('\n')
        const p = Bun.spawnSync({
          cmd: [process.execPath, '-e', script],
          env: { ...process.env, PATH: `${bin}:${process.env['PATH']}` },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const out = p.stdout.toString().trim()
        return out === ''
          ? { exit: p.exitCode, stderr: p.stderr.toString().slice(0, 400) }
          : JSON.parse(out)
      }
      // The probe's own trace carries the form the tasks get.
      expect([await seccomp('5.2'), await seccomp('6.1')]).toEqual([[false], [true]])
    })

    it('a strace whose --version fails is not used, and is asked once', async () => {
      const bin = path.join(dir, 'bin')
      await mkdir(bin)
      // Fails `--version`; as a tracer it would just run the command.
      await writeFile(
        path.join(bin, 'strace'),
        '#!/bin/sh\n[ "$1" = --version ] && exit 1\nwhile [ "$1" != -- ]; do shift; done; shift; exec "$@"\n',
        { mode: 0o755 },
      )
      expect(detecting(`${bin}:${process.env['PATH']}`)).toEqual({
        outs: ['ok\n', 'ok\n'],
        calls: ['which strace', 'strace --version'],
        said: untraced('strace --version exited 1'),
      })
    })

    // Untraced (no strace here, or a persistent server) the command is
    // `exec`'d by the shell that forks the watcher: it must see no fd 3,
    // and the watcher must signal its GROUP, `-$$` (sweep of B-11,
    // `og-run-fd3`, `og-watch-pp`). The traced twins drive the other form.
    it('untraced, the command holds no signal channel and vx reaches its children', async () => {
      const bin = path.join(dir, 'bin')
      await mkdir(bin)
      await writeFile(path.join(bin, 'strace'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      const src = path.resolve(import.meta.dir, '..', 'src', 'exec')
      const script = [
        `import { initSandbox, resetSandbox, runSandboxed, resolveSandboxConfig } from ${JSON.stringify(path.join(src, 'sandbox-runtime.ts'))}`,
        `import { killTree } from ${JSON.stringify(path.join(src, 'kill-tree.ts'))}`,
        `import { existsSync, readFileSync } from 'node:fs'`,
        `const dir = ${JSON.stringify(dir)}`,
        `const args = (command, extra = {}) => ({ command, cwd: dir, env: process.env, baseAllowRead: [dir], baseDenyRead: [], reportWithin: dir, reportLinked: [], config: resolveSandboxConfig({ allow: { read: ['.'], write: ['got.txt', 'ready.txt'] } }, dir), ...extra })`,
        `await initSandbox()`,
        `const fd = (await runSandboxed(args('(: >&3) 2>/dev/null && echo open || echo closed'))).stdout.trim()`,
        `const live = new Set()`,
        `const done = runSandboxed(args(\`trap 'wait' TERM; sh -c 'trap "echo child > got.txt; exit 0" TERM; echo up > ready.txt; while :; do sleep 0.05; done' & wait\`, { liveChildren: live, timeoutMs: 10000 }))`,
        `while (!existsSync(dir + '/ready.txt') || readFileSync(dir + '/ready.txt', 'utf8').trim() !== 'up') await Bun.sleep(20)`,
        `for (const c of live) killTree(c, 'SIGTERM')`,
        `await done`,
        `console.log(JSON.stringify({ fd, got: readFileSync(dir + '/got.txt', 'utf8') }))`,
        `await resetSandbox()`,
      ].join('\n')
      const p = Bun.spawnSync({
        cmd: [process.execPath, '-e', script],
        env: { ...process.env, PATH: `${bin}:${process.env['PATH']}` },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect([p.stdout.toString().trim(), p.stderr.toString().slice(0, 400)]).toEqual([
        JSON.stringify({ fd: 'closed', got: 'child\n' }),
        `${untraced('strace --version exited 1')[0]}\n`,
      ])
    }, 20_000)

    // A host that refuses ptrace still answers `--version`, and every
    // sandboxed task failed twice (the retry) on strace's attach error. One
    // real trace, asked once, says so: the run goes untraced (B-18).
    it('a strace that may not attach is not used, and is asked once', async () => {
      const bin = path.join(dir, 'bin')
      await mkdir(bin)
      await writeFile(
        path.join(bin, 'strace'),
        `#!/bin/sh\n[ "$1" = --version ] && exec ${Bun.which('strace')} "$@"\necho "strace: attach: ptrace(PTRACE_SEIZE, 2): Operation not permitted" >&2\nexit 1\n`,
        { mode: 0o755 },
      )
      expect(detecting(`${bin}:${process.env['PATH']}`)).toEqual({
        outs: ['ok\n', 'ok\n'],
        calls: ['which strace', 'strace --version', 'trace'],
        said: untraced(
          'strace cannot trace here (strace: attach: ptrace(PTRACE_SEIZE, 2): Operation not permitted)',
        ),
      })
    })

    // A run starts a wave of tasks at once, and each asked before the
    // first answer was memoized: one probe per task, not per run.
    it('tasks that start together ask once', async () => {
      const bin = path.join(dir, 'bin')
      await mkdir(bin)
      await writeFile(
        path.join(bin, 'strace'),
        `#!/bin/sh\n[ "$1" = --version ] && exec ${Bun.which('strace')} "$@"\necho "strace: attach: ptrace(PTRACE_SEIZE, 2): Operation not permitted" >&2\nexit 1\n`,
        { mode: 0o755 },
      )
      expect(detecting(`${bin}:${process.env['PATH']}`, true)).toEqual({
        outs: ['ok\n', 'ok\n'],
        calls: ['which strace', 'strace --version', 'trace'],
        said: untraced(
          'strace cannot trace here (strace: attach: ptrace(PTRACE_SEIZE, 2): Operation not permitted)',
        ),
      })
    })

    it('no strace on PATH is no tracing, and is found out once', async () => {
      // Every binary the runtime needs, and no strace.
      const bin = path.join(dir, 'bin')
      await mkdir(bin)
      for (const name of ['sh', 'bash', 'bwrap', 'socat', 'rg']) {
        const found = Bun.which(name)
        if (found !== null) await symlink(found, path.join(bin, name))
      }
      // The lookup's miss is the verdict: nothing is spawned to learn it.
      // And it is said: an undeclared read is denied but never reported,
      // so a task that tolerates the miss passes and caches (B-51).
      expect(detecting(bin)).toEqual({
        outs: ['ok\n', 'ok\n'],
        calls: ['which strace'],
        said: untraced('strace is not on PATH'),
      })
    })

    // `vx info` reports the same verdict as a fact (B-51's lead): the reason
    // the runtime would warn with, and not a word on stderr, since the doctor
    // runs nothing. With the real strace it is null.
    it('untracedReason names what the warning would, and says nothing', async () => {
      const bin = path.join(dir, 'bin')
      await mkdir(bin)
      await writeFile(path.join(bin, 'strace'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      const src = path.resolve(import.meta.dir, '..', 'src', 'exec', 'sandbox-runtime.ts')
      const ask = (pathDirs: string): [string, string] => {
        const p = Bun.spawnSync({
          cmd: [
            process.execPath,
            '-e',
            `import { untracedReason } from ${JSON.stringify(src)}\nconsole.log(JSON.stringify(await untracedReason()))`,
          ],
          env: { ...process.env, PATH: pathDirs },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        return [p.stdout.toString().trim(), p.stderr.toString()]
      }
      expect([ask(`${bin}:${process.env['PATH']}`), ask(process.env['PATH']!)]).toEqual([
        [JSON.stringify('strace --version exited 1'), ''],
        ['null', ''],
      ])
    })
  })

  it('a trace that cannot be parsed costs the report, never the task', async () => {
    const spy = spyOn(violations, 'parseStraceViolations').mockRejectedValue(new Error('garbled'))
    try {
      const r = await runSandboxed(args('echo ok'))
      expect([r.exitCode, r.stdout, r.violations]).toEqual([0, 'ok\n', []])
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('a stream the caller did not ask to capture is streamed but not retained', async () => {
    const out: string[] = []
    const err: string[] = []
    const r = await runSandboxed(
      args('echo o; echo e >&2', {
        capture: { stdout: false, stderr: false },
        onStdout: (c: string) => out.push(c),
        onStderr: (c: string) => err.push(c),
      }),
    )
    expect([r.stdout, r.stderr, out.join(''), err.join('')]).toEqual(['', '', 'o\n', 'e\n'])
  })

  it("releases the task's host-side port bridge when the task ends", async () => {
    const l = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    const port = l.port
    l.stop(true)
    const listening = async (): Promise<boolean> =>
      Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } }).then(
        (s) => (s.end(), true),
        () => false,
      )
    const running = runSandboxed(
      args('sleep 1', {
        config: resolveSandboxConfig({ allow: { localBinding: [port] } }, dir),
      }),
    )
    // Positive first: the host side comes up while the task runs.
    let up = false
    for (let i = 0; i < 40 && !up; i++) {
      up = await listening()
      if (!up) await Bun.sleep(20)
    }
    expect(up).toBe(true)
    await running
    let down = false
    for (let i = 0; i < 100 && !down; i++) {
      down = !(await listening())
      if (!down) await Bun.sleep(20)
    }
    expect(down).toBe(true)
  })

  // Measured for item 652, and it holds the NAMESPACE, not the drain: with
  // `drainOrAbort` (or the timeout's abort) deleted this row stays green,
  // because bwrap's PID namespace kills a backgrounded grandchild the
  // moment the task's shell exits, and the pipe closes with it. On Linux
  // the post-exit drain bound is therefore unreachable in a sandbox; it is
  // the guard on a platform without a PID namespace.
  // B-11: strace writes the host's trace log through fd 5 and the watcher
  // reads the signal channel on fd 3; the command sees neither, so it can
  // neither forge a trace line nor read vx's signals.
  it("the command's shell holds neither the trace log nor the signal channel", async () => {
    const r = await runSandboxed(
      args('for fd in 3 5; do (: >&$fd) 2>/dev/null && echo "$fd open" || echo "$fd closed"; done'),
    )
    expect(r.stdout).toBe('3 closed\n5 closed\n')
  })

  // The watcher signals the command's GROUP: a child the command's shell
  // waits on hears vx's SIGTERM too, as it does untraced. The child writes
  // its marker once its trap is set.
  it("vx's signal reaches the command's children, not only its shell", async () => {
    const live = new Set<ReturnType<typeof Bun.spawn>>()
    const done = runSandboxed(
      args(
        // The shell waits its child out on TERM: the namespace ends with the
        // shell, and would otherwise take the child mid-trap.
        `trap 'wait' TERM; sh -c 'trap "echo child > got.txt; exit 0" TERM; echo up > ready.txt; while :; do sleep 0.05; done' & wait`,
        {
          config: resolveSandboxConfig(
            { allow: { read: ['.'], write: ['got.txt', 'ready.txt'] } },
            dir,
          ),
          liveChildren: live,
          // Bounds the mutant, whose child never hears the signal.
          timeoutMs: 10_000,
        },
      ),
    )
    const ready = path.join(dir, 'ready.txt')
    while (!existsSync(ready) || readFileSync(ready, 'utf8').trim() !== 'up') await Bun.sleep(20)
    for (const c of live) killTree(c, 'SIGTERM')
    await done
    expect(readFileSync(path.join(dir, 'got.txt'), 'utf8')).toBe('child\n')
  })

  it("keeps no descriptor on a traced task's log", async () => {
    // The descriptors that name a trace log, not the count of all: other
    // rows' descriptors come and go while this one runs.
    const logFds = (): string[] =>
      readdirSync('/proc/self/fd').flatMap((fd) => {
        try {
          const to = readlinkSync(path.join('/proc/self/fd', fd))
          return path.basename(to).startsWith('vx-strace-') ? [to] : []
        } catch {
          return []
        }
      })
    // The child has its own copy: vx's closes once the spawn is made (with
    // the close deleted, one stays per task, on the removed log).
    for (let i = 0; i < 3; i++) await runSandboxed(args('true'))
    expect(logFds()).toEqual([])
  })

  it('returns promptly when a backgrounded grandchild holds the pipe open', async () => {
    const t0 = Date.now()
    const r = await runSandboxed(args('sleep 10 & echo up'))
    expect([r.exitCode, r.stdout]).toEqual([0, 'up\n'])
    expect(Date.now() - t0).toBeLessThan(3000)
  }, 15_000)
})
