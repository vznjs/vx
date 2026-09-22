// The macOS profile is a string built from the config, so its injection
// boundary is testable on every platform: `macProfileRules` runs no
// seatbelt, it only decides what text reaches one. Item 478 found the one
// interpolation that skipped the check — the RESOLVED form of a declared
// unix socket, where a symlink separates what the user wrote from what the
// kernel sees — and item 582 closed it with a checker written for paths a
// filesystem hands back (a space is legal there; a quote is not).
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
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
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-sbpl-'))
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
