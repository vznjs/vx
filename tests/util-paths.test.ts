// `toPosix` / `relPosix` are four lines of code that decide what a CACHE KEY
// says. `Cache.key()` folds `${relPosix(workspaceRoot, file)}\0${oid}` for
// every input file (src/cache/cache.ts:1279), so a rel that comes out wrong
// is a wrong key — either a stale hit (two distinct files sharing a rel) or a
// cache-wide invalidation (the same file changing rel). The lockfile
// (src/workspace/lockfile.ts:100, src/cli/lock.ts:59) stores rels as MAP KEYS
// that must reproduce byte-for-byte on another machine, and
// `findWorkspaceRoot` feeds a rel straight into `Bun.Glob.match`
// (src/workspace/workspace.ts:92) to decide which directory IS the workspace
// root.
//
// The load-bearing property is counter-intuitive: on this platform `toPosix`
// is the IDENTITY. `path.sep` is '/', so there is nothing to convert, and the
// documented fast path returns the input untouched. That is not merely an
// optimisation — it is the CORRECT answer, because a POSIX filename may
// legally contain a backslash. An implementation that reached for a literal
// '\\' (the "obvious" cross-platform fix) would fold `a\b` and `a/b` onto the
// same rel and hand back the wrong artifact. Most of this file exists to make
// that specific mistake impossible to land quietly.
//
// `paths.ts` is exercised BOTH ways on purpose: `toPosix` is module-internal
// (tests may reach internals, see tests/module-boundaries.test.ts) while
// `relPosix` is on the util CONTRACT, which is the only door its six
// cross-module callers may use.

import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { relPosix as relPosixViaBarrel } from '../src/util/index.js'
import { relPosix, toPosix } from '../src/util/paths.js'

/**
 * Every input shape a path string can take here, including the ones that are
 * only legal on POSIX. Reused by the identity, equivalence and no-normalise
 * blocks so none of them can drift into testing a narrower corpus than the
 * others.
 */
const CORPUS: ReadonlyArray<readonly [label: string, value: string]> = [
  ['empty', ''],
  ['dot', '.'],
  ['dot-dot', '..'],
  ['bare root', '/'],
  ['relative file', 'a/b/c.ts'],
  ['absolute file', '/root/pkg/src/index.ts'],
  ['leading ./', './a/b'],
  ['embedded ..', 'a/../b'],
  ['trailing slash', 'a/b/'],
  ['trailing double slash', 'a/b//'],
  ['doubled slash', 'a//b'],
  ['triple slash', '///'],
  ['single backslash', '\\'],
  ['backslash in a name', 'we\\ird.ts'],
  ['backslash as a fake separator', 'a\\b'],
  ['doubled backslash', 'a\\\\b'],
  ['mixed separators', 'a\\b/c\\d'],
  ['windows-looking absolute', 'C:\\Users\\x\\y'],
  ['UNC-looking', '\\\\server\\share'],
  ['newline in a name', 'line\nbreak.ts'],
  ['carriage return', 'cr\rfile.ts'],
  ['tab', 'ta\tb.ts'],
  ['space', 'a b/c d.ts'],
  ['NUL', 'a\0b'],
  ['dotfile', '.hidden/.config'],
  ['NFC é', 'caf\u00e9.ts'],
  ['NFD é', 'cafe\u0301.ts'],
  ['CJK', '日本語/ファイル.ts'],
  ['emoji', '\u{1F389}/party.ts'],
  ['RTL override', '\u202Egnp.exe'],
  ['lone high surrogate', '\uD800'],
  ['lone low surrogate', '\uDFFF'],
  ['glob metacharacters', 'a[b]*?{c}.ts'],
  ['very long', `${'x'.repeat(4096)}/y`],
]

/** What a hard-coded-Windows-separator implementation would return. */
const slashifyBackslashes = (p: string): string => p.split('\\').join('/')

describe('toPosix — the platform premise', () => {
  // Every expectation below flips on Windows. Assert the premise explicitly so
  // a run on another platform fails HERE, naming the reason, instead of
  // producing a wall of confusing diffs in the identity blocks.
  it('runs on a POSIX platform, where path.sep is already "/"', () => {
    expect(path.sep).toBe('/')
    expect(path.sep).toBe(path.posix.sep)
    expect(path.sep).not.toBe(path.win32.sep)
  })
})

