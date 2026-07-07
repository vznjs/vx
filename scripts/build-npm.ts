#!/usr/bin/env bun
// Assemble the publishable npm tree from the compiled standalone binaries
// (`dist/vx-<target>` + `dist/vx-cloud-<target>`, produced by `vx run build`).
//
// Emits, under <out> (default dist/npm):
//   @vzn/vx-<target>/        — one per platform: the raw `vx` binary + os/cpu manifest
//   vx/                      — the primary @vzn/vx package: library source
//                              (exports ./src/index.ts) PLUS a Node launcher +
//                              the 4 platform packages as optionalDependencies.
//   @vzn/vx-cloud-<target>/  — one per platform: the raw `vx-cloud` binary + manifest
//   vx-cloud/                — the @vzn/vx-cloud package: the cloud() plugin +
//                              service source (exports . / ./plugin) PLUS a Node
//                              launcher + its 4 platform binaries.
//
// Both CLIs install the same way: npm installs only the platform package
// matching the user's os/cpu, and the launcher execs its binary — so
// `npm i -g @vzn/vx` / `@vzn/vx-cloud` gives the command with NO Bun and no
// install-time download. The @vzn/vx-cloud plugin (`@vzn/vx-cloud/plugin`) stays
// importable source, evaluated inside the vx runtime.
//
// Publishing is done by the workflow (`npm publish` in each emitted dir); this
// script only builds the tree.
//
//   bun scripts/build-npm.ts <version> [--out=dist/npm] [--only=linux-x64]

