#!/usr/bin/env bun
// Assemble the publishable npm tree from the compiled standalone binaries
// (`dist/vx-<target>`, produced by `vx run build`).
//
// Emits, under <out> (default dist/npm):
//   @vzn/vx-<target>/  — one per platform: the raw `vx` binary + os/cpu manifest
//   vx/                — the primary @vzn/vx package: library source
//                        (exports ./src/index.ts) PLUS a Node launcher +
//                        the 4 platform packages as optionalDependencies.
//
// npm installs only the platform package matching the user's os/cpu, and the
// launcher execs its binary — so `npm i -g @vzn/vx` gives the command with NO
// Bun and no install-time download.
//
// Publishing is done by the workflow (`npm publish` in each emitted dir); this
// script only builds the tree.
//
//   bun scripts/build-npm.ts <version> [--out=dist/npm] [--only=linux-x64]

import { chmod, cp, mkdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

interface Target {
  target: string
  os: string
  cpu: string
}

const TARGETS: readonly Target[] = [
  { target: 'linux-x64', os: 'linux', cpu: 'x64' },
  { target: 'linux-arm64', os: 'linux', cpu: 'arm64' },
  { target: 'darwin-x64', os: 'darwin', cpu: 'x64' },
  { target: 'darwin-arm64', os: 'darwin', cpu: 'arm64' },
]

const ROOT = dirname(import.meta.dir) // scripts/ -> repo root
// Core is a workspace member now, so its sources, manifest and compiled
// binaries live under packages/vx — only README/LICENSE stay repo-wide.
const CORE = join(ROOT, 'packages', 'vx')
const REPOSITORY = 'https://github.com/vznjs/vx'

function parseArgs(argv: readonly string[]): { version: string; out: string; only?: string } {
  let version: string | undefined
  let out = 'dist/npm'
  let only: string | undefined
  for (const a of argv) {
    if (a.startsWith('--out=')) out = a.slice('--out='.length)
    else if (a.startsWith('--only=')) only = a.slice('--only='.length)
    else if (!a.startsWith('--')) version = a
  }
  if (version === undefined) {
    throw new Error('usage: bun scripts/build-npm.ts <version> [--out=dir] [--only=target]')
  }
  // Accept a leading `v` (a git tag like v1.2.3) and strip it.
  version = version.replace(/^v/, '')
  return { version, out, ...(only !== undefined ? { only } : {}) }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, JSON.stringify(value, null, 2) + '\n')
}

/** All four `<mainName>-<target>` optionalDependencies at `version`. The
 *  published manifest always lists all four (the registry resolves the matching
 *  one); a `--only` local build emits just one but still declares all four. */
function allOptional(mainName: string, version: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of TARGETS) out[`${mainName}-${t.target}`] = version
  return out
}

/**
 * Emit the per-platform binary packages. Each is `<mainName>-<target>`
 * carrying the raw binary (named `<base>`) + an os/cpu manifest, copied from
 * `dist/<distPrefix>-<target>`.
 */
async function emitPlatformPackages(args: {
  mainName: string
  base: string
  distPrefix: string
  targets: readonly Target[]
  version: string
  outDir: string
}): Promise<void> {
  const { mainName, base, distPrefix, targets, version, outDir } = args
  for (const t of targets) {
    const pkgName = `${mainName}-${t.target}`
    const binSrc = join(CORE, 'dist', `${distPrefix}-${t.target}`)
    if (!(await Bun.file(binSrc).exists())) {
      throw new Error(`missing binary ${binSrc} — run \`vx run build\` first`)
    }
    const pkgDir = join(outDir, pkgName)
    await mkdir(pkgDir, { recursive: true })
    const binDst = join(pkgDir, base)
    await cp(binSrc, binDst)
    await chmod(binDst, 0o755)

    await writeJson(join(pkgDir, 'package.json'), {
      name: pkgName,
      version,
      description: `Prebuilt ${base} binary for ${t.os}-${t.cpu}.`,
      license: 'MIT',
      repository: REPOSITORY,
      os: [t.os],
      cpu: [t.cpu],
      files: [base],
    })
    await Bun.write(
      join(pkgDir, 'README.md'),
      `# ${pkgName}\n\nThe ${t.os}-${t.cpu} prebuilt binary for [\`${mainName}\`](${REPOSITORY}).\n\nYou don't install this directly — it's an optionalDependency of \`${mainName}\`, which npm installs automatically on a matching platform.\n`,
    )
  }
}

