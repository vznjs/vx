// macOS: what vx adds to SRT's seatbelt profile for a task: grants spelled
// as seatbelt reads them, the profile rules a task's config asks for, and
// the walls a glob grant stops at.

import path from 'node:path'
import { lstatSync } from 'node:fs'
import type { ResolvedSandboxConfig } from '../exec/index.js'
import { notify, UserError } from '../util/index.js'
import type { TaskSandboxConfig } from './binds.js'
import {
  atOrUnder,
  localBindingOn,
  loopbackPorts,
  wildcardAt,
  namedPath,
  toRealPath,
  unique,
} from './paths.js'

/**
 * macOS: a grant's escaped bracket as seatbelt's SRT can read it. vx hands
 * it the pattern, and SRT compiles any spelling holding `[` as a regex in
 * which a backslash is a literal one, so `pages/\[id\].tsx` matched no
 * file and the route could not be granted. `[[]` is a class of one `[`; a
 * lone `]` is plain text (B-65). A deny path is a real directory, never a
 * pattern: a nested project's wall under `[legacy]/` compiled as a class,
 * matched nothing, and the root task read it. So is each of `names`, the
 * baseline reads: a linked dependency under `packages/[legacy]/` was a
 * class too, and as an exact regex even `[[]` grants the directory's entry
 * and none of its files, so its subtree is granted beside it (a trailing
 * `/**` is stripped before the compile). A task's read grant whose only
 * brackets are escaped names one path too, and Linux binds it whole, so
 * it gets the same subtree: `out/\[id\]` read `out/[id]` and none of it.
 *
 * A `*` or `?` meant as itself (escaped in a grant, or in a baseline's
 * name) has no spelling: SRT's rewrite of each runs inside a class too,
 * and a backslash compiles as a literal one, so `a\*.txt` granted
 * `a\bc.txt` and never `a*.txt`. Left out and said once, as on Linux
 * (`bindableReads`).
 */
export function seatbeltBrackets(
  config: TaskSandboxConfig | undefined,
  names: readonly string[] = [],
): TaskSandboxConfig | undefined {
  const fs = config?.filesystem
  if (fs === undefined) return config
  const literal = (p: string): string => p.replaceAll('\\[', '[[]').replaceAll('\\]', ']')
  const bracketed = new Set(names.filter((n) => /[[\]]/.test(n)))
  const baseline = new Set(names)
  const read = (p: string): string[] => {
    if (!seatbeltSpells(p, 'read', baseline.has(p))) return []
    const name = bracketed.has(p) ? p : /\\[[\]]/.test(p) ? namedPath(p) : undefined
    if (name === undefined) return [patternOnly(literal(p))]
    const at = name.replaceAll('[', '[[]')
    return [at, `${at}/**/*`]
  }
  return {
    ...config,
    filesystem: {
      ...fs,
      denyRead: fs.denyRead.map((p) => p.replaceAll('[', '[[]')),
      allowWrite: fs.allowWrite
        .filter((p) => seatbeltSpells(p, 'write', false))
        .map((p) => patternOnly(literal(p))),
      ...(fs.allowRead !== undefined
        ? { allowRead: [...new Set(fs.allowRead.flatMap(read))] }
        : {}),
    },
  }
}

/**
 * A grant's pattern and nothing else. SRT (0.0.81) also reads an allow
 * entry holding a bracket as the name it spells wherever that is on disk,
 * so the class `pages/[id].tsx` (`i` or `d`) granted a file named
 * `[id].tsx` too. Each class takes its last member again, the same class,
 * until the name the spelling makes is not on disk.
 */
function patternOnly(grant: string): string {
  if (!grant.includes('[')) return grant
  let out = grant
  for (let n = 1; n <= 8 && namedOnDisk(out); n++) {
    out = grant.replace(/\[([^\]]+)\]/g, (_, c: string) => `[${c}${c.at(-1)!.repeat(n)}]`)
  }
  return out
}

/** Whether a component holding a bracket names something on disk, as SRT probes it. */
function namedOnDisk(spelling: string): boolean {
  const parts = spelling.split('/')
  for (let i = 1; i <= parts.length; i++) {
    if (!/[[\]]/.test(parts[i - 1]!)) continue
    try {
      lstatSync(parts.slice(0, i).join('/') || '/')
      return true
    } catch {
      // not there: this component is only a pattern
    }
  }
  return false
}

/** A `*` or `?` behind an odd run of backslashes: the grant means the character. */
const ESCAPED_WILDCARD = /(?:^|[^\\])(?:\\\\)*\\[*?]/

const warnedUnspellable = new Set<string>()

