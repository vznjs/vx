// Every package ships its TypeScript source, so a user's `tsc` type-checks
// ours under THEIR compiler options. This repo's tsconfig turns on
// `exactOptionalPropertyTypes`, under which code passed here and failed for
// a plugin author on `bun init`'s tsconfig (six errors inside @vzn/vx, one
// in @vzn/vx-dte-server), and a file-import declaration only this repo's
// `include` brought in was missing for them. The check runs tsc
// (`typescript`, a root devDependency for this test alone) over every
// public entry with `bun init`'s options, from outside the repo's tsconfigs.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'

const ROOT = path.resolve(import.meta.dir, '../../..')

/** Each public package's exported entry files. */
function entries(): string[] {
  const out: string[] = []
  for (const dir of readdirSync(path.join(ROOT, 'packages'))) {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'packages', dir, 'package.json'), 'utf8'))
    if (pkg.private === true) continue
    for (const target of Object.values(pkg.exports as Record<string, { types: string }>))
      out.push(path.join(ROOT, 'packages', dir, target.types))
  }
  return out
}

it("every public entry type-checks under bun init's tsconfig", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-consumer-types-'))
  try {
    const files = entries()
    expect(files.length).toBeGreaterThan(10)
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          lib: ['ESNext'],
          target: 'ESNext',
          module: 'Preserve',
          moduleDetection: 'force',
          jsx: 'react-jsx',
          allowJs: true,
          moduleResolution: 'bundler',
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          noFallthroughCasesInSwitch: true,
          noUncheckedIndexedAccess: true,
          noImplicitOverride: true,
          typeRoots: [path.join(ROOT, 'node_modules/@types')],
          types: ['bun'],
        },
        files,
      }),
    )
    const tsc = Bun.spawnSync({
      cmd: ['node', path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', dir],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const said = `${tsc.stdout.toString()}${tsc.stderr.toString()}`
    expect(said).toBe('')
    expect(tsc.exitCode).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