describe('toPosix — the fast path is the identity', () => {
  // The headline property. `IS_POSIX` is captured once at module load, so if
  // that constant were ever computed wrongly (or the branch inverted) EVERY
  // input file's rel would change and every cache entry in the world would be
  // orphaned with no version bump and no error.
  for (const [label, value] of CORPUS) {
    it(`returns ${label} unchanged`, () => {
      expect(toPosix(value)).toBe(value)
    })
  }

  it('is the identity over the whole corpus in one assertion', () => {
    // A single failing entry in the per-case list above is easy to skim past;
    // this states the invariant as one fact about the function.
    const changed = CORPUS.filter(([, v]) => toPosix(v) !== v).map(([l]) => l)
    expect(changed).toEqual([])
  })

  it('does not mutate or re-encode a huge string', () => {
    // Called once per input file per key derivation; a hidden copy/normalise
    // on a deep monorepo path would be both a perf and a correctness change.
    const big = 'packages/deep/'.repeat(10_000) + 'index.ts'
    expect(toPosix(big)).toBe(big)
    expect(toPosix(big)).toHaveLength(big.length)
  })
})

describe('toPosix — the fast path is EQUIVALENT to the slow path', () => {
  // `split(x).join('/')` is the identity whenever x === '/', which is exactly
  // when the fast path is taken — so the branch is a pure optimisation and
  // both arms must agree on every input. This is the assertion that fails if
  // anyone hard-codes the separator: `'a\\b'.split('\\').join('/')` is
  // 'a/b', while `.split(path.sep)` leaves it alone.
  it('agrees with p.split(path.sep).join("/") on every corpus entry', () => {
    const disagreed = CORPUS.filter(([, v]) => toPosix(v) !== v.split(path.sep).join('/')).map(
      ([l]) => l,
    )
    expect(disagreed).toEqual([])
  })

  it('the slow path really is a no-op here (the premise of the fast path)', () => {
    // Guards the reasoning above rather than the code: if path.sep stopped
    // being '/', split/join would stop being the identity and the two arms
    // would diverge — which is precisely the Windows case the branch exists
    // for. Stated so the equivalence test can never rot into a tautology.
    for (const [, v] of CORPUS) expect(v.split(path.sep).join('/')).toBe(v)
    expect('a\\b'.split(path.win32.sep).join('/')).toBe('a/b')
  })
})

describe('toPosix — a backslash is a NAME character, not a separator', () => {
  // The sharpest failure this file guards. On Linux only '/' and NUL are
  // forbidden in a filename, so `a\b` is a single legal name. Converting it
  // would make two genuinely different files share one cache-key rel.
  it('keeps a literal backslash, which a slashifying rewrite would destroy', () => {
    expect(toPosix('a\\b')).toBe('a\\b')
    // The bug, spelled out: the two would become indistinguishable.
    expect(slashifyBackslashes('a\\b')).toBe('a/b')
    expect(toPosix('a\\b')).not.toBe(toPosix('a/b'))
  })

  it('never collapses distinct corpus entries onto one another', () => {
    // Injectivity over the whole corpus: the transformation may not merge two
    // inputs. A slashifying implementation merges 'a\\b' with 'a/b' and
    // 'a\\b/c\\d' with... nothing here, but the first pair alone is a stale
    // hit. Deduped by VALUE first so the corpus's own uniqueness is the only
    // thing being asserted about.
    const inputs = [...new Set(CORPUS.map(([, v]) => v))]
    const outputs = new Set(inputs.map(toPosix))
    expect(outputs.size).toBe(inputs.length)

    // ...and the same corpus under the slashifying rewrite genuinely DOES
    // collapse, so the assertion above is discriminating rather than lucky.
    expect(new Set(inputs.map(slashifyBackslashes)).size).toBeLessThan(inputs.length)
  })
})

