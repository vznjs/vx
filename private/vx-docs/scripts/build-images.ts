// The site's raster images, resized ahead of `astro build` (`build.images`
// in vx.config.ts): a key over the images alone, so a docs edit rebuilds
// pages and never re-encodes 876 variants (13 s of a cold build). Writes
// public/_img/<name>-<width>.<hash>.<ext>, which astro copies as it is, and
// public/_img/images.json, which src/images.ts reads.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

// What the components ask for: every width a layout's srcset names, and the
// link card each page's og:image points at.
const SETS = {
  features: { webp: [400, 640, 800, 960, 1280, 1600], jpeg: [1200] },
  blog: { webp: [480, 800, 1200], png: [1200] },
} as const

const ROOT = path.resolve(import.meta.dir, '..')
const OUT = path.join(ROOT, 'public/_img')

export type Entry = { width: number; height: number; hash: string }

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const jobs: (() => Promise<void>)[] = []
const manifest: Record<string, Entry> = {}
for (const [dir, formats] of Object.entries(SETS)) {
  for (const file of readdirSync(path.join(ROOT, 'src/assets', dir)).sort()) {
    if (!file.endsWith('.png')) continue
    const bytes = readFileSync(path.join(ROOT, 'src/assets', dir, file))
    const name = file.slice(0, -4)
    const hash = Bun.hash.xxHash3(bytes).toString(16).padStart(16, '0').slice(0, 8)
    jobs.push(async () => {
      const { width, height } = await sharp(bytes).metadata()
      manifest[`${dir}/${name}`] = { width: width!, height: height!, hash }
    })
    for (const [format, widths] of Object.entries(formats)) {
      for (const w of widths) {
        jobs.push(async () => {
          const img = sharp(bytes).resize({ width: w, withoutEnlargement: true })
          const out =
            format === 'webp'
              ? img.webp({ quality: 80 })
              : format === 'jpeg'
                ? img.jpeg({ quality: 82 })
                : img.png()
          await out.toFile(path.join(OUT, `${name}-${w}.${hash}.${format}`))
        })
      }
    }
  }
}

// sharp runs each encode on libuv's pool; one in flight per core keeps it full.
let next = 0
await Promise.all(
  Array.from({ length: availableParallelism() }, async () => {
    while (next < jobs.length) await jobs[next++]!()
  }),
)
writeFileSync(
  path.join(OUT, 'images.json'),
  `${JSON.stringify(Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`,
)
console.log(
  `${jobs.length - Object.keys(manifest).length} variants of ${Object.keys(manifest).length} images`,
)
