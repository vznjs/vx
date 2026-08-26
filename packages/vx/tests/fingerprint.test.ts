// The workspace fingerprint.
//
// `computeWorkspaceFingerprint` is folded into EVERY task's cache key
// (cache.ts:1212, as `{kind:'workspace', name:'fingerprint'}`), so it has the
// two properties every key component needs, and they pull against each other:
//
//   STABILITY    the same workspace must produce the same digest on every
//                machine and every run, or nothing ever hits.
//   SENSITIVITY  any change to a lockfile must produce a different one, or a
//                `bun install` that changes a dependency serves stale artifacts
//                built against the old one.
//
// The subtle half is stability. The loop runs over a DECLARED constant list,
// not a directory read, so the fold order cannot vary with filesystem
// enumeration order — which is exactly the kind of thing that differs between
// a developer's machine and a fresh CI checkout and would make a shared remote
// cache never hit. That is asserted directly rather than assumed.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { computeWorkspaceFingerprint } from '../src/workspace/index.js'

const dirs: string[] = []

function workspace(files: Record<string, string | Uint8Array> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-fp-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Every file the fingerprint folds, in the order the source declares them. */
const TRACKED = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'pnpm-workspace.yaml',
] as const

describe('shape of the digest', () => {
  it('is 16 lowercase hex characters', async () => {
    const fp = await computeWorkspaceFingerprint(workspace({ 'bun.lock': 'x' }))
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
  })

  it('pads a small digest to the full width', async () => {
    // The width is load-bearing the same way `xxh3hex`'s is: a short digest
    // would sort and compare differently from a padded one, and this string is
    // folded into a cache key. An empty workspace folds nothing, so the seed
    // stays 0n — the narrowest possible value, and the one that proves padding.
    expect(await computeWorkspaceFingerprint(workspace())).toBe('0000000000000000')
  })
})

describe('stability — the same workspace always folds the same digest', () => {
  it('is deterministic across repeated calls', async () => {
    const dir = workspace({ 'bun.lock': 'lock-v1', 'pnpm-workspace.yaml': 'packages:\n  - a' })
    const runs = await Promise.all([1, 2, 3].map(() => computeWorkspaceFingerprint(dir)))
    expect(new Set(runs).size).toBe(1)
  })

  it('does not depend on the order the files were CREATED', async () => {
    // The real hazard this guards: if the fold iterated a directory read
    // instead of the declared list, two checkouts of the same repo could fold
    // in different orders and never share a cache entry. Creating the same
    // files in opposite orders must be indistinguishable.
    const forwards = workspace()
    const backwards = workspace()
    const files: Array<[string, string]> = [
      ['bun.lock', 'B'],
      ['yarn.lock', 'Y'],
      ['pnpm-workspace.yaml', 'P'],
    ]
    for (const [n, c] of files) writeFileSync(path.join(forwards, n), c)
    for (const [n, c] of [...files].reverse()) writeFileSync(path.join(backwards, n), c)

    expect(await computeWorkspaceFingerprint(forwards)).toBe(
      await computeWorkspaceFingerprint(backwards),
    )
  })

  it('is independent of the workspace directory path', async () => {
    // Only file NAMES and CONTENT participate. If the absolute root leaked in,
    // a CI runner checking out to a different path would never hit the cache
    // a developer populated.
    const a = workspace({ 'bun.lock': 'same' })
    const b = workspace({ 'bun.lock': 'same' })
    expect(a).not.toBe(b)
    expect(await computeWorkspaceFingerprint(a)).toBe(await computeWorkspaceFingerprint(b))
  })

  it('ignores files that are not on the tracked list', async () => {
    const base = await computeWorkspaceFingerprint(workspace({ 'bun.lock': 'x' }))
    const noisy = await computeWorkspaceFingerprint(
      workspace({
        'bun.lock': 'x',
        'README.md': 'hello',
        'package.json': '{"name":"root"}',
        'deno.lock': 'not ours',
        'Cargo.lock': 'not ours',
      }),
    )
    // package.json is deliberately excluded here — it is hashed PER PROJECT via
    // projectPackageJsonHash, and folding it twice would be redundant.
    expect(noisy).toBe(base)
  })

  it('ignores a tracked filename that is not at the ROOT', async () => {
    // Only the workspace root is consulted. A nested package's own lockfile is
    // that project's business, and folding it here would make every task in
    // the workspace re-run when one leaf package updated a dependency.
    const base = await computeWorkspaceFingerprint(workspace({ 'bun.lock': 'root' }))
    const nested = await computeWorkspaceFingerprint(
      workspace({ 'bun.lock': 'root', 'packages/a/bun.lock': 'leaf' }),
    )
    expect(nested).toBe(base)
  })
})