import { chmod, cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
 * Emit the per-platform binary packages for one CLI family. Each is
 * `<mainName>-<target>` carrying the raw binary (named `<base>`) + an os/cpu
 * manifest, copied from `dist/<distPrefix>-<target>`. Shared by @vzn/vx and
 * @vzn/vx-cloud — the only differences are the name, the binary filename, and
 * which dist binaries to copy.
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
    const binSrc = join(ROOT, 'dist', `${distPrefix}-${t.target}`)
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
  const outDir = join(ROOT, out)
  const targets = only ? TARGETS.filter((t) => t.target === only) : TARGETS
  if (targets.length === 0) throw new Error(`--only=${only}: unknown target`)

  await rm(outDir, { recursive: true, force: true })

  const rootPkg = (await Bun.file(join(ROOT, 'package.json')).json()) as {
    description?: string
    dependencies?: Record<string, string>
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
  await cp(join(ROOT, 'src'), join(mainDir, 'src'), { recursive: true })
  await cp(join(ROOT, 'scripts', 'npm-launcher.mjs'), join(mainDir, 'launcher.mjs'))
  await cp(join(ROOT, 'README.md'), join(mainDir, 'README.md'))
  await cp(join(ROOT, 'LICENSE'), join(mainDir, 'LICENSE'))

  await writeJson(join(mainDir, 'package.json'), {
    name: '@vzn/vx',
    version,
    description: rootPkg.description ?? 'An open, extensible monorepo task runner.',
    type: 'module',
    // The library surface — plugin authors `import { defineProject } from '@vzn/vx'`.
    exports: { '.': { types: './src/index.ts', import: './src/index.ts' } },
    types: './src/index.ts',
    // The CLI — a Node launcher that execs the matching platform binary.
    bin: { vx: './launcher.mjs' },
    engines: { node: '>=18' },
    optionalDependencies: allOptional('@vzn/vx', version),
    // Runtime deps the library source needs when imported (the binary embeds
    // its own copy). Mirrors the workspace root so versions never drift.
    dependencies: rootPkg.dependencies ?? {},
    files: ['src', 'launcher.mjs', 'README.md', 'LICENSE'],
    repository: REPOSITORY,
    homepage: `${REPOSITORY}#readme`,
    bugs: `${REPOSITORY}/issues`,
    license: 'MIT',
    keywords: ['monorepo', 'task-runner', 'build', 'cache', 'bun', 'turborepo', 'nx'],
  })

  await buildCloudPackage(version, outDir, targets)

  const names = [
    ...targets.map((t) => `@vzn/vx-${t.target}`),
    '@vzn/vx',
    ...targets.map((t) => `@vzn/vx-cloud-${t.target}`),
    '@vzn/vx-cloud',
  ]
  process.stdout.write(
    `built npm tree at ${out} (version ${version}):\n` +
      names.map((n) => `  ${n}`).join('\n') +
      `\n\nto publish (needs NPM auth):\n` +
      names.map((n) => `  npm publish ${join(out, dirFor(n))} --access public`).join('\n') +
      '\n',
  )
}

/** The emitted directory basename for a package name (the main pkgs drop the scope). */
function dirFor(name: string): string {
  if (name === '@vzn/vx') return 'vx'
  if (name === '@vzn/vx-cloud') return 'vx-cloud'
  return name
}

/**
 * Emit `@vzn/vx-cloud` the SAME no-Bun way as `@vzn/vx`: per-platform
 * `@vzn/vx-cloud-<target>` binary packages (the compiled `vx-cloud` CLI, with
 * core + the dashboard embedded) plus a launcher package. The `cloud()` plugin
 * stays importable source (`@vzn/vx-cloud/plugin`, evaluated inside the vx
 * runtime), so the package ships `src` + `ui/dist` alongside the launcher, and
 * keeps `@vzn/vx` as a dep for the plugin path + the Bun source fallback.
 */
async function buildCloudPackage(
  version: string,
  outDir: string,
  targets: readonly Target[],
): Promise<void> {
  const CLOUD = join(ROOT, 'packages', 'cloud')
  // The dashboard SPA dist is a build artifact (not committed). The binary
  // embeds it at compile time; the shipped source needs it for the Bun source
  // fallback. Build it if `vx run build` (build.ui) didn't already.
  if (!(await Bun.file(join(CLOUD, 'ui', 'dist', 'index.html')).exists())) {
    const spa = Bun.spawnSync({
      cmd: ['bun', 'run', 'build'],
      cwd: join(CLOUD, 'ui'),
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if (spa.exitCode !== 0) throw new Error('vx-cloud dashboard SPA build failed')
  }

  await emitPlatformPackages({
    mainName: '@vzn/vx-cloud',
    base: 'vx-cloud',
    distPrefix: 'vx-cloud',
    targets,
    version,
    outDir,
  })

  const dir = join(outDir, 'vx-cloud')
  await mkdir(dir, { recursive: true })
  await cp(join(CLOUD, 'src'), join(dir, 'src'), { recursive: true })
  await cp(join(CLOUD, 'ui', 'dist'), join(dir, 'ui', 'dist'), { recursive: true })
  await cp(join(ROOT, 'scripts', 'npm-launcher.mjs'), join(dir, 'launcher.mjs'))
  await cp(join(ROOT, 'LICENSE'), join(dir, 'LICENSE'))
  await Bun.write(
    join(dir, 'README.md'),
    `# @vzn/vx-cloud\n\nThe [vx](${REPOSITORY}) orchestrator service (\`vx-cloud serve\` / \`agent\` / \`connect\`) and the first-party \`cloud()\` plugin.\n\n\`\`\`sh\nnpm i -g @vzn/vx-cloud   # the vx-cloud CLI — a standalone binary, no Bun needed\n\`\`\`\n\nOr just the plugin, in your \`vx.workspace.ts\`:\n\n\`\`\`ts\nimport { defineWorkspace } from '@vzn/vx'\nimport { cloud } from '@vzn/vx-cloud/plugin'\nexport default defineWorkspace({ plugins: [cloud()] })\n\`\`\`\n\nLike \`@vzn/vx\`, the \`vx-cloud\` CLI ships as a prebuilt standalone binary per\nplatform (with the dashboard embedded) — **no Bun required** to run it. The\n\`cloud()\` plugin is TypeScript source, evaluated inside the vx runtime. See the\n[docs](${REPOSITORY}) for self-hosting + distributed CI.\n`,
  )
  await writeJson(join(dir, 'package.json'), {
    name: '@vzn/vx-cloud',
    version,
    description:
      'The vx-cloud orchestrator service (serve, agents, distribution) + the cloud() plugin.',
    type: 'module',
    exports: {
      '.': { types: './src/index.ts', import: './src/index.ts' },
      './plugin': { types: './src/plugin.ts', import: './src/plugin.ts' },
    },
    types: './src/index.ts',
    // The CLI — a Node launcher execing the matching platform binary (no Bun).
    bin: { 'vx-cloud': './launcher.mjs' },
    // The launcher's Bun source-fallback entry (the shipped src bin).
    vxSourceEntry: 'src/cli/bin.ts',
    engines: { node: '>=18' },
    optionalDependencies: allOptional('@vzn/vx-cloud', version),
    // Pin core to the same version — the plugin source + the Bun source fallback
    // resolve the bare `import '@vzn/vx'` from node_modules (the binary bundles
    // its own copy and doesn't need this).
    dependencies: { '@vzn/vx': version },
    files: ['src', 'ui/dist', 'launcher.mjs', 'README.md', 'LICENSE'],
    repository: REPOSITORY,
    homepage: `${REPOSITORY}#readme`,
    bugs: `${REPOSITORY}/issues`,
    license: 'MIT',
    keywords: ['vx', 'monorepo', 'ci', 'distributed', 'remote-cache', 'dashboard', 'bun'],
  })
}

await main()