describe('toPosix — it converts, it does not normalise', () => {
  // Callers rely on `path.relative` (relPosix) or on git enumeration (which
  // already yields clean rels) for normalisation. If toPosix started
  // normalising, `Cache.key` rels would change for every task that has ever
  // hashed a path with a redundant segment — a silent workspace-wide miss.
  it('leaves redundant separators, "." and ".." segments alone', () => {
    expect(toPosix('a//b')).toBe('a//b')
    expect(toPosix('./a/b')).toBe('./a/b')
    expect(toPosix('a/./b')).toBe('a/./b')
    expect(toPosix('a/../b')).toBe('a/../b')
    expect(toPosix('a/b/')).toBe('a/b/')
  })

  it('leaves unicode normalisation form alone', () => {
    // 'café' as one code point and as e+U+0301 are two DIFFERENT directory
    // entries on Linux. Folding them would let one file's artifact restore
    // over the other's.
    const nfc = 'caf\u00e9.ts'
    const nfd = 'cafe\u0301.ts'
    expect(nfc).not.toBe(nfd)
    expect(toPosix(nfc)).toBe(nfc)
    expect(toPosix(nfd)).toBe(nfd)
    expect(toPosix(nfc)).not.toBe(toPosix(nfd))
  })

  it('passes a lone surrogate through without substitution', () => {
    // Contrast with relPosix below, where `path.relative` DOES substitute
    // U+FFFD. Pinned separately so the lossy step is attributed correctly.
    expect(toPosix('\uD800')).toBe('\uD800')
    expect(toPosix('a\uD800b')).toBe('a\uD800b')
  })

  it('passes NUL through (the domain, not the function, excludes it)', () => {
    // A POSIX filename cannot contain NUL, so this is unreachable from the
    // filesystem — but `Cache.key` folds `${rel}\0${oid}`, and that delimiter
    // is only unambiguous BECAUSE the rel domain excludes NUL. Recorded here
    // so the assumption is written down rather than assumed.
    expect(toPosix('a\0b')).toBe('a\0b')
    expect(toPosix('a\0b')).not.toBe(toPosix('ab'))
  })
})

describe('relPosix — shape of the result', () => {
  it('is the empty string when the two paths are the same', () => {
    // Load-bearing: src/cli/migrate-nx.ts:34 exists purely to map this '' to
    // '.', so a change to 'to itself is "."' would double-map there.
    expect(relPosix('/root', '/root')).toBe('')
    expect(relPosix('/', '/')).toBe('')
    expect(relPosix('/root/', '/root')).toBe('')
    expect(relPosix('/root', '/root/')).toBe('')
  })

  it('descends without a "./" prefix', () => {
    // `Bun.Glob('packages/*')` does NOT match './packages/a' — see the
    // call-site block below. A leading './' would break workspace-root
    // discovery outright.
    expect(relPosix('/root', '/root/a')).toBe('a')
    expect(relPosix('/root', '/root/a/b/c/d.ts')).toBe('a/b/c/d.ts')
    expect(relPosix('/', '/root')).toBe('root')
  })

  it('drops a trailing slash on the target', () => {
    // Directory arguments arrive with and without one depending on the
    // caller; the glob matcher rejects 'packages/a/'.
    expect(relPosix('/root', '/root/a/b/')).toBe('a/b')
    expect(relPosix('/root', '/root/a/b//')).toBe('a/b')
  })

  it('normalises redundant separators and "."/".." segments', () => {
    expect(relPosix('/root//a', '/root/a/b')).toBe('b')
    expect(relPosix('/root/a/..', '/root/c')).toBe('c')
    expect(relPosix('/root', '/root/./a')).toBe('a')
    expect(relPosix('/root', '/root/a/./b/../c')).toBe('a/c')
  })

  it('climbs with ".." when the target is above the base', () => {
    expect(relPosix('/root/a/b', '/root')).toBe('../..')
    expect(relPosix('/a/b/c/d/e', '/a')).toBe('../../../..')
    expect(relPosix('/root', '/')).toBe('..')
  })

  it('routes through the common ancestor for siblings', () => {
    expect(relPosix('/root/a', '/root/b')).toBe('../b')
    expect(relPosix('/root/pkg/a', '/root/pkg/b/c.ts')).toBe('../b/c.ts')
    expect(relPosix('/root', '/other/x')).toBe('../other/x')
  })

  it('does not treat a shared string prefix as containment', () => {
    // '/rootx' starts with '/root' but is not inside it. A `startsWith`-based
    // rel would return 'x/a' and place a foreign file inside the workspace's
    // key namespace.
    expect(relPosix('/root', '/rootx/a')).toBe('../rootx/a')
    expect(relPosix('/root', '/root2')).toBe('../root2')
    expect(relPosix('/a/b', '/a/bc/d')).toBe('../bc/d')
  })

  it('is case-sensitive, matching the filesystem it describes', () => {
    // win32's relative() case-folds; posix's must not, or `Foo.ts` and
    // `foo.ts` — two files that can coexist on Linux — would share a key.
    expect(relPosix('/A', '/a')).toBe('../a')
    expect(relPosix('/root', '/root/Foo.ts')).toBe('Foo.ts')
    expect(relPosix('/root', '/root/Foo.ts')).not.toBe(relPosix('/root', '/root/foo.ts'))
  })

  it('never returns ".", a trailing slash, or a leading "./"', () => {
    // The three shapes every consumer would have to special-case. Swept over
    // a wide set of base/target pairs rather than asserted case by case.
    const bases = ['/root', '/root/', '/root/a', '/']
    const targets = [
      '/root',
      '/root/',
      '/root//',
      '/root/a',
      '/root/a/',
      '/root/a/b/',
      '/root/a/.',
      '/root/a/..',
      '/other',
      '/',
    ]
    for (const from of bases) {
      for (const to of targets) {
        const rel = relPosix(from, to)
        expect({ from, to, rel }).toEqual({
          from,
          to,
          rel: rel === '.' || rel.endsWith('/') || rel.startsWith('./') ? 'BAD SHAPE' : rel,
        })
      }
    }
  })
})

