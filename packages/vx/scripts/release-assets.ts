// release.yml's uploads, the `release.upload.<os>` tasks: attach the
// `vx-<os>-*` binaries to the release VX_RELEASE_VERSION names, and with
// `--publish` take it out of draft. This repo's releases are immutable, and
// GitHub takes assets only before a release is published, so release.auto
// creates each one as a draft and the last upload (darwin's, after its
// binaries are proven) publishes it. An asset already attached is skipped,
// so a re-run completes the set.
//
//   GH_TOKEN=… GITHUB_REPOSITORY=owner/repo VX_RELEASE_VERSION=v1.2.3 bun scripts/release-assets.ts <linux|darwin> [--publish]

import { readdirSync } from 'node:fs'
import path from 'node:path'
import { env } from './env.ts'
import { releaseVersion } from './release.ts'

const DIST = path.join(import.meta.dir, '..', 'dist')

export interface Release {
  id: number
  tag_name: string
  draft: boolean
  assets: readonly { name: string }[]
}

/** The release that carries `tag`, refused when it can no longer take assets. */
export function releaseFor(releases: readonly Release[], tag: string): Release {
  const release = releases.find((r) => r.tag_name === tag)
  if (release === undefined) throw new Error(`no release for ${tag}`)
  if (!release.draft) {
    throw new Error(
      `${tag} is already published; an immutable release takes assets only as a draft`,
    )
  }
  return release
}

/** The binaries for `os` under `files` that `release` does not carry yet. */
export function assetsToUpload(
  os: 'linux' | 'darwin',
  files: readonly string[],
  release: Release,
): string[] {
  const have = new Set(release.assets.map((a) => a.name))
  return files.filter((f) => f.startsWith(`vx-${os}-`) && !have.has(f)).sort()
}

async function main(): Promise<void> {
  const os = process.argv[2]
  if (os !== 'linux' && os !== 'darwin')
    throw new Error('usage: release-assets.ts <linux|darwin> [--publish]')
  const tag = `v${releaseVersion(process.env.VX_RELEASE_VERSION)}`
  const repo = env('GITHUB_REPOSITORY')
  const headers = {
    authorization: `Bearer ${env('GH_TOKEN')}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  }
  const call = async (
    url: string,
    init: { method?: string; body?: string | Blob; headers?: Record<string, string> } = {},
  ): Promise<unknown> => {
    const res = await fetch(url, { ...init, headers: { ...headers, ...init.headers } })
    if (!res.ok)
      throw new Error(
        `${init.method ?? 'GET'} ${url}: ${res.status} ${res.statusText}\n${await res.text()}`,
      )
    return res.json()
  }
  // Drafts have no tag lookup; the list shows them to a token that can write.
  const releases = (await call(
    `https://api.github.com/repos/${repo}/releases?per_page=50`,
  )) as Release[]
  const release = releaseFor(releases, tag)
  for (const name of assetsToUpload(os, readdirSync(DIST), release)) {
    const file = Bun.file(path.join(DIST, name))
    await call(
      `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(file.size),
        },
        body: file,
      },
    )
    console.log(`attached ${name} to ${tag}`)
  }
  if (process.argv.includes('--publish')) {
    await call(`https://api.github.com/repos/${repo}/releases/${release.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ draft: false }),
    })
    console.log(`published ${tag}`)
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`)
    process.exitCode = 1
  }
}
