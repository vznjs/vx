// npm.yml's `images` job, the `release.images` task: push each server's
// image to ghcr.io/vznjs/<server> at VX_RELEASE_VERSION, for linux/amd64
// and linux/arm64, and move `latest` to it unless an older tag is being
// rebuilt. The docs tell users to `docker run` these names.
//
//   GITHUB_TOKEN=… GITHUB_ACTOR=… VX_RELEASE_VERSION=v1.2.3 bun scripts/release-images.ts

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { env } from './env.ts'
import { releaseVersion } from './release.ts'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')
const REGISTRY = 'ghcr.io/vznjs'

export interface Image {
  name: string
  dockerfile: string
  /** Build context, relative to the root: the relay copies its own files; the others bundle @vzn/vx-devtools. */
  context: string
}

export const IMAGES: readonly Image[] = [
  {
    name: 'vx-dte-server',
    dockerfile: 'packages/vx-dte-server/Dockerfile',
    context: 'packages/vx-dte-server',
  },
  { name: 'vx-cache-server', dockerfile: 'packages/vx-cache-server/Dockerfile', context: '.' },
  { name: 'vx-history-server', dockerfile: 'packages/vx-history-server/Dockerfile', context: '.' },
]

/** The tags one image gets: its version, and `latest` unless that would move it back. */
export function tagsFor(name: string, version: string, latest: string | undefined): string[] {
  const tags = [`${REGISTRY}/${name}:${version}`]
  if (latest === undefined || Bun.semver.order(version, latest) >= 0) {
    tags.push(`${REGISTRY}/${name}:latest`)
  }
  return tags
}

export function buildCommand(
  image: Image,
  version: string,
  tags: readonly string[],
  description: string,
): string[] {
  return [
    'docker',
    'buildx',
    'build',
    '--push',
    '--platform',
    'linux/amd64,linux/arm64',
    // Links the package to this workspace's repository on GitHub.
    '--label',
    'org.opencontainers.image.source=https://github.com/vznjs/vx',
    '--label',
    `org.opencontainers.image.version=${version}`,
    '--label',
    'org.opencontainers.image.licenses=MIT',
    // ghcr shows a multi-platform image's description from its index.
    '--annotation',
    `index:org.opencontainers.image.description=${description}`,
    ...tags.flatMap((t) => ['--tag', t]),
    '--file',
    path.join(ROOT, image.dockerfile),
    path.join(ROOT, image.context),
  ]
}

function run(cmd: string[], stdin?: string): void {
  const r = Bun.spawnSync({
    cmd,
    stdin: stdin === undefined ? 'inherit' : Buffer.from(stdin),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (r.exitCode !== 0) throw new Error(`${cmd.slice(0, 3).join(' ')} exited ${r.exitCode}`)
}

/** `@vzn/vx`'s npm `latest`: the images' `latest` follows the same release. */
async function npmLatest(): Promise<string | undefined> {
  const res = await fetch('https://registry.npmjs.org/@vzn%2fvx')
  if (!res.ok) throw new Error(`registry.npmjs.org answered ${res.status} for @vzn/vx`)
  const doc = (await res.json()) as { 'dist-tags'?: { latest?: string } }
  return doc['dist-tags']?.latest
}

async function main(): Promise<void> {
  const version = releaseVersion(process.env['VX_RELEASE_VERSION'])
  const latest = await npmLatest()
  run(
    ['docker', 'login', 'ghcr.io', '--username', env('GITHUB_ACTOR'), '--password-stdin'],
    env('GITHUB_TOKEN'),
  )
  for (const image of IMAGES) {
    const pkg = JSON.parse(
      readFileSync(path.join(ROOT, 'packages', image.name, 'package.json'), 'utf8'),
    ) as { description: string }
    const tags = tagsFor(image.name, version, latest)
    console.log(`pushing ${tags.join(' ')}`)
    run(buildCommand(image, version, tags, pkg.description))
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (e) {
    console.error(`release-images: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
