// Every page on the site that shows a `defineProject` / `defineWorkspace`
// block is a page a newcomer copies from, and nothing type-checked those
// blocks: schema.md's own "Full example" declared a `ci` group depending on
// two tasks the example never declared, a type error in the IDE that the
// page had carried since the typed `dependsOn` arrived (item 284). The
// plugins guide has its own pin (plugins-guide-snippets.test.ts); this one
// takes every other page. A block is a config when it calls one of the two
// and imports only `@vzn/*` packages; fragments (no import, a relative
// preset path, a signature sketch) are illustrations and stay out.
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'

const SITE = path.resolve(import.meta.dir, '..')
const DOCS = path.join(SITE, 'src/content/docs')
const ROOT = path.resolve(SITE, '../..')
const OXLINT = path.join(ROOT, 'node_modules/.bin/oxlint')

/** The plugin packages a page may import for illustration. The pin is about
 *  core's config types, and the site depends on none of these, so under the
 *  sandbox they do not resolve: ambient-typed as `any`, like the Sentry SDK
 *  in the plugins guide's pin. */
const AMBIENT = [
  '@vzn/vx-reapi',
  '@vzn/vx-otel',
  '@vzn/vx-lockfile',
  '@vzn/vx-migrate',
  '@vzn/vx-mcp',
  '@vzn/vx-github',
  '@vzn/vx-schedule-history',
]

async function pages(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'blog') out.push(...(await pages(p)))
    } else if (e.name.endsWith('.md') && !p.endsWith('guides/plugins.md')) out.push(p)
  }
  return out
}

function isConfigBlock(block: string): boolean {
  if (!/define(Project|Workspace)\(/.test(block)) return false
  // A skeleton with `<taskName>`-style placeholders or an ellipsis is a
  // shape, not a config.
  if (/<[a-zA-Z-]+>|…/.test(block)) return false
  const specifiers = [...block.matchAll(/from '([^']+)'/g)].map((m) => m[1]!)
  return specifiers.length > 0 && specifiers.every((s) => s.startsWith('@vzn/'))
}

it('every config block on the site type-checks against @vzn/vx', async () => {
  const blocks: { page: string; index: number; text: string }[] = []
  for (const page of await pages(DOCS)) {
    const text = await Bun.file(page).text()
    for (const [index, m] of [...text.matchAll(/```ts\n([\s\S]*?)```/g)].entries()) {
      if (isConfigBlock(m[1]!)) blocks.push({ page: path.relative(DOCS, page), index, text: m[1]! })
    }
  }
  expect(blocks.length).toBeGreaterThan(10)
  expect(blocks.some((b) => b.page === 'schema.md')).toBe(true)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-config-snippets-'))
  try {
    await symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          target: 'esnext',
          noEmit: true,
          allowImportingTsExtensions: true,
          types: ['bun'],
        },
        include: ['*.ts', '*.d.ts'],
      }),
    )
    await writeFile(
      path.join(dir, 'ambient.d.ts'),
      AMBIENT.map((m) => `declare module '${m}'`).join('\n') + '\n',
    )
    const files: string[] = []
    for (const b of blocks) {
      const file = path.join(dir, `${b.page.replace(/[/.]/g, '-')}-${b.index}.ts`)
      await writeFile(file, b.text)
      files.push(file)
    }
    // The files are named one by one: pointed at the directory, oxlint walks
    // the symlinked node_modules until the kernel kills it.
    const p = Bun.spawnSync({
      cmd: [OXLINT, '--type-aware', '--type-check', ...files],
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
    const errors = out.split('\n').filter((l) => /^\s*x |: error /.test(l))
    const tail = p.exitCode === 0 ? [] : out.trim().split('\n').slice(-15)
    expect({ exitCode: p.exitCode, errors, tail }).toEqual({ exitCode: 0, errors: [], tail: [] })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 120_000)