describe('relPosix — separator fidelity is cache-key fidelity', () => {
  // Same class as the toPosix backslash block, but through the composed
  // function the six production call sites actually use.
  it('keeps a backslash inside a directory or file name', () => {
    expect(relPosix('/root', '/root/we\\ird/f.ts')).toBe('we\\ird/f.ts')
    expect(relPosix('/root', '/root/a\\b')).toBe('a\\b')
    expect(relPosix('/root', '/root/packages/we\\ird')).toBe('packages/we\\ird')
  })

  it('a slashifying implementation would alias two distinct input files', () => {
    // The concrete stale hit: `/root/a\b` and `/root/a/b` are different files
    // with different contents, and this is the exact expression a
    // "cross-platform" rewrite produces.
    const withBackslash = relPosix('/root', '/root/a\\b')
    const withSlash = relPosix('/root', '/root/a/b')
    expect(withBackslash).not.toBe(withSlash)
    expect(slashifyBackslashes(withBackslash)).toBe(withSlash)
  })

  it('keeps whitespace, control characters and glob metacharacters verbatim', () => {
    expect(relPosix('/root', '/root/line\nbreak.ts')).toBe('line\nbreak.ts')
    expect(relPosix('/root', '/root/cr\rfile.ts')).toBe('cr\rfile.ts')
    expect(relPosix('/root', '/root/ta\tb.ts')).toBe('ta\tb.ts')
    expect(relPosix('/w s p/a c e', '/w s p/a c e/f g.ts')).toBe('f g.ts')
    expect(relPosix('/root', '/root/a[b]*?{c}.ts')).toBe('a[b]*?{c}.ts')
    expect(relPosix('/root', '/root/.hidden/.x')).toBe('.hidden/.x')
  })

  it('keeps unicode, including two normalisation forms of one grapheme', () => {
    const nfc = 'caf\u00e9.ts'
    const nfd = 'cafe\u0301.ts'
    expect(relPosix('/r', `/r/${nfc}`)).toBe(nfc)
    expect(relPosix('/r', `/r/${nfd}`)).toBe(nfd)
    expect(relPosix('/r', `/r/${nfc}`)).not.toBe(relPosix('/r', `/r/${nfd}`))
    expect(relPosix('/r', '/r/日本語/ファイル.ts')).toBe('日本語/ファイル.ts')
    expect(relPosix('/r', '/r/\u{1F389}/party.ts')).toBe('\u{1F389}/party.ts')
    expect(relPosix('/r', '/r/\u202Egnp.exe')).toBe('\u202Egnp.exe')
  })

  it('maps distinct files under one root to distinct rels', () => {
    // Injectivity is the whole cache-key contract: N different absolute input
    // files must fold N different `${rel}\0${oid}` parts. Every entry below
    // is a genuinely different directory entry on Linux.
    const names = [
      'a/b',
      'a\\b',
      'a b',
      'a\nb',
      'a\tb',
      'A/b',
      'a/B',
      'caf\u00e9',
      'cafe\u0301',
      'a',
      'a.b',
      'a..b',
      '.a',
      'a\0b',
    ]
    const rels = names.map((n) => relPosix('/root', `/root/${n}`))
    expect(new Set(rels).size).toBe(names.length)
    // Discriminating counterpart: the slashifying rewrite collapses the set.
    expect(new Set(rels.map(slashifyBackslashes)).size).toBeLessThan(names.length)
  })
})