async function main(): Promise<void> {
  const { version, out, only } = parseArgs(Bun.argv.slice(2))
  const outDir = isAbsolute(out) ? out : join(ROOT, out)
  const targets = only ? TARGETS.filter((t) => t.target === only) : TARGETS
  if (targets.length === 0) throw new Error(`--only=${only}: unknown target`)

  await rm(outDir, { recursive: true, force: true })

  const corePkg = (await Bun.file(join(CORE, 'package.json')).json()) as {
    description?: string
    dependencies?: Record<string, string>
    exports: Record<string, unknown>
  }

  // --- @vzn/vx: platform binaries + the library/launcher package -----------
  await emitPlatformPackages({
    mainName: '@vzn/vx',
    base: 'vx',
    distPrefix: 'vx',
    targets,
    version,
    outDir,
  })

  const mainDir = join(outDir, 'vx')
  await mkdir(mainDir, { recursive: true })
  await cp(join(CORE, 'src'), join(mainDir, 'src'), { recursive: true })
  // The root shims: Bun 1.4.0's compiled binary resolves an on-disk package
  // by `<pkg>/index.ts` / `<pkg>/<subpath>/index.ts` and ignores the exports
  // map, so without these a workspace config fails to import `@vzn/vx` under
  // the very binary this package ships (see packages/vx/index.ts).
  await cp(join(CORE, 'index.ts'), join(mainDir, 'index.ts'))
  await cp(join(CORE, 'plugins'), join(mainDir, 'plugins'), { recursive: true })
  await cp(join(ROOT, 'scripts', 'npm-launcher.mjs'), join(mainDir, 'launcher.mjs'))
  await cp(join(ROOT, 'README.md'), join(mainDir, 'README.md'))
  await cp(join(ROOT, 'LICENSE'), join(mainDir, 'LICENSE'))

  await writeJson(join(mainDir, 'package.json'), {
    name: '@vzn/vx',
    version,
    description: corePkg.description ?? 'An open, extensible monorepo task runner.',
    type: 'module',
    // The library surface — plugin authors `import { defineProject } from '@vzn/vx'`.
    // The same exports map the workspace package declares — the plugin
    // subpaths (`@vzn/vx/plugins/local-executor`, …) are what every
    // vx.workspace.ts imports; a map with only "." shipped once.
    exports: corePkg.exports,
    types: './src/index.ts',
    // The CLI — a Node launcher that execs the matching platform binary.
    bin: { vx: './launcher.mjs' },
    engines: { node: '>=18' },
    optionalDependencies: allOptional('@vzn/vx', version),
    // Runtime deps the library source needs when imported (the binary embeds
    // its own copy). Mirrors the workspace root so versions never drift.
    dependencies: corePkg.dependencies ?? {},
    files: ['index.ts', 'plugins', 'src', 'launcher.mjs', 'README.md', 'LICENSE'],
    repository: REPOSITORY,
    homepage: `${REPOSITORY}#readme`,
    bugs: `${REPOSITORY}/issues`,
    license: 'MIT',
    keywords: ['monorepo', 'task-runner', 'build', 'cache', 'bun', 'turborepo', 'nx'],
  })

  const names = [...targets.map((t) => `@vzn/vx-${t.target}`), '@vzn/vx']
  process.stdout.write(
    `built npm tree at ${out} (version ${version}):\n` +
      names.map((n) => `  ${n}`).join('\n') +
      `\n\nto publish (needs NPM auth):\n` +
      names.map((n) => `  npm publish ${join(out, dirFor(n))} --access public`).join('\n') +
      '\n',
  )
}

/** The emitted directory basename for a package name (the main pkg drops the scope). */
function dirFor(name: string): string {
  return name === '@vzn/vx' ? 'vx' : name
}

await main()