/** Whether seatbelt's SRT can take `grant` as written; said once when not. */
function seatbeltSpells(grant: string, kind: 'read' | 'write', name: boolean): boolean {
  const m = name ? /[*?]/.exec(grant) : ESCAPED_WILDCARD.exec(grant)
  if (m === null) return true
  const at = name ? m.index : m.index + m[0].length - 2
  if (!warnedUnspellable.has(`${kind} ${grant}`)) {
    warnedUnspellable.add(`${kind} ${grant}`)
    notify({
      kind: 'line',
      tone: 'warn',
      text:
        `[vx] sandbox: the ${kind} grant ${grant} names a literal ${grant[at + (name ? 0 : 1)]}, ` +
        `which the macOS sandbox reads as a pattern and cannot spell as a name, so it is not ` +
        `granted. Rename it, or grant the directory above it: ` +
        `${grant.slice(0, grant.lastIndexOf(path.sep, at) + 1)}\n`,
    })
  }
  return false
}

/**
 * A token safe to interpolate into a seatbelt profile. The profile travels
 * inside a shell-quoted `sandbox-exec -p '…'` argument, so a value carrying
 * a quote, paren or backslash could rewrite the policy or escape the
 * argument. Refuse rather than escape — every real info type is a plain
 * dotted name.
 */
function sbplToken(value: string, field: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new UserError(`${field}: '${value}' is not a valid name`)
  }
  return value
}

/**
 * The capabilities that reach the macOS profile as rules rather than
 * through SRT's config.
 *
 * `systemInfo` has no SRT field at any level. The rest DO have fields,
 * but SRT reads `network.allowLocalBinding` / `allowUnixSockets` /
 * `allowMachLookup` / `enableWeakerNetworkIsolation` off the config given to `initialize()` and never off
 * the per-call one (`sandbox-manager.js` getters, 0.0.75 and 0.0.76) — so a per-task
 * grant passed there is silently dropped. vx is per-task by definition,
 * so it emits them itself. The rule text mirrors SRT's own.
 */
export function macProfileRules(c: ResolvedSandboxConfig): string[] {
  const rules: string[] = []
  // A name is an info type to one caller and a sysctl to another (Bun
  // reads `hw.optional.neon` with sysctl-read), so it grants both.
  for (const t of c.systemInfo ?? []) {
    const name = sbplToken(t, 'allow.systemInfo')
    rules.push(`(allow system-info (info-type "${name}"))`)
    rules.push(`(allow sysctl-read (sysctl-name "${name}"))`)
  }
  if (localBindingOn(c)) {
    // `*:*`, not `localhost:*`: a dual-stack socket bound to 127.0.0.1 is
    // ::ffff:127.0.0.1 in the kernel, which seatbelt's `localhost` does
    // not match. bind and inbound carry no remote endpoint, so this is
    // not egress. Egress stays pinned to loopback.
    rules.push('(allow network-bind (local ip "*:*"))')
    rules.push('(allow network-inbound (local ip "*:*"))')
    rules.push('(allow network-outbound (remote ip "localhost:*"))')
  }
  // A loopback port the network list names is dialled directly (the
  // proxy is skipped for loopback), so the profile allows that port alone.
  const ports = loopbackPorts(c.network)
  for (const p of ports) {
    rules.push(`(allow network-outbound (remote ip "localhost:${p}"))`)
  }
  // curl asks configd for the proxy settings before it dials; refused, the
  // record failed a client that had its answer (exit 0, CI 2026-11-12).
  if (ports.length > 0)
    rules.push('(allow mach-lookup (global-name "com.apple.SystemConfiguration.configd"))')
  if (c.weakerNetworkIsolation === true) {
    rules.push('(allow mach-lookup (global-name "com.apple.trustd.agent"))')
  }
  if (c.unixSockets === true) {
    rules.push('(allow system-socket (socket-domain AF_UNIX))')
    rules.push('(allow network-bind (local unix-socket (path-regex #"^/")))')
    rules.push('(allow network-outbound (remote unix-socket (path-regex #"^/")))')
  } else if (c.unixSockets !== undefined && c.unixSockets.length > 0) {
    rules.push('(allow system-socket (socket-domain AF_UNIX))')
    for (const sock of c.unixSockets) {
      // Both the declared path and what it resolves to: seatbelt matches the
      // path the kernel sees, and on macOS `/tmp` is a symlink to
      // `/private/tmp` — a grant on the former alone never matches.
      for (const p of unique([
        sbplPath(sock, 'allow.unixSockets'),
        sbplResolvedPath(toRealPath(sock), 'allow.unixSockets'),
      ])) {
        rules.push(`(allow network-bind (local unix-socket (subpath "${p}")))`)
        rules.push(`(allow network-outbound (remote unix-socket (subpath "${p}")))`)
      }
    }
  }
  for (const name of c.machLookup ?? []) {
    rules.push(`(allow mach-lookup (global-name "${sbplToken(name, 'allow.machLookup')}"))`)
  }
  return rules
}