describe('relPosix — call-site contracts', () => {
  // src/workspace/workspace.ts:92 — `claimsMember` feeds the rel straight
  // into `Bun.Glob.match` to decide which ancestor IS the workspace root.
  // Getting this wrong is the documented "running from inside a package
  // silently made that package the whole workspace" stale-hit class.
  it('produces exactly the shape Bun.Glob expects for member discovery', () => {
    const root = '/repo'
    expect(new Bun.Glob('packages/*').match(relPosix(root, '/repo/packages/a'))).toBe(true)
    expect(new Bun.Glob('packages/*').match(relPosix(root, '/repo/packages/a/'))).toBe(true)
    expect(new Bun.Glob('apps/*').match(relPosix(root, '/repo/packages/a'))).toBe(false)
    // The shapes that would break it, proving the rel must be bare.
    expect(new Bun.Glob('packages/*').match('./packages/a')).toBe(false)
    expect(new Bun.Glob('packages/*').match('packages/a/')).toBe(false)
  })

  it('keeps a backslash-named member matchable by its glob', () => {
    // A slashified rel gains a segment ('packages/we/ird'), which
    // 'packages/*' rejects — so vx would walk PAST the real workspace root
    // and treat the package as the whole workspace.
    const rel = relPosix('/repo', '/repo/packages/we\\ird')
    expect(new Bun.Glob('packages/*').match(rel)).toBe(true)
    expect(new Bun.Glob('packages/*').match(slashifyBackslashes(rel))).toBe(false)
  })

  // src/cli/migrate-turbo.ts:361 — the rel becomes an ESM import specifier,
  // prefixed with './' only when it does not already start with '.'.
  it('gives migrate-turbo a rel it can turn into a valid import specifier', () => {
    const spec = (dir: string): string => {
      const rel = relPosix(dir, path.join('/repo', 'vx-preset.ts'))
      return rel.startsWith('.') ? rel : `./${rel}`
    }
    expect(spec('/repo/packages/a')).toBe('../../vx-preset.ts')
    expect(spec('/repo/packages/nested/deep')).toBe('../../../vx-preset.ts')
    // The root project needs the './' the caller adds — pinning that the rel
    // itself is bare here is what makes that branch necessary.
    expect(relPosix('/repo', path.join('/repo', 'vx-preset.ts'))).toBe('vx-preset.ts')
    expect(spec('/repo')).toBe('./vx-preset.ts')
  })

  // src/workspace/lockfile.ts:100 and src/cli/lock.ts:59,98 use the rel as a
  // lockfile map KEY. `vx lock --check` re-derives it in a fresh process on
  // another machine and compares; any nondeterminism is a spurious drift
  // error on every CI run.
  it('is deterministic and does not mutate its arguments', () => {
    const from = '/repo'
    const to = '/repo/packages/a/vx.config.ts'
    const first = relPosix(from, to)
    for (let i = 0; i < 100; i++) expect(relPosix(from, to)).toBe(first)
    expect(from).toBe('/repo')
    expect(to).toBe('/repo/packages/a/vx.config.ts')
    expect(first).toBe('packages/a/vx.config.ts')
  })

  it('reaches production through the util contract as the same function', () => {
    // Every cross-module caller imports from util/index.js
    // (tests/module-boundaries.test.ts forbids reaching paths.ts directly),
    // so a barrel that re-exported something else would make this whole file
    // vacuous for the real code paths.
    expect(relPosixViaBarrel).toBe(relPosix)
    expect(relPosixViaBarrel('/repo', '/repo/a\\b')).toBe('a\\b')
  })

  // src/cache/cache.ts:1279 — the fold `${rel}\0${oid}`. inputFiles are
  // `path.resolve`d absolutes (src/cache/inputs.ts:175,552) and
  // workspaceRoot is absolute, so the production shape is absolute/absolute.
  it('is cwd-independent for the absolute/absolute pairs production uses', () => {
    const from = '/repo'
    const to = '/repo/packages/a/src/index.ts'
    const before = relPosix(from, to)
    const origCwd = process.cwd()
    try {
      process.chdir(os.tmpdir())
      expect(relPosix(from, to)).toBe(before)
    } finally {
      process.chdir(origCwd)
    }
    expect(before).toBe('packages/a/src/index.ts')
    expect(process.cwd()).toBe(origCwd)
  })

  it('IS cwd-dependent when either argument is relative — callers must pass absolutes', () => {
    // Not a defect (path.relative resolves against cwd by definition), but a
    // real reproducibility trap for a cache key: the rel below embeds the
    // machine's cwd. Pinned so anyone tempted to pass a relative path to a
    // key-derivation call site sees what it costs.
    const rel = relPosix('/tmp', 'x')
    expect(rel).toBe(relPosix('/tmp', path.resolve(process.cwd(), 'x')))
    expect(rel).toContain(relPosix('/tmp', process.cwd()))
    // Two relative arguments resolve against the SAME cwd, so that pair
    // happens to stay cwd-independent — the trap is specifically MIXING them.
    const origCwd = process.cwd()
    try {
      process.chdir(os.tmpdir())
      expect(relPosix('a', 'a/b')).toBe('b')
    } finally {
      process.chdir(origCwd)
    }
  })
})

