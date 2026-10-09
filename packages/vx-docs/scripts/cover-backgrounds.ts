// Writes the drawn covers' backgrounds (src/components/blog/Cover.astro),
// one WebP per tone in src/blog/tones.ts, to public/blog/ (the grid over it
// is public/blog/grid.png, a tile: as SVG it rasterized per tile). The same ink and glows as CSS gradients cost the blog index 4× the raster time
// while scrolling (radial gradients repaint per tile); a bitmap is a copy.
// Run by hand when a tone changes: bun scripts/cover-backgrounds.ts
import sharp from 'sharp'
import { TONE_COLORS } from '../src/blog/tones.ts'

const svg = (
  c: string,
): string => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
<defs>
<radialGradient id="a" cx="92%" cy="-10%" r="80%"><stop offset="0" stop-color="${c}" stop-opacity=".3"/><stop offset=".7" stop-color="${c}" stop-opacity="0"/></radialGradient>
<radialGradient id="b" cx="-5%" cy="110%" r="65%"><stop offset="0" stop-color="${c}" stop-opacity=".12"/><stop offset=".7" stop-color="${c}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1200" height="630" fill="#0a0b0d"/>
<rect width="1200" height="630" fill="url(#a)"/>
<rect width="1200" height="630" fill="url(#b)"/>
</svg>`

for (const c of TONE_COLORS) {
  const out = new URL(`../public/blog/tone-${c.slice(1)}.webp`, import.meta.url).pathname
  await sharp(Buffer.from(svg(c)))
    .webp({ quality: 82 })
    .toFile(out)
  console.log(out)
}

const grid =
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><path d="M0 .5H28M.5 0V28" stroke="#fff" stroke-opacity=".035"/></svg>'
await sharp(Buffer.from(grid))
  .png()
  .toFile(new URL('../public/blog/grid.png', import.meta.url).pathname)