/**
 * A path safe to interpolate into a seatbelt profile. Same reasoning as
 * {@link sbplToken}, with the separators a path needs.
 */
function sbplPath(value: string, field: string): string {
  if (!/^[A-Za-z0-9._\-/@+]+$/.test(value) || value.includes('..')) {
    throw new UserError(`${field}: '${value}' is not a valid path`)
  }
  return value
}

/**
 * The check for a path the FILESYSTEM handed back (`toRealPath` of a
 * declared socket), which the declared-value allowlist above is wrong for:
 * a real macOS home is `/Users/Jane Smith`, and refusing the space would
 * regress every such layout to close a hole. What can leave the quoted
 * SBPL string, or the single-quoted `sandbox-exec -p '…'` argument it
 * travels in, is exactly a double quote, a backslash, a single quote, or a
 * control character — so only those are refused. Item 478 recorded the
 * hole (a symlink whose TARGET carries a quote went into the profile
 * unchecked, because the check was on the string the user wrote and the
 * interpolation was of the string the kernel resolves); item 582 closed
 * it. Refuse, never escape, as the sibling checkers do.
 */
export function sbplResolvedPath(value: string, field: string): string {
  // eslint-disable-next-line no-control-regex -- the control range is the point
  if (/["'\\\x00-\x1f\x7f]/.test(value)) {
    throw new UserError(
      `${field}: '${value}' (resolved from a symlink) carries a quote, a backslash or a control ` +
        `character, which cannot go into a seatbelt profile; point the link at a plain path`,
    )
  }
  return value
}

/**
 * Add rules to the END of the seatbelt profile SRT generated.
 *
 * SBPL is last-match-wins, so the tail is the only place a rule of ours
 * outranks one of SRT's. Measured 2026-09-05: the same rules injected
 * after the `(deny default …)` header were inert in both directions —
 * SRT's own later clauses won. Filesystem capabilities still go through
 * SRT's config, where they also work on Linux; what arrives here is what
 * SRT's per-call config CANNOT carry.
 *
 * A profile that does not have the expected shape THROWS. Silently
 * running a task without a capability it asked for is worse than not
 * offering the capability.
 */
export function injectProfileRules(wrapped: string, rules: readonly string[]): string {
  const anchor = /sandbox-exec -p '\(version 1\)\n\(deny default[^\n]*\n/.exec(wrapped)
  if (anchor === null) {
    throw new UserError(
      'sandbox: the OS sandbox policy did not have the expected shape, so the ' +
        'capabilities this task declared could not be applied',
    )
  }
  // The profile is a single-quoted shell argument; SRT escapes a literal
  // quote inside it as `'"'"'` (5 chars). The first bare `'` after the
  // header therefore closes the profile.
  let i = anchor.index + anchor[0].length
  for (;;) {
    const q = wrapped.indexOf("'", i)
    if (q === -1) {
      throw new UserError(
        'sandbox: the OS sandbox policy was not quoted as expected, so the ' +
          'capabilities this task declared could not be applied',
      )
    }
    if (wrapped.startsWith(`'"'"'`, q)) {
      i = q + 5
      continue
    }
    return `${wrapped.slice(0, q)}\n${rules.join('\n')}\n${wrapped.slice(q)}`
  }
}

/**
 * The walls a glob grant can reach: each one under (or at) a glob's
 * literal head. On Linux `expandGrants` drops such a hit before the bind
 * (B-1); seatbelt matches a glob as a path regex, with no hit to drop.
 */
export function wallsGlobsReach(grants: readonly string[], walls: readonly string[]): string[] {
  const heads = grants
    .filter((g) => namedPath(g) === undefined)
    .map((g) => path.dirname(g.slice(0, wildcardAt(g))))
  return walls.filter((w) => heads.some((h) => atOrUnder(w, h)))
}

/**
 * macOS: the grant rules vx appends. The listings come first so a wall's
 * deny, later, wins: SBPL is last-match-wins.
 */
export function darwinGrantRules(
  c: Pick<ResolvedSandboxConfig, 'wallsReached' | 'allowRead' | 'allowWrite'>,
  baseAllowRead: readonly string[],
  anchors: readonly string[],
): string[] {
  return [...darwinAncestorRules(c, anchors), ...darwinWallRules(c, baseAllowRead)]
}

/**
 * macOS: each directory above a grant may be listed, as on Linux. bwrap
 * makes every directory above a mount, so a task granted
 * `../vx-*\/package.json` could glob it from `..`; seatbelt matches paths
 * and refused the listing (EPERM), so `@vzn/vx-docs#import` failed on
 * every Mac (2026-10-17). Above the glob that is each literal directory
 * strictly inside a deny anchor (outside one, all is readable already);
 * a directory the glob itself names (`vx-a/`) is matched as a regex, and
 * under a `**` any directory is. The rules grant directories only, never
 * a file, and come before the wall denies, which still win.
 *
 * A listing shows every name in the directory, where Linux's scaffold
 * shows only what it mounted: names, never a file's data. Not the anchor
 * itself: Bun, shown the workspace root's `package.json` it
 * may not read, failed with "Cannot read file" (EPERM).
 */
export function darwinAncestorRules(
  c: Pick<ResolvedSandboxConfig, 'allowRead' | 'allowWrite'>,
  anchors: readonly string[],
): string[] {
  const literals = new Set<string>()
  const patterns = new Set<string>()
  // Grants are canonical already (`resolveSandboxConfig`), and so is each
  // directory above one: no realpath here, at every spawn.
  const inside = (d: string): boolean => anchors.some((a) => d !== a && atOrUnder(d, a))
  for (const g of [...c.allowRead, ...c.allowWrite]) {
    const named = namedPath(g)
    const head = g.slice(0, wildcardAt(g))
    const cut = head.lastIndexOf('/')
    const top = named !== undefined ? path.dirname(named) : head.slice(0, cut) || '/'
    for (let d = top; inside(d); d = path.dirname(d)) literals.add(d)
    if (named !== undefined || g.includes('\\')) continue
    let re = top === '/' ? '' : regexLiteral(top)
    for (const part of g
      .slice(cut + 1)
      .split('/')
      .slice(0, -1)) {
      if (part === '**') {
        patterns.add(`^${re}(/.*)?$`)
        break
      }
      re += `/${part
        .replace(/[.^$+{}()|]/g, '[$&]')
        .replaceAll('*', '[^/]*')
        .replaceAll('?', '[^/]')}`
      patterns.add(`^${re}$`)
    }
  }
  // A name seatbelt's quoted string cannot hold keeps today's refusal
  // rather than failing the task (`sbplResolvedPath` would throw).
  const spellable = (p: string): boolean => !UNSPELLABLE.test(p)
  return [
    ...[...literals].filter(spellable).map((d) => `(allow file-read-data (literal "${d}"))`),
    ...[...patterns]
      .filter(spellable)
      .map((r) => `(allow file-read-data (require-all (vnode-type DIRECTORY) (regex #"${r}")))`),
  ]
}

// eslint-disable-next-line no-control-regex -- the control range is the point
const UNSPELLABLE = /["'\\\x00-\x1f\x7f]/

/** A real path as a regex matching only itself: each special in a class of one. */
function regexLiteral(p: string): string {
  return p.replace(/[.^$+{}()|*?[\]]/g, (ch) => `[${ch}]`)
}

/**
 * macOS: the walls a glob grant reaches, denied at the profile's tail
 * (SBPL is last-match-wins). SRT re-emits a wall's deny after the allows
 * only under a LITERAL allow, so a root project's `read: ['**\/*.ts']`
 * read nested projects' sources its key excludes — item 1010's stale hit,
 * by glob, on darwin (B-12). A literal grant at or inside the wall, the
 * task's or a baseline's (a linked dependency), is carved out: on Linux
 * too it binds. Reads deny the data, not the metadata, as SRT's own wall
 * denies do: a walk may still stat the directory.
 */
export function darwinWallRules(
  c: Pick<ResolvedSandboxConfig, 'wallsReached' | 'allowRead' | 'allowWrite'>,
  baseAllowRead: readonly string[],
): string[] {
  const rules: string[] = []
  const deny = (op: string, walls: readonly string[], literals: readonly string[]): void => {
    for (const w of walls) {
      const at = `(subpath "${sbplResolvedPath(w, 'wall')}")`
      const kept = literals
        .filter((l) => atOrUnder(l, w))
        .map((l) => `(require-not (subpath "${sbplResolvedPath(l, 'grant')}"))`)
      rules.push(
        kept.length === 0
          ? `(deny ${op} ${at})`
          : `(deny ${op} (require-all ${at} ${kept.join(' ')}))`,
      )
    }
  }
  // A baseline is a name the filesystem handed back, never a pattern: a
  // bracket in it does not make it a glob.
  const named = (grants: readonly string[]): string[] => grants.flatMap((g) => namedPath(g) ?? [])
  deny('file-read-data', c.wallsReached?.read ?? [], [...named(c.allowRead), ...baseAllowRead])
  deny('file-write*', c.wallsReached?.write ?? [], named(c.allowWrite))
  return rules
}
