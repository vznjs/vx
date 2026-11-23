// The `deploy.github` task, which ci.yml's Linux run runs on each push to
// main: a release post rewritten after its release shipped changes the
// GitHub release too, so GitHub and the site tell the same story. Each
// GitHub release with a post on main whose body differs gets the post's
// (postNotes); a release with no post keeps its body.
//
//   GH_TOKEN=… GITHUB_REPOSITORY=owner/repo bun scripts/release-sync.ts

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { github, runMain } from './github.ts'
import { postNotes, postPath } from './release-notes.ts'

/** A release as the releases API lists it. */
export interface Release {
  id: number
  tag_name: string
  body: string | null
}

/** The releases whose post says something else, with the body to give each. */
export function stale(
  releases: readonly Release[],
  post: (version: string) => string | undefined,
): Array<{ id: number; tag: string; body: string }> {
  return releases.flatMap(({ id, tag_name, body }) => {
    const version = tag_name.replace(/^v/, '')
    const text = post(version)
    if (text === undefined) return []
    const want = postNotes(text, version)
    return (body ?? '').replaceAll('\r\n', '\n') === want ? [] : [{ id, tag: tag_name, body: want }]
  })
}

async function main(): Promise<void> {
  const gh = github()
  const root = path.resolve(import.meta.dir, '../../..')
  const post = (version: string): string | undefined => {
    const file = path.join(root, postPath(version))
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined
  }
  const changes = stale((await gh('releases?per_page=100')) as Release[], post)
  for (const { id, tag, body } of changes) {
    await gh(`releases/${id}`, { method: 'PATCH', body: JSON.stringify({ body }) })
    console.log(`${tag}: body set from its post`)
  }
  if (changes.length === 0) console.log('every release already matches its post')
}

if (import.meta.main) await runMain(main)