describe('relPosix — documented boundaries', () => {
  it('collapses paths that denote the same file (normalisation, not a collision)', () => {
    // 'a/' and 'a', or 'a//b' and 'a/b', are the SAME directory entry, so one
    // shared rel is correct. Recorded next to the injectivity test above so a
    // reader can tell the two apart.
    expect(relPosix('/root', '/root/a/')).toBe(relPosix('/root', '/root/a'))
    expect(relPosix('/root', '/root/a//b')).toBe(relPosix('/root', '/root/a/b'))
  })

  it('substitutes U+FFFD for a lone surrogate — inside path.relative, not toPosix', () => {
    // A lone surrogate has no UTF-8 form. `path.relative` normalises it away
    // while `toPosix` does not, so two distinct JS strings can share a rel.
    // Unreachable in production (readdir/git enumeration never yield unpaired
    // surrogates, and xxh3 performs the same substitution — see
    // tests/util-hash.test.ts), but attributed precisely here so a future
    // caller hashing raw UTF-16 knows which layer is lossy.
    expect(relPosix('/r', '/r/\uD800')).toBe('\uFFFD')
    expect(relPosix('/r', '/r/a\uD800b')).toBe('a\uFFFDb')
    expect(toPosix('\uD800')).toBe('\uD800')
    expect(relPosix('/r', '/r/\uD800')).toBe(relPosix('/r', '/r/\uDFFF'))
  })

  it('handles a path far past PATH_MAX (it is pure string arithmetic)', () => {
    // Cache-key rels are derived from glob results, never from a syscall on
    // the rel itself, so there is no length ceiling to respect — and a future
    // "guard long paths" change would break deep generated output trees.
    const name = 'x'.repeat(100_000)
    expect(relPosix('/r', `/r/${name}`)).toBe(name)
    const deep = Array.from({ length: 500 }, (_, i) => `seg${i}`).join('/')
    expect(relPosix('/r', `/r/${deep}`)).toBe(deep)
    expect(relPosix(`/r/${deep}`, '/r')).toBe(Array(500).fill('..').join('/'))
  })
})
