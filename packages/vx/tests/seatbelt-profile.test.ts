// The macOS profile is a string built from the config, so its injection
// boundary is testable on every platform: `macProfileRules` runs no
// seatbelt, it only decides what text reaches one. Item 478 found the one
// interpolation that skipped the check — the RESOLVED form of a declared
// unix socket, where a symlink separates what the user wrote from what the
// kernel sees — and item 582 closed it with a checker written for paths a
// filesystem hands back (a space is legal there; a quote is not).
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  darwinWallRules,
  macProfileRules,
  resolveSandboxConfig,
  sbplResolvedPath,
  wallsGlobsReach,
} from '../src/exec/sandbox-runtime.js'
import { UserError } from '../src/util/index.js'

const WIN32 = process.platform === 'win32'

const base = { allowRead: [], allowWrite: [] }

describe('sbplResolvedPath', () => {
  it('refuses exactly what can leave the quoted string or the shell argument', () => {
    for (const bad of ['/a"b', "/a'b", '/a\\b', '/a\nb', '/a\x00b', '/a\x7fb']) {
      expect(() => sbplResolvedPath(bad, 'f')).toThrow(UserError)
    }
  })

  it('accepts what a real filesystem hands back: spaces, parens, unicode', () => {
    for (const ok of [
      '/Users/Jane Smith/x.sock',
      '/tmp/a (1)/x.sock',
      '/tmp/héllo/x.sock',
      '/private/tmp/x',
    ]) {
      expect(sbplResolvedPath(ok, 'f')).toBe(ok)
    }
  })
})

// Seatbelt is macOS's; its POSIX paths are not Windows'.
describe.skipIf(WIN32)('macProfileRules and a unix socket reached through a symlink', () => {
  let root: string
  beforeEach(async () => {
    // A short path directly under the OS temp dir, as the socket rows do:
    // seatbelt paths have a `sun_path` cap that a nested scratch dir exceeds.
    // REAL path: on macOS the temp dir is `/var/folders/…`, a symlink to
    // `/private/var/…`, so a path built under the unresolved root differs
    // from what `toRealPath` hands back and the two control rows below read
    // two grants where they expect one (the darwin job, 2026-09-22).
    root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-sbpl-')))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('REFUSES a link whose target carries a quote (the injection)', async () => {
    // The declared path passes `sbplPath`; only the resolved one holds the
    // metacharacters. Before item 582 this row's profile contained the
    // quote, and `(allow default)` after it would have rewritten the policy.
    const evil = path.join(root, 'a")(allow default)(')
    await mkdir(evil, { recursive: true })
    await writeFile(path.join(evil, 'x.sock'), '')
    const link = path.join(root, 'link.sock')
    await symlink(path.join(evil, 'x.sock'), link)
    expect(() => macProfileRules({ ...base, unixSockets: [link] })).toThrow(UserError)
    expect(() => macProfileRules({ ...base, unixSockets: [link] })).toThrow(
      'resolved from a symlink',
    )
  })

  it('CONTROL: a link whose target holds a space is granted at both paths', async () => {
    const home = path.join(root, 'Jane Smith')
    await mkdir(home, { recursive: true })
    await writeFile(path.join(home, 'x.sock'), '')
    const link = path.join(root, 'link.sock')
    await symlink(path.join(home, 'x.sock'), link)
    const rules = macProfileRules({ ...base, unixSockets: [link] })
    expect(rules).toContain(`(allow network-bind (local unix-socket (subpath "${link}")))`)
    expect(rules).toContain(
      `(allow network-bind (local unix-socket (subpath "${path.join(home, 'x.sock')}")))`,
    )
  })

  it('CONTROL: a plain declared path that resolves to itself is granted once', async () => {
    const sock = path.join(root, 'x.sock')
    await writeFile(sock, '')
    const rules = macProfileRules({ ...base, unixSockets: [sock] })
    expect(rules.filter((r) => r.startsWith('(allow network-bind'))).toHaveLength(1)
  })
})