describe('sensitivity — a lockfile change must move the digest', () => {
  for (const name of TRACKED) {
    it(`notices a content change in ${name}`, async () => {
      const before = await computeWorkspaceFingerprint(workspace({ [name]: 'v1' }))
      const after = await computeWorkspaceFingerprint(workspace({ [name]: 'v2' }))
      expect(after).not.toBe(before)
    })

    it(`notices ${name} appearing`, async () => {
      // Switching package manager, or a lockfile finally being committed.
      const without = await computeWorkspaceFingerprint(workspace({}))
      const with_ = await computeWorkspaceFingerprint(workspace({ [name]: '' }))
      expect(with_).not.toBe(without)
    })
  }

  it('notices a one-byte change', async () => {
    const a = await computeWorkspaceFingerprint(workspace({ 'bun.lock': 'aaaaaaaa' }))
    const b = await computeWorkspaceFingerprint(workspace({ 'bun.lock': 'aaaaaaab' }))
    expect(a).not.toBe(b)
  })

  it('notices a file being REMOVED, not just changed', async () => {
    const both = await computeWorkspaceFingerprint(workspace({ 'bun.lock': 'x', 'yarn.lock': 'y' }))
    const one = await computeWorkspaceFingerprint(workspace({ 'bun.lock': 'x' }))
    expect(one).not.toBe(both)
  })

  it('distinguishes an EMPTY tracked file from a missing one', async () => {
    // The sharpest presence case. A missing file folds nothing at all; an empty
    // one still folds its NAME. Without the name fold these would collide, and
    // committing an empty lockfile would not invalidate anything.
    const missing = await computeWorkspaceFingerprint(workspace({}))
    const empty = await computeWorkspaceFingerprint(workspace({ 'bun.lock': '' }))
    expect(empty).not.toBe(missing)
    expect(missing).toBe('0000000000000000')
  })

  it('distinguishes identical content under DIFFERENT tracked names', async () => {
    // `yarn.lock` holding X is a different workspace from `bun.lock` holding X
    // — different package manager, different resolution. The name fold is what
    // separates them; without it the two would share a cache namespace.
    const asYarn = await computeWorkspaceFingerprint(workspace({ 'yarn.lock': 'IDENTICAL' }))
    const asBun = await computeWorkspaceFingerprint(workspace({ 'bun.lock': 'IDENTICAL' }))
    expect(asYarn).not.toBe(asBun)
  })

  it('cannot be confused by content that mimics the name delimiter', async () => {
    // The fold is `xxh3(name + "\0")` then `xxh3(bytes)`, so a NUL inside the
    // content must not be able to forge a boundary and make two different
    // workspaces fold the same bytes — the ambiguity CACHE_VERSION v18 fixed
    // for env values.
    const a = await computeWorkspaceFingerprint(workspace({ 'bun.lock': 'yarn.lock\0payload' }))
    const b = await computeWorkspaceFingerprint(
      workspace({ 'bun.lock': '', 'yarn.lock': 'payload' }),
    )
    expect(a).not.toBe(b)
  })

  it('swapping the contents of two tracked files changes the digest', () => {
    // Order is fixed by the declared list, so (bun=A, yarn=B) and
    // (bun=B, yarn=A) fold different byte sequences. If the name were not
    // folded, or the order were content-derived, these could collide.
    return (async () => {
      const one = await computeWorkspaceFingerprint(
        workspace({ 'bun.lock': 'A', 'yarn.lock': 'B' }),
      )
      const two = await computeWorkspaceFingerprint(
        workspace({ 'bun.lock': 'B', 'yarn.lock': 'A' }),
      )
      expect(one).not.toBe(two)
    })()
  })
})

describe('content the fold must survive', () => {
  it('handles binary content', async () => {
    // `bun.lockb` is genuinely binary, and the fold reads bytes rather than
    // text — so invalid UTF-8 must not throw or be lossily decoded.
    const bytes = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x7f, 0xc3, 0x28])
    const fp = await computeWorkspaceFingerprint(workspace({ 'bun.lockb': bytes }))
    expect(fp).toMatch(/^[0-9a-f]{16}$/)

    const flipped = new Uint8Array(bytes)
    flipped[0] = 0x01
    expect(await computeWorkspaceFingerprint(workspace({ 'bun.lockb': flipped }))).not.toBe(fp)
  })

  it('handles unicode and NUL bytes in content', async () => {
    const fp = await computeWorkspaceFingerprint(workspace({ 'bun.lock': 'café 🎉  中文\r\n' }))
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
  })

  it('handles a large lockfile', async () => {
    // Real lockfiles reach megabytes; the fold reads the whole file, so this
    // pins that there is no size ceiling and that content still matters at
    // the tail (a truncating read would miss the final byte).
    const big = 'dep\n'.repeat(200_000)
    const a = await computeWorkspaceFingerprint(workspace({ 'pnpm-lock.yaml': big }))
    const b = await computeWorkspaceFingerprint(workspace({ 'pnpm-lock.yaml': `${big}x` }))
    expect(a).not.toBe(b)
  })

  it('folds every tracked file present, not just the first', async () => {
    // A `break` instead of `continue` on the first hit would silently stop
    // tracking every later entry in the list — the workspace-definition file
    // most of all, since it is declared last.
    const all: Record<string, string> = {}
    for (const n of TRACKED) all[n] = 'v1'
    const base = await computeWorkspaceFingerprint(workspace(all))

    // Changing the LAST declared file alone must still move the digest.
    const lastChanged = { ...all, 'pnpm-workspace.yaml': 'v2' }
    expect(await computeWorkspaceFingerprint(workspace(lastChanged))).not.toBe(base)
  })
})

describe('degenerate roots', () => {
  it('returns the empty digest for a directory with none of the files', async () => {
    expect(await computeWorkspaceFingerprint(workspace({ 'notes.txt': 'x' }))).toBe(
      '0000000000000000',
    )
  })

  it('does not throw on a nonexistent root', async () => {
    // `prepareRun` resolves the root before calling, so this is defensive —
    // but a throw here would abort the whole run rather than degrade.
    const gone = path.join(os.tmpdir(), 'vx-fp-does-not-exist-' + String(process.pid))
    expect(await computeWorkspaceFingerprint(gone)).toBe('0000000000000000')
  })

  it('does not mistake a DIRECTORY named like a lockfile for content', async () => {
    // A stray `bun.lock/` directory must not crash the run. Whatever the
    // verdict is, it has to be a digest rather than a throw.
    const dir = workspace()
    mkdirSync(path.join(dir, 'bun.lock'))
    expect(await computeWorkspaceFingerprint(dir)).toMatch(/^[0-9a-f]{16}$/)
  })
})
