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
import { macProfileRules, sbplResolvedPath } from '../src/exec/sandbox-runtime.js'
import { UserError } from '../src/util/index.js'

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

describe('macProfileRules and a unix socket reached through a symlink', () => {
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
