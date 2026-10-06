// The decisions the release tasks make before they touch a registry or the
// GitHub API (scripts/release.ts, scripts/auto-release.ts): which version a
// tag names, which npm can publish with provenance, what is published in
// which order and what a re-run skips, which commit is released, and which
// binaries a draft release still needs (scripts/release-assets.ts).
import { describe, expect, it } from 'bun:test'
import { assetsToUpload, releaseFor, type Release } from '../scripts/release-assets.js'
import { decideRelease, type Git } from '../scripts/auto-release.js'
import {
  publishAll,
  publishOrder,
  releaseVersion,
  supportsTrustedPublishing,
} from '../scripts/release.js'

const message = (f: () => unknown): string => {
  try {
    f()
  } catch (e) {
    return (e as Error).message
  }
  return 'no error'
}

describe('releaseVersion', () => {
  it('takes a tag or a bare version, the v stripped', () => {
    expect(
      ['1.2.3', 'v1.2.3', 'v0.0.484', '1.0.0-rc.1', 'v2.0.0-beta.2-x'].map(releaseVersion),
    ).toEqual(['1.2.3', '1.2.3', '0.0.484', '1.0.0-rc.1', '2.0.0-beta.2-x'])
  })

  it('refuses no version, and anything that is not one', () => {
    expect([undefined, ''].map((raw) => message(() => releaseVersion(raw)))).toEqual([
      'no version (not a release and no input)',
      'no version (not a release and no input)',
    ])
    const bad = ['vv1.2.3', '1.2', 'main', '1.2.3 ', '1.2.3; rm -rf /', '1.2.3\n4.5.6', '1.2.3-']
    expect(bad.map((raw) => message(() => releaseVersion(raw)))).toEqual(
      bad.map((raw) => `not a version: ${raw}`),
    )
  })
})

describe('supportsTrustedPublishing', () => {
  it('is npm 11.5.1 or later, a prerelease by its numbers', () => {
    const versions = [
      '10.9.4',
      '11.4.9',
      '11.5.0',
      '11.5.1',
      '11.5.1-pre.0',
      '11.6.0',
      '11.10.0',
      '12.0.0',
    ]
    expect(versions.filter(supportsTrustedPublishing)).toEqual([
      '11.5.1',
      '11.5.1-pre.0',
      '11.6.0',
      '11.10.0',
      '12.0.0',
    ])
  })
})

describe('publishOrder', () => {
  it('publishes the linux binaries, then @vzn/vx, then every plugin, sorted', () => {
    expect(publishOrder('linux', ['vx-reapi', 'vx-ci'])).toEqual([
      '@vzn/vx-linux-x64',
      '@vzn/vx-linux-arm64',
      'vx',
      'plugins/vx-ci',
      'plugins/vx-reapi',
    ])
  })

  it('publishes only the darwin binaries from the darwin job', () => {
    expect(publishOrder('darwin', ['vx-ci'])).toEqual([
      '@vzn/vx-darwin-x64',
      '@vzn/vx-darwin-arm64',
    ])
  })
})

describe('publishAll', () => {
  const packages = [
    { name: '@vzn/vx-linux-x64', dir: 'a' },
    { name: '@vzn/vx', dir: 'b' },
    { name: '@vzn/vx-otel', dir: 'c' },
  ]

  it('skips what the registry holds at the version and publishes the rest, in order', () => {
    const asked: string[] = []
    const published: string[] = []
    const log: string[] = []
    publishAll(
      packages,
      '1.2.3',
      {
        has: (spec) => (asked.push(spec), spec === '@vzn/vx@1.2.3'),
        publish: (dir) => void published.push(dir),
      },
      (line) => void log.push(line),
    )
    expect(asked).toEqual(['@vzn/vx-linux-x64@1.2.3', '@vzn/vx@1.2.3', '@vzn/vx-otel@1.2.3'])
    expect(published).toEqual(['a', 'c'])
    expect(log.filter((l) => !l.startsWith('::'))).toEqual([
      '@vzn/vx@1.2.3 already on the registry — skipping',
    ])
  })

  it('stops at the first publish that fails', () => {
    const published: string[] = []
    const f = (): void =>
      publishAll(
        packages,
        '1.2.3',
        {
          has: () => false,
          publish: (dir) => {
            if (dir === 'b') throw new Error('npm publish b failed (exit 1)')
            published.push(dir)
          },
        },
        () => {},
      )
    expect(message(f)).toBe('npm publish b failed (exit 1)')
    expect(published).toEqual(['a'])
  })
})

