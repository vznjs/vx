// Manual publication-copy maintenance, never a benchmark or a build task:
// bun packages/vx-docs/scripts/scope-feature-covers.ts          # update known covers
// bun packages/vx-docs/scripts/scope-feature-covers.ts --check  # read-only drift check
// The existing feature content stays pixel-identical outside the footer and
// the watch/quickstart context strips. Only the daemon/history illustrations are redrawn.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'

const SITE = path.resolve(import.meta.dir, '..')
const ASSETS = path.join(SITE, 'src/assets/features')
const SOURCES = path.join(SITE, 'scripts/feature-covers')
const FOOTER = { left: 190, top: 812, width: 610, height: 64 }
const WATCH_CONTEXT = { left: 72, top: 690, width: 1456, height: 70 }
const QUICKSTART_CONTEXT = { left: 72, top: 690, width: 650, height: 70 }
const COVERS = [
  'affected',
  'critical-path',
  'ctrl-c',
  'dev-servers',
  'dry-run',
  'fastest',
  'flaky-detection',
  'framed-output',
  'github-ci',
  'keys-from-git',
  'lockfile-keys',
  'mcp',
  'migrate',
  'no-daemon',
  'one-binary',
  'opentelemetry',
  'playground',
  'plugins',
  'profile',
  'quickstart',
  'remote-execution',
  'run-summary',
  'sandbox',
  'skipped-blockers',
  'small-things',
  'strict-outputs',
  'task-picker',
  'turbo-nx-flags',
  'typescript-config',
  'vx-last',
  'vx-lock',
  'vx-show',
  'vx-why',
  'watch',
] as const

function render(file: string): Buffer {
  const result = spawnSync('rsvg-convert', [file], { maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${file}: ${result.stderr.toString().trim()}`)
  return result.stdout
}

async function pixels(input: Buffer): Promise<Buffer> {
  return sharp(input).removeAlpha().raw().toBuffer()
}

async function assertShape(input: Buffer, name: string): Promise<void> {
  const { width, height, format } = await sharp(input).metadata()
  if (width !== 1600 || height !== 900 || format !== 'png')
    throw new Error(`${name}: expected a 1600x900 PNG, got ${width}x${height} ${format}`)
}

const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--check'))
  throw new Error('Usage: scope-feature-covers.ts [--check]')
const check = args[0] === '--check'
sharp.concurrency(1)
const footer = render(path.join(SOURCES, 'footer.svg'))
const watch = render(path.join(SOURCES, 'watch-context.svg'))
const quickstart = render(path.join(SOURCES, 'quickstart-context.svg'))
const footerPixels = await pixels(footer)
const watchPixels = await pixels(watch)
const quickstartPixels = await pixels(quickstart)

// Validate the complete known set before any write, including an early drift
// after an upstream replacement. Never glob new assets into the write set.
const inputs = new Map<string, Buffer>()
for (const name of COVERS) {
  const input = await readFile(path.join(ASSETS, `${name}.png`))
  await assertShape(input, name)
  inputs.set(name, input)
}

const updates = new Map<string, Buffer>()
for (const name of COVERS) {
  const input = inputs.get(name)!
  let output: Buffer
  if (name === 'fastest') {
    // Already neutral: retain its bytes if the current source still matches.
    output = render(path.join(SITE, 'src/features/fastest.svg'))
    if ((await pixels(input)).equals(await pixels(output))) continue
  } else if (name === 'no-daemon' || name === 'critical-path') {
    output = await sharp(render(path.join(SOURCES, `${name}.svg`)))
      .composite([{ input: footer, left: FOOTER.left, top: FOOTER.top }])
      .png({ compressionLevel: 9 })
      .toBuffer()
    if (input.equals(output)) continue
  } else {
    const currentFooter = await sharp(input).extract(FOOTER).removeAlpha().raw().toBuffer()
    const footerMatches = currentFooter.equals(footerPixels)
    const context =
      name === 'watch'
        ? { area: WATCH_CONTEXT, input: watch, expected: watchPixels }
        : name === 'quickstart'
          ? { area: QUICKSTART_CONTEXT, input: quickstart, expected: quickstartPixels }
          : undefined
    const contextMatches =
      !context ||
      (await sharp(input).extract(context.area).removeAlpha().raw().toBuffer()).equals(
        context.expected,
      )
    if (footerMatches && contextMatches) continue
    output = await sharp(input)
      .composite([
        { input: footer, left: FOOTER.left, top: FOOTER.top },
        ...(context
          ? [{ input: context.input, left: context.area.left, top: context.area.top }]
          : []),
      ])
      .png({ compressionLevel: 9 })
      .toBuffer()
  }
  await assertShape(output, name)
  updates.set(name, output)
}

// Every source has rendered and every candidate has passed the shape check.
for (const [name, output] of updates) {
  console.log(`${check ? 'DRIFT' : 'UPDATE'} ${name}.png`)
  if (!check) await writeFile(path.join(ASSETS, `${name}.png`), output)
}
console.log(`${COVERS.length} covers checked; ${updates.size} ${check ? 'drifted' : 'changed'}.`)
if (check && updates.size > 0) process.exitCode = 1
