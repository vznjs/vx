// The servers' docs tell users to `docker run ghcr.io/vznjs/<server>`, and
// until release.images nothing pushed those images: the pull failed. Each
// release now pushes every server image at its version.
//
// `.unsafe`: the docs, the Dockerfiles and the workflows live outside this
// project, which a sandboxed task may not read (the cross-project law).
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { IMAGES, buildCommand, tagsFor } from '../scripts/release-images.ts'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')

describe('release.images', () => {
  it('pushes both platforms, labelled for the workspace, at the version and latest', () => {
    const dte = IMAGES.find((i) => i.name === 'vx-dte-server')!
    expect(
      buildCommand(dte, '0.0.653', tagsFor(dte.name, '0.0.653', undefined), 'the relay'),
    ).toEqual([
      'docker',
      'buildx',
      'build',
      '--push',
      '--platform',
      'linux/amd64,linux/arm64',
      '--label',
      'org.opencontainers.image.source=https://github.com/vznjs/vx',
      '--label',
      'org.opencontainers.image.version=0.0.653',
      '--label',
      'org.opencontainers.image.licenses=MIT',
      '--annotation',
      'index:org.opencontainers.image.description=the relay',
      '--tag',
      'ghcr.io/vznjs/vx-dte-server:0.0.653',
      '--tag',
      'ghcr.io/vznjs/vx-dte-server:latest',
      '--file',
      path.join(ROOT, 'packages/vx-dte-server/Dockerfile'),
      path.join(ROOT, 'packages/vx-dte-server'),
    ])
  })

  it('moves latest only forward', () => {
    expect(tagsFor('vx-cache-server', '0.0.653', '0.0.652')).toEqual([
      'ghcr.io/vznjs/vx-cache-server:0.0.653',
      'ghcr.io/vznjs/vx-cache-server:latest',
    ])
    expect(tagsFor('vx-cache-server', '0.0.652', '0.0.652')).toContain(
      'ghcr.io/vznjs/vx-cache-server:latest',
    )
    expect(tagsFor('vx-cache-server', '0.0.651', '0.0.652')).toEqual([
      'ghcr.io/vznjs/vx-cache-server:0.0.651',
    ])
  })

  it('builds every Dockerfile under packages/ from the context it was written for', () => {
    const dockerfiles = [...new Bun.Glob('*/Dockerfile').scanSync(path.join(ROOT, 'packages'))]
      .map((f) => path.dirname(f))
      .sort()
    expect(IMAGES.map((i) => i.name).sort()).toEqual(dockerfiles)
    for (const image of IMAGES) {
      const text = readFileSync(path.join(ROOT, image.dockerfile), 'utf8')
      // A Dockerfile that copies `packages/...` is built from the root.
      expect([image.name, image.context === '.']).toEqual([
        image.name,
        /COPY packages\//.test(text),
      ])
    }
  })

  it('is every image the docs tell a user to pull', () => {
    const named = new Set<string>()
    const docs = [
      ...new Bun.Glob('packages/*/README.md').scanSync(ROOT),
      ...new Bun.Glob('private/vx-docs/src/content/docs/**/*.{md,mdx}').scanSync(ROOT),
    ]
    for (const f of docs) {
      for (const m of readFileSync(path.join(ROOT, f), 'utf8').matchAll(
        /ghcr\.io\/vznjs\/([\w.-]+)/g,
      )) {
        named.add(m[1]!)
      }
    }
    expect(named.size).toBeGreaterThan(2)
    expect([...named].filter((n) => !IMAGES.some((i) => i.name === n))).toEqual([])
  })

  it('runs on every release, with only packages: write', () => {
    const doc = Bun.YAML.parse(
      readFileSync(path.join(ROOT, '.github/workflows/npm.yml'), 'utf8'),
    ) as {
      jobs: Record<string, { permissions?: Record<string, string>; steps: { run?: string }[] }>
    }
    const job = doc.jobs['images']!
    expect(job.permissions).toEqual({ contents: 'read', packages: 'write' })
    expect(job.steps.some((s) => s.run?.includes('run release.images --filter @vzn/vx'))).toBe(true)
    expect(existsSync(path.join(ROOT, 'packages/vx/scripts/release-images.ts'))).toBe(true)
  })
})