// Item 652: each capability's rules, written out. The rows above drive only
// the unix-socket LIST, so the system-info, loopback, all-sockets and
// mach-lookup rules — and the refusals on a declared name or path — could
// each be deleted with the suite green. What reaches a profile is text, so
// every row compares the exact rule list.
describe('macProfileRules, capability by capability', () => {
  const LOOPBACK = [
    '(allow network-bind (local ip "*:*"))',
    '(allow network-inbound (local ip "*:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
  ]
  const ROWS: Array<[string, Record<string, unknown>, string[]]> = [
    ['nothing declared', {}, []],
    ['systemInfo', { systemInfo: ['hw.ncpu'] }, ['(allow system-info (info-type "hw.ncpu"))']],
    ['localBinding: true', { localBinding: true }, LOOPBACK],
    ['a localBinding port list', { localBinding: [3000] }, LOOPBACK],
    ['localBinding: false', { localBinding: false }, []],
    [
      'unixSockets: true',
      { unixSockets: true },
      [
        '(allow system-socket (socket-domain AF_UNIX))',
        '(allow network-bind (local unix-socket (path-regex #"^/")))',
        '(allow network-outbound (remote unix-socket (path-regex #"^/")))',
      ],
    ],
    ['an empty unixSockets list', { unixSockets: [] }, []],
    ['machLookup', { machLookup: ['com.x'] }, ['(allow mach-lookup (global-name "com.x"))']],
  ]
  for (const [what, extra, want] of ROWS) {
    it(what, () => {
      expect(macProfileRules({ ...base, ...extra })).toEqual(want)
    })
  }

  it('refuses a declared name or path that could leave its quoted string', () => {
    const refused = (extra: Record<string, unknown>): string => {
      try {
        macProfileRules({ ...base, ...extra })
        return 'accepted'
      } catch (err) {
        return err instanceof UserError ? err.message : `threw ${String(err)}`
      }
    }
    expect([
      refused({ systemInfo: ['hw")(allow default)("'] }),
      refused({ machLookup: ['com.x")'] }),
      refused({ unixSockets: ['/tmp/a"b.sock'] }),
      refused({ unixSockets: ['/tmp/../etc/x.sock'] }),
    ]).toEqual([
      `allow.systemInfo: 'hw")(allow default)("' is not a valid name`,
      `allow.machLookup: 'com.x")' is not a valid name`,
      `allow.unixSockets: '/tmp/a"b.sock' is not a valid path`,
      `allow.unixSockets: '/tmp/../etc/x.sock' is not a valid path`,
    ])
  })
})

// On Linux a glob's hit on a wall is dropped before the bind (B-1). Seatbelt
// matches the glob as a regex, so macOS denies each wall a glob reaches at
// the profile's tail, carving out a literal grant at or inside it (B-12).
describe.skipIf(WIN32)('darwinWallRules', () => {
  it('denies each reached wall, keeps literal grants inside it, and names nothing else', () => {
    expect(
      darwinWallRules(
        {
          allowRead: ['/w/**/*.ts', '/w/packages/b/src'],
          allowWrite: ['/w/out/*'],
          wallsReached: { read: ['/w/packages/b', '/w/.git'], write: ['/w/out/c'] },
        },
        ['/w/packages/b/node_modules', '/w/packages/bb'],
      ),
    ).toEqual([
      '(deny file-read-data (require-all (subpath "/w/packages/b") (require-not (subpath "/w/packages/b/src")) (require-not (subpath "/w/packages/b/node_modules"))))',
      '(deny file-read-data (subpath "/w/.git"))',
      '(deny file-write* (subpath "/w/out/c"))',
    ])
  })

  it('CONTROL: no wall reached is no rule', () => {
    expect(darwinWallRules({ allowRead: ['/w/*'], allowWrite: [] }, [])).toEqual([])
  })
})

// Which walls a glob reaches: one at or under its head, the parent of the
// wildcard's directory, as Linux's scan base is (`expandGrants`). A literal
// grant reaches none here (SRT re-emits the wall's deny after it), and a
// wall that only shares the head's name prefix is not under it (B-16).
describe('wallsGlobsReach', () => {
  it('reaches the walls at or under a glob’s head, and no other', () => {
    const walls = ['/w/packages/b', '/w/packages2/c', '/w/.git']
    expect([
      wallsGlobsReach(['/w/packages/x/*.ts'], walls),
      wallsGlobsReach(['/w/packages/b/*'], ['/w/packages']),
      wallsGlobsReach(['/w/packages'], walls),
      wallsGlobsReach(['/*'], walls),
    ]).toEqual([['/w/packages/b'], ['/w/packages'], [], walls])
  })
})

describe('darwinWallRules carve-outs', () => {
  it('carve out a literal at the wall itself, never a glob, and writes by the write grants', () => {
    expect(
      darwinWallRules(
        {
          allowRead: ['/w/packages/b', '/w/packages/b/*.ts'],
          allowWrite: ['/w/out/c/gen', '/w/out/c/*.log'],
          wallsReached: { read: ['/w/packages/b'], write: ['/w/out/c'] },
        },
        [],
      ),
    ).toEqual([
      '(deny file-read-data (require-all (subpath "/w/packages/b") (require-not (subpath "/w/packages/b"))))',
      '(deny file-write* (require-all (subpath "/w/out/c") (require-not (subpath "/w/out/c/gen"))))',
    ])
  })
})

// `resolveSandboxConfig`'s darwin branch, driven on any platform: a
// write-only glob reaches the walls too (a `.*` write could write `.git` on
// macOS), and literal grants reach none (B-16).
describe('the walls a darwin config reaches', () => {
  let dir = ''
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-reach-')))
    await mkdir(path.join(dir, 'src'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const asDarwin = <T>(f: () => T): T => {
    const d = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      return f()
    } finally {
      Object.defineProperty(process, 'platform', d)
    }
  }

  it('a write-only glob reaches them; literal grants reach none', () => {
    const walls = [path.join(dir, 'packages/b'), path.join(dir, '.git')]
    expect([
      asDarwin(() => resolveSandboxConfig({ allow: { write: ['.*'] } }, dir, walls).wallsReached),
      asDarwin(
        () => resolveSandboxConfig({ allow: { read: ['.', 'src'] } }, dir, walls).wallsReached,
      ),
    ]).toEqual([{ read: [], write: walls }, undefined])
  })
})