describe('decideRelease', () => {
  const SHA = 'abc123'
  const repo = (state: {
    at?: string
    tags?: string
    ancestor?: boolean
  }): { git: Git; calls: string[] } => {
    const calls: string[] = []
    const git: Git = (args) => {
      calls.push(args.join(' '))
      if (args[0] === 'tag' && args[1] === '--points-at') return { ok: true, out: state.at ?? '' }
      if (args[0] === 'tag' && args[1] === '-l') return { ok: true, out: state.tags ?? '' }
      if (args[0] === 'merge-base') return { ok: state.ancestor ?? false, out: '' }
      throw new Error(`unexpected git ${args.join(' ')}`)
    }
    return { git, calls }
  }

  it('skips a commit that already carries a v tag', () => {
    const { git, calls } = repo({ at: 'v0.0.9\nother' })
    expect(decideRelease(SHA, git)).toEqual({
      release: false,
      reason: 'abc123 is already tagged (v0.0.9); nothing to release',
    })
    expect(calls).toEqual(['tag --points-at abc123'])
  })

  it('releases a commit whose only tags are not versions', () => {
    const { git } = repo({ at: 'nightly', tags: 'v0.0.8\nv0.0.9', ancestor: true })
    expect(decideRelease(SHA, git)).toEqual({ release: true, last: 'v0.0.9' })
  })

  it('releases after the last tag in version order when it is an ancestor', () => {
    const { git, calls } = repo({ tags: 'v0.0.9\nv0.0.10', ancestor: true })
    expect(decideRelease(SHA, git)).toEqual({ release: true, last: 'v0.0.10' })
    expect(calls).toEqual([
      'tag --points-at abc123',
      'tag -l v* --sort=v:refname',
      'merge-base --is-ancestor v0.0.10 abc123',
    ])
  })

  it('skips a commit the last release is not behind', () => {
    const { git } = repo({ tags: 'v0.0.10', ancestor: false })
    expect(decideRelease(SHA, git)).toEqual({
      release: false,
      reason: 'v0.0.10 is not an ancestor of abc123 — a newer commit is already released; skipping',
    })
  })

  it('releases the first version when there is no tag, asking no ancestry', () => {
    const { git, calls } = repo({})
    expect(decideRelease(SHA, git)).toEqual({ release: true, last: '' })
    expect(calls).toEqual(['tag --points-at abc123', 'tag -l v* --sort=v:refname'])
  })
})

describe('release assets (scripts/release-assets.ts)', () => {
  const release = (tag: string, draft: boolean, assets: string[] = []): Release => ({
    id: 1,
    tag_name: tag,
    draft,
    assets: assets.map((name) => ({ name })),
  })

  it('finds the draft that carries the tag', () => {
    const r = release('v1.2.3', true)
    expect(releaseFor([release('v1.2.2', true), r], 'v1.2.3')).toBe(r)
  })

  it('refuses a missing release, and a published one an immutable release cannot extend', () => {
    expect(message(() => releaseFor([release('v1.2.2', true)], 'v1.2.3'))).toBe(
      'no release for v1.2.3',
    )
    expect(message(() => releaseFor([release('v1.2.3', false)], 'v1.2.3'))).toBe(
      'v1.2.3 is already published; an immutable release takes assets only as a draft',
    )
  })

  it("uploads the os's binaries the release lacks, so a re-run completes the set", () => {
    const files = ['vx-linux-x64', 'vx-darwin-arm64', 'vx-linux-arm64', 'npm', 'vx-darwin-x64']
    expect(assetsToUpload('linux', files, release('v1', true))).toEqual([
      'vx-linux-arm64',
      'vx-linux-x64',
    ])
    expect(assetsToUpload('darwin', files, release('v1', true, ['vx-darwin-arm64']))).toEqual([
      'vx-darwin-x64',
    ])
  })
})
