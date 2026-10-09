// release.yml's uploads, the `release.upload.<os>` tasks: attach the
// `vx-<os>-*` binaries to the release VX_RELEASE_VERSION names (linux's also
// THIRD_PARTY_NOTICES.txt, the licenses the binaries embed), and with
// `--publish` take it out of draft. This repo's releases are immutable, and
// GitHub takes assets only before a release is published, so release.auto
// creates each one as a draft and the last upload (darwin's, after its
// binaries are proven) publishes it. An asset already attached is skipped,
// so a re-run completes the set. An upload that stalls is cut and retried:
// v0.0.575 stayed a draft when its second darwin upload hung six minutes.
//
//   GH_TOKEN=… GITHUB_REPOSITORY=owner/repo VX_RELEASE_VERSION=v1.2.3 bun scripts/release-assets.ts <linux|darwin> [--publish]

import { readdirSync } from 'node:fs'
import path from 'node:path'
import { env } from './env.ts'
import { releaseVersion } from './release.ts'

const DIST = path.join(import.meta.dir, '..', 'dist')
const NOTICES_ASSET = 'THIRD_PARTY_NOTICES.txt'

export interface Release {
  id: number
  tag_name: string
  draft: boolean
  assets: readonly { id?: number; name: string; state?: string }[]
}

const UPLOAD_ATTEMPTS = 3
const UPLOAD_TIMEOUT_MS = 120_000

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

/**
 * The binaries for `os` under `files` that `release` does not carry yet, and
 * on linux, the first upload, the notices every binary must travel with.
 */
export function assetsToUpload(
  os: 'linux' | 'darwin',
  files: readonly string[],
  release: Release,
): string[] {
  const have = new Set(release.assets.filter((a) => !isPartial(a)).map((a) => a.name))
  const want = files.filter((f) => f.startsWith(`vx-${os}-`))
  if (os === 'linux') want.push(NOTICES_ASSET)
  return want.filter((f) => !have.has(f)).sort()
}

/** An upload cut mid-way leaves its asset un-`uploaded`; it blocks the name until deleted. */
export function isPartial(asset: Release['assets'][number]): boolean {
  return asset.state !== undefined && asset.state !== 'uploaded'
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
    init: {
      method?: string
      body?: string | Blob
      headers?: Record<string, string>
      signal?: AbortSignal
    } = {},
  ): Promise<unknown> => {
    const res = await fetch(url, { ...init, headers: { ...headers, ...init.headers } })
    if (!res.ok)
      throw new Error(
        `${init.method ?? 'GET'} ${url}: ${res.status} ${res.statusText}\n${await res.text()}`,
      )
    return res.status === 204 ? null : res.json()
  }
  // Drafts have no tag lookup; the list shows them, first, to a token that can write.
  const releases = (await call(
    `https://api.github.com/repos/${repo}/releases?per_page=50`,
  )) as Release[]
  let release = releaseFor(releases, tag)
  const api = `https://api.github.com/repos/${repo}/releases`
  const dropPartial = async (name: string): Promise<void> => {
    release = (await call(`${api}/${release.id}`)) as Release
    for (const a of release.assets)
      if (a.name === name && isPartial(a)) await call(`${api}/assets/${a.id}`, { method: 'DELETE' })
  }
  for (const name of assetsToUpload(os, readdirSync(DIST), release)) {
    const file = Bun.file(
      name === NOTICES_ASSET ? path.join(DIST, '..', name) : path.join(DIST, name),
    )
    for (let attempt = 1; ; attempt++) {
      try {
        await dropPartial(name)
        await call(
          `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/octet-stream',
              'content-length': String(file.size),
            },
            body: file,
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
          },
        )
        break
      } catch (e) {
        if (attempt === UPLOAD_ATTEMPTS) throw e
        process.stderr.write(`upload of ${name} failed (${(e as Error).message}), retrying\n`)
      }
    }
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
