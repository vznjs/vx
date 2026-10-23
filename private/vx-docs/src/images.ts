// The resized images `build.images` writes (scripts/build-images.ts): an
// <img> srcset over its widths, and one variant's URL for a link card.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Entry } from '../scripts/build-images.ts'

// Astro builds from the package root; a module URL points into the bundle.
const MANIFEST: Record<string, Entry> = JSON.parse(
  readFileSync(path.resolve('public/_img/images.json'), 'utf8'),
)
const BASE = `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}_img/`

// `key` is `<dir>/<name>`: `features/affected` for src/assets/features/affected.png.
function entry(key: string): Entry {
  const e = MANIFEST[key]
  if (e === undefined) throw new Error(`no image src/assets/${key}.png`)
  return e
}

export function imageUrl(key: string, width: number, format: 'webp' | 'jpeg' | 'png'): string {
  const name = key.slice(key.indexOf('/') + 1)
  return `${BASE}${name}-${width}.${entry(key).hash}.${format}`
}

// The largest width is the src, as astro's <Image> did, and the box's
// width and height are its, so the layout reserves the space before load.
export function srcset(key: string, widths: number[]) {
  const { width, height } = entry(key)
  const largest = Math.max(...widths)
  return {
    src: imageUrl(key, largest, 'webp'),
    srcset: widths.map((w) => `${imageUrl(key, w, 'webp')} ${w}w`).join(', '),
    width: largest,
    height: Math.round((height * largest) / width),
  }
}
