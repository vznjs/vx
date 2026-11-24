// The servers' docs tell users to `docker run ghcr.io/vznjs/<server>`, and
// until release.docker nothing pushed those images: the pull failed. Each
// release now pushes every server image at its version.
//
// `.unsafe`: the docs, the Dockerfiles and the workflows live outside this
// project, which a sandboxed task may not read (the cross-project law).
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import config from '../vx.config.ts'
import { IMAGES, buildCommand, tagsFor } from '../scripts/release-images.ts'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')

describe('release.docker', () => {
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
      ROOT,
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

  // No image checked its health: `docker ps` and compose read a server that
  // refused at boot and restarted in a loop as up. Each runs as `bun`, in
  // exec form (SIGTERM reaches Bun, whose handler stops at once), and its
  // HEALTHCHECK is proven here against the server it ships, and against none.
  it('runs each image as bun, in exec form, with a healthcheck that asks the server', async () => {
    const allow = 'https://token.actions.githubusercontent.com:acme/app:ci.yml'
    const env: Record<string, Record<string, string>> = {
      'vx-cache-server': { S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' },
      'vx-dte-server': {},
      'vx-history-server': {},
    }
    for (const image of IMAGES) {
      const text = readFileSync(path.join(ROOT, image.dockerfile), 'utf8')
      const final = text.slice(text.lastIndexOf('\nFROM '))
      expect([image.name, /^USER bun$/m.test(final), /^ENTRYPOINT \["bun",/m.test(final)]).toEqual([
        image.name,
        true,
        true,
      ])
      const health = /^HEALTHCHECK .*?CMD (\[.*\])$/m.exec(final)?.[1]
      expect([image.name, health !== undefined]).toEqual([image.name, true])
      const cmd = JSON.parse(health!) as string[]
      expect(cmd[0]).toBe('bun')
      const dir = path.join(ROOT, path.dirname(image.dockerfile))
      const db = path.join(dir, '.healthcheck-test.sqlite')
      const server = Bun.spawn(
        [
          'bun',
          path.join(dir, 'src/bun.ts'),
          '--port',
          '0',
          ...(image.name === 'vx-history-server' ? ['--db', db] : []),
        ],
        {
          env: {
            PATH: process.env['PATH'] ?? '',
            ALLOW: allow,
            AUDIENCE: 'https://x.example.com',
            ...env[image.name],
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      try {
        const reader = server.stdout.getReader()
        let said = ''
        while (!/listening on/.test(said)) {
          const { value, done } = await reader.read()
          if (done)
            throw new Error(
              `${image.name} did not start: ${await new Response(server.stderr).text()}`,
            )
          said += new TextDecoder().decode(value)
        }
        const port = /:(\d+)\/?\s*$/m.exec(said)![1]!
        const check = (on: string) =>
          Bun.spawnSync(
            cmd.map((a) => a.replaceAll('127.0.0.1:8080', `127.0.0.1:${on}`)),
            { timeout: 20_000 },
          ).exitCode
        expect([image.name, check(port)]).toEqual([image.name, 0])
        server.kill('SIGTERM')
        expect([image.name, await server.exited]).toEqual([image.name, 0])
        expect([image.name, check(port)]).toEqual([image.name, 1])
      } finally {
        server.kill('SIGKILL')
        for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true })
      }
    }
  }, 60_000)

  it('runs on every release, last, in a job that may push packages', () => {
    const doc = Bun.YAML.parse(
      readFileSync(path.join(ROOT, '.github/workflows/npm.yml'), 'utf8'),
    ) as { jobs: Record<string, { permissions?: Record<string, string> }> }
    expect(doc.jobs['release']?.permissions?.['packages']).toBe('write')
    expect(config.tasks?.['release']?.dependsOn).toEqual([
      'release.docker',
      'release.github.darwin.upload',
    ])
    expect(existsSync(path.join(ROOT, 'packages/vx/scripts/release-images.ts'))).toBe(true)
  })
})
