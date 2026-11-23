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
import type { AstroIntegration } from 'astro'
import { fileURLToPath } from 'node:url'
import * as pagefind from 'pagefind'

export const RELEASES_BUNDLE = 'pagefind-releases'

export function releaseSearch(): AstroIntegration {
  return {
    name: 'vx-release-search',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const check = <T extends { errors: string[] }>(r: T | undefined): T => {
          if (!r || r.errors.length > 0) throw new Error(`pagefind: ${r?.errors.join('; ')}`)
          return r
        }
        try {
          const { index } = check(await pagefind.createIndex({ rootSelector: 'main' }))
          if (!index) throw new Error('pagefind: no index')
          const site = fileURLToPath(dir)
          const { page_count } = check(
            await index.addDirectory({ path: site, glob: 'releases/vx-*/index.html' }),
          )
          if (page_count === 0) throw new Error('pagefind: no release notes found')
          check(await index.writeFiles({ outputPath: `${site}${RELEASES_BUNDLE}/` }))
          logger.info(`Indexed ${page_count} release notes apart.`)
        } finally {
          await pagefind.close()
        }
      },
    },
  }
}
