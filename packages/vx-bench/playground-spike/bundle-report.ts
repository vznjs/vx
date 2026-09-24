// W9 (items 676, 695): what the playground bundle costs and what it reaches for.
//
//   bun packages/vx-bench/playground-spike/bundle-report.ts
//
// Builds with the site's own `buildPlayground()`
// (packages/vx-docs/scripts/build-playground.ts, what
// `@vzn/vx-docs#build.playground` runs) and prints raw and gzipped sizes,
// every platform specifier the import graph asked for and how it was met,
// and the byte split per module, largest first. The design note's bundle
// tables come from here.

import { buildPlayground } from '../../vx-docs/scripts/build-playground.js'

const { bytes, specifiers, metafile } = await buildPlayground()

const inputs = Object.entries(
  (metafile as { outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }> })
    .outputs,
)
  .flatMap(([, o]) => Object.entries(o.inputs))
  .map(([file, v]) => [file.replace(/^.*packages\//, ''), v.bytesInOutput] as const)
  .sort((a, b) => b[1] - a[1])

const byModule = new Map<string, number>()
for (const [file, n] of inputs) {
  const key = file.startsWith('vx/src/')
    ? file.split('/').slice(0, 3).join('/')
    : file.startsWith('vx-docs/')
      ? 'playground shim + entry'
      : file.includes('node_modules') || !file.includes('/')
        ? 'bun browser polyfills'
        : file
  byModule.set(key, (byModule.get(key) ?? 0) + n)
}

console.log(
  JSON.stringify(
    {
      bun: Bun.version,
      rawBytes: bytes.byteLength,
      gzipBytes: Bun.gzipSync(bytes, { level: 9 }).byteLength,
      platformSpecifiers: Object.fromEntries(
        [...specifiers].map(([spec, { treatment, importers }]) => [
          spec,
          { treatment, importers: [...importers].sort() },
        ]),
      ),
      bytesByModule: Object.fromEntries([...byModule].sort((a, b) => b[1] - a[1])),
      largestInputs: inputs.slice(0, 15),
    },
    null,
    2,
  ),
)
