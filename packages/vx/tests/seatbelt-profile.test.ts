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
import { wrapCommandWithSandboxMacOS } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js'
import {
  darwinWallRules,
  macProfileRules,
  resolveSandboxConfig,
  sbplResolvedPath,
  seatbeltBrackets,
  wallsGlobsReach,
} from '../src/exec/sandbox-runtime.js'
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
    [
      'systemInfo',
      { systemInfo: ['hw.ncpu'] },
      ['(allow system-info (info-type "hw.ncpu"))', '(allow sysctl-read (sysctl-name "hw.ncpu"))'],
    ],
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
describe('darwinWallRules', () => {
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

  it('a grant inside a wall spelled with escaped brackets keeps its path', () => {
    const wall = path.join(dir, 'packages/[legacy]')
    const grant = 'packages/\\[legacy\\]/src'
    const r = asDarwin(() =>
      resolveSandboxConfig({ allow: { read: [grant], write: [grant] } }, dir, [wall]),
    )
    expect(darwinWallRules(r, [])).toEqual([
      `(deny file-write* (require-all (subpath "${wall}") (require-not (subpath "${wall}/src"))))`,
    ])
  })
})

// SRT compiles any deny path holding `[` as a regex, where the bracket
// opens a class: a root project's wall on a nested project under
// `[legacy]/` matched `l`, `e`, … and never the directory itself.
describe('a seatbelt wall whose name holds a bracket', () => {
  const regexes = (denyRead: string[]): RegExp[] => {
    const cfg = seatbeltBrackets({
      filesystem: { denyRead, allowRead: ['/ws/app'], allowWrite: [], denyWrite: [] },
    })!.filesystem!
    const profile = wrapCommandWithSandboxMacOS({
      command: 'true',
      needsNetworkRestriction: false,
      readConfig: { denyOnly: cfg.denyRead, allowWithinDeny: cfg.allowRead! },
      writeConfig: { allowOnly: cfg.allowWrite, denyWithinAllow: [] },
    })
    return [...profile.matchAll(/\(regex ("(?:[^"\\]|\\.)*")\)/g)]
      .map((m) => JSON.parse(m[1]!) as string)
      .filter((r) => r.startsWith('^/ws/'))
      .map((r) => new RegExp(r))
  }

  it('denies the directory and its subtree, and not a class member', () => {
    const rx = regexes(['/ws', '/ws/app/[legacy]'])
    expect([
      rx.length > 0,
      rx.every((r) => r.test('/ws/app/[legacy]/src/a.ts')),
      rx.some((r) => r.test('/ws/app/l/src/a.ts')),
    ]).toEqual([true, true, false])
  })

  it('CONTROL: a plain wall is a subpath, no regex', () => {
    expect(regexes(['/ws', '/ws/app/legacy'])).toEqual([])
  })
})

// A baseline read (a `node_modules`, a linked dependency's directory) is a
// name the filesystem handed back, never a pattern, yet it reached SRT raw
// beside the task's grants: a dependency under `packages/[legacy]/`
// compiled as a class that matched `packages/l` and never the directory,
// and even spelled `[[]` a regex grants the entry alone, not its files.
// `darwinWallRules` took such a baseline for a glob too, so a root task's
// wall on that dependency carved nothing out. Linux binds it whole.
describe('a seatbelt baseline whose name holds a bracket', () => {
  const allowRegexes = (names: string[], grants: string[]): RegExp[] => {
    const cfg = seatbeltBrackets(
      {
        filesystem: {
          denyRead: ['/ws'],
          allowRead: [...names, ...grants],
          allowWrite: [],
          denyWrite: [],
        },
      },
      names,
    )!.filesystem!
    const profile = wrapCommandWithSandboxMacOS({
      command: 'true',
      needsNetworkRestriction: false,
      readConfig: { denyOnly: cfg.denyRead, allowWithinDeny: cfg.allowRead! },
      writeConfig: { allowOnly: cfg.allowWrite, denyWithinAllow: [] },
    })
    return [...profile.matchAll(/\(regex ("(?:[^"\\]|\\.)*")\)/g)]
      .map((m) => JSON.parse(m[1]!) as string)
      .filter((r) => r.startsWith('^/ws/'))
      .map((r) => new RegExp(r))
  }
  const granted = (rx: RegExp[], p: string): boolean => rx.some((r) => r.test(p))

  it('grants the directory and its subtree, and not a class member', () => {
    const rx = allowRegexes(['/ws/packages/[legacy]', '/ws/packages/odd]'], [])
    expect([
      granted(rx, '/ws/packages/[legacy]'),
      granted(rx, '/ws/packages/[legacy]/src/index.ts'),
      granted(rx, '/ws/packages/odd]/index.ts'),
      granted(rx, '/ws/packages/l'),
      granted(rx, '/ws/packages/l/index.ts'),
    ]).toEqual([true, true, true, false, false])
  })

  it("CONTROL: a task's grant keeps its spelling: an escape is a name, a bracket a class", () => {
    const rx = allowRegexes([], ['/ws/app/pages/\\[id\\].tsx', '/ws/app/[ab].ts'])
    expect([
      granted(rx, '/ws/app/pages/[id].tsx'),
      granted(rx, '/ws/app/pages/i.tsx'),
      granted(rx, '/ws/app/a.ts'),
      granted(rx, '/ws/app/[ab].ts'),
    ]).toEqual([true, false, true, false])
  })

  it('carves the baseline out of a wall a glob reaches', () => {
    expect(
      darwinWallRules(
        {
          allowRead: ['/w/**/*.ts'],
          allowWrite: [],
          wallsReached: { read: ['/w/[b]'], write: [] },
        },
        ['/w/[b]'],
      ),
    ).toEqual([
      '(deny file-read-data (require-all (subpath "/w/[b]") (require-not (subpath "/w/[b]"))))',
    ])
  })
})

// SRT rewrites `*` and `?` inside a class too, and compiles a backslash as
// a literal one, so a grant's escaped `a\*.txt` granted `a\bc.txt` — a name
// the task never declared — and never `a*.txt`. A baseline's `*` is a name
// as well, and matched its siblings.
describe('a seatbelt grant naming a literal star or question mark', () => {
  const allowRegexes = (names: string[], read: string[], write: string[]): RegExp[] => {
    const cfg = seatbeltBrackets(
      {
        filesystem: {
          denyRead: ['/ws'],
          allowRead: [...names, ...read],
          allowWrite: write,
          denyWrite: [],
        },
      },
      names,
    )!.filesystem!
    const profile = wrapCommandWithSandboxMacOS({
      command: 'true',
      needsNetworkRestriction: false,
      readConfig: { denyOnly: cfg.denyRead, allowWithinDeny: cfg.allowRead! },
      writeConfig: { allowOnly: cfg.allowWrite, denyWithinAllow: [] },
    })
    return [...profile.matchAll(/\(regex ("(?:[^"\\]|\\.)*")\)/g)]
      .map((m) => JSON.parse(m[1]!) as string)
      .filter((r) => r.startsWith('^/ws/'))
      .map((r) => new RegExp(r))
  }
  const granted = (rx: RegExp[], p: string): boolean => rx.some((r) => r.test(p))
  const stderrOf = <T>(fn: () => T): string[] => {
    const said: string[] = []
    const write = process.stderr.write
    process.stderr.write = (s: string | Uint8Array): boolean => {
      said.push(String(s))
      return true
    }
    try {
      fn()
    } finally {
      process.stderr.write = write
    }
    return said
  }

  it('grants no other name for an escaped one, read or write', () => {
    let rx: RegExp[] = []
    stderrOf(() => {
      rx = allowRegexes([], ['/ws/app/a\\*.txt'], ['/ws/app/q\\?.txt', '/ws/app/d\\*/**'])
    })
    expect(
      ['/ws/app/a\\bc.txt', '/ws/app/abc.txt', '/ws/app/q\\x.txt', '/ws/app/d\\x/f'].map((p) =>
        granted(rx, p),
      ),
    ).toEqual([false, false, false, false])
  })

  it("grants no sibling of a baseline's literal star", () => {
    let rx: RegExp[] = []
    stderrOf(() => {
      rx = allowRegexes(['/ws/node_modules/a*b'], [], [])
    })
    expect(granted(rx, '/ws/node_modules/aXb')).toBe(false)
  })

  it('CONTROL: a glob, and a glob after an escaped backslash, still match', () => {
    const rx = allowRegexes([], ['/ws/app/*.txt', '/ws/app/e\\\\*.txt'], [])
    expect(
      ['/ws/app/abc.txt', '/ws/app/e\\x.txt', '/ws/app/src/x.txt'].map((p) => granted(rx, p)),
    ).toEqual([true, true, false])
  })

  it('says so once per grant, naming the directory above it', () => {
    const cfg = {
      filesystem: { denyRead: [], allowRead: ['/w/once/x\\?.txt'], allowWrite: [], denyWrite: [] },
    }
    expect(
      stderrOf(() => {
        seatbeltBrackets(cfg)
        seatbeltBrackets(cfg)
      }),
    ).toEqual([
      '[vx] sandbox: the read grant /w/once/x\\?.txt names a literal ?, which the macOS ' +
        'sandbox reads as a pattern and cannot spell as a name, so it is not granted. Rename ' +
        'it, or grant the directory above it: /w/once/\n',
    ])
  })
})

// A task's escaped read grant names one directory, `out/[id]`. Linux scans
// it as a glob, finds the directory and binds it whole; macOS handed SRT
// `out/[[]id]`, an exact regex that granted the entry and none of its
// files, so the same config read the subtree on one platform only.
describe('an escaped directory read grant', () => {
  let dir = ''
  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-esc-')))
    await mkdir(path.join(dir, 'out/[id]/deep'), { recursive: true })
    await mkdir(path.join(dir, 'out/i'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const onPlatform = <T>(platform: string, f: () => T): T => {
    const d = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: platform })
    try {
      return f()
    } finally {
      Object.defineProperty(process, 'platform', d)
    }
  }
  const probes = (): string[] =>
    ['out/[id]', 'out/[id]/page.html', 'out/[id]/deep/a.js', 'out/i', 'out/[id]x'].map((p) =>
      path.join(dir, p),
    )
  const linuxGrants = (read: string): boolean[] => {
    const granted = onPlatform(
      'linux',
      () => resolveSandboxConfig({ allow: { read: [read] } }, dir).allowRead,
    )
    return probes().map((p) => granted.some((g) => p === g || p.startsWith(`${g}/`)))
  }
  const darwinGrants = (read: string): boolean[] => {
    const resolved = onPlatform('darwin', () =>
      resolveSandboxConfig({ allow: { read: [read] } }, dir),
    )
    const cfg = seatbeltBrackets({
      filesystem: {
        denyRead: [dir],
        allowRead: [...resolved.allowRead],
        allowWrite: [],
        denyWrite: [],
      },
    })!.filesystem!
    const profile = wrapCommandWithSandboxMacOS({
      command: 'true',
      needsNetworkRestriction: false,
      readConfig: { denyOnly: cfg.denyRead, allowWithinDeny: cfg.allowRead! },
      writeConfig: { allowOnly: cfg.allowWrite, denyWithinAllow: [] },
    })
    const rx = [...profile.matchAll(/\(regex ("(?:[^"\\]|\\.)*")\)/g)]
      .map((m) => JSON.parse(m[1]!) as string)
      .filter((r) => r.startsWith(`^${dir}/`))
      .map((r) => new RegExp(r))
    return probes().map((p) => rx.some((r) => r.test(p)))
  }

  it('grants the directory and its subtree on both platforms', () => {
    const expected = [true, true, true, false, false]
    expect([linuxGrants('out/\\[id\\]'), darwinGrants('out/\\[id\\]')]).toEqual([
      expected,
      expected,
    ])
  })

  it('CONTROL: the same grant spelled with a trailing `/**`', () => {
    const expected = [true, true, true, false, false]
    expect([linuxGrants('out/\\[id\\]/**'), darwinGrants('out/\\[id\\]/**')]).toEqual([
      expected,
      expected,
    ])
  })
})

// A grant whose only wildcards are escaped names one path, as a plain
// literal does: `packages/\[legacy\]/src` is the directory `[legacy]/src`.
// Counted as a glob, it reached every wall under `packages/` and its own
// wall was denied with no carve-out, so macOS refused the path it named;
// Linux's scan dropped the one hit as a wall. `packages/legacy/src` binds.
describe('an escaped literal grant and the walls', () => {
  const escaped = '/w/packages/\\[legacy\\]/src'
  const plain = '/w/packages/legacy/src'
  const wallOf = (g: string): string =>
    g === plain ? '/w/packages/legacy' : '/w/packages/[legacy]'

  it('reaches no wall, as the plain literal does', () => {
    expect([escaped, plain].map((g) => wallsGlobsReach([g], [wallOf(g), '/w/packages/b']))).toEqual(
      [[], []],
    )
  })

  it('is carved out of the wall a glob reaches, as the plain literal is', () => {
    expect(
      [escaped, plain].map((g) =>
        darwinWallRules(
          {
            allowRead: ['/w/**/*.ts', g],
            allowWrite: [g],
            wallsReached: { read: [wallOf(g)], write: [wallOf(g)] },
          },
          [],
        ),
      ),
    ).toEqual(
      ['/w/packages/[legacy]', '/w/packages/legacy'].map((w) => [
        `(deny file-read-data (require-all (subpath "${w}") (require-not (subpath "${w}/src"))))`,
        `(deny file-write* (require-all (subpath "${w}") (require-not (subpath "${w}/src"))))`,
      ]),
    )
  })

  it.skipIf(process.platform !== 'linux')(
    'binds on Linux inside a wall, as the plain literal does',
    async () => {
      const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-esc-')))
      try {
        const out: (readonly string[])[] = []
        for (const [name, grant] of [
          ['[legacy]', 'packages/\\[legacy\\]/src'],
          ['legacy', 'packages/legacy/src'],
        ] as const) {
          await mkdir(path.join(dir, 'packages', name, 'src'), { recursive: true })
          const walls = [path.join(dir, 'packages', name)]
          out.push(resolveSandboxConfig({ allow: { read: [grant] } }, dir, walls).allowRead)
        }
        expect(out).toEqual([
          [path.join(dir, 'packages/[legacy]/src')],
          [path.join(dir, 'packages/legacy/src')],
        ])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  )
})
