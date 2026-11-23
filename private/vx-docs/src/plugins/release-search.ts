// Release notes get a search index of their own, merged into the site's at
// a tenth of the weight (astro.config.mjs, `pagefind.mergeIndex`): at
// half, a note still came first. Over 30 notes name
// every feature again, so in one index they outranked the feature's own
// page: "fail fast" found v0.0.242 ("Starts 2× faster") before the guide.
// Their pages leave the main index (src/nav/route-data.ts drops their
// `data-pagefind-body`), so this run takes each note's <main> whole;
// `data-pagefind-ignore` still applies inside it.
//
// `pagefind` is a dependency for this run alone: Starlight's own index
// takes the whole site and has no way to set a section apart.
//
// The bundle is taken in memory and written here. Pagefind's `writeFiles`
// answers before its writes land (tokio file writes, never flushed), and
// `close()` kills its backend: on a loaded CI worker pagefind-entry.json was
// cut short in the cached build (main run 45164679360; a probe under load cut
// 12 of 60, 0 of 60 this way).
import type { AstroIntegration } from 'astro'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pagefind from 'pagefind'

export const RELEASES_BUNDLE = 'pagefind-releases'

export function releaseSearch(
  api: Pick<typeof pagefind, 'createIndex' | 'close'> = pagefind,
): AstroIntegration {
  return {
    name: 'vx-release-search',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const check = <T extends { errors: string[] }>(r: T | undefined): T => {
          if (!r || r.errors.length > 0) throw new Error(`pagefind: ${r?.errors.join('; ')}`)
          return r
        }
        try {
          const { index } = check(await api.createIndex({ rootSelector: 'main' }))
          if (!index) throw new Error('pagefind: no index')
          const site = fileURLToPath(dir)
          const { page_count } = check(
            await index.addDirectory({ path: site, glob: 'releases/vx-*/index.html' }),
          )
          if (page_count === 0) throw new Error('pagefind: no release notes found')
          const { files } = check(await index.getFiles())
          const out = path.join(site, RELEASES_BUNDLE)
          await Promise.all(
            files.map(async (f) => {
              const to = path.join(out, f.path)
              await mkdir(path.dirname(to), { recursive: true })
              await writeFile(to, f.content)
            }),
          )
          logger.info(`Indexed ${page_count} release notes apart.`)
        } finally {
          await api.close()
        }
      },
    },
  }
}
