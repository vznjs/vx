// Every page on the site that shows a `defineProject` / `defineWorkspace`
// block is a page a newcomer copies from, and nothing type-checked those
// blocks: schema.md's own "Full example" declared a `ci` group depending on
// two tasks the example never declared, a type error in the IDE that the
// page had carried since the typed `dependsOn` arrived (item 284). The
// plugins guide has its own pin (plugins-guide-snippets.test.ts); this one
// takes every other page, `.md` and `.mdx` alike (a chapter with a widget
// is MDX, item 680), blog posts, release notes and plugin pages included:
// each is a page a reader copies from. A block is a config when it calls
// one of the two and imports only `@vzn/*` packages; fragments (no import,
// a relative preset path, a signature sketch) are illustrations and stay
// out.
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'

const SITE = path.resolve(import.meta.dir, '..')
const DOCS = path.join(SITE, 'src/content/docs')
const ROOT = path.resolve(SITE, '../..')
const OXLINT = path.join(ROOT, 'node_modules/.bin/oxlint')

/** The plugin packages a page imports, linked by this site (package.json)
 *  for this pin: a call to one is checked against its own source, as the
 *  plugins guide's pin does. Typed `any`, a page's `type NxExecutorTarget`
 *  import read as a namespace and a callback's parameter as implicit `any`. */
const TYPED = ['vx-cache', 'vx-ci', 'vx-dte', 'vx-history', 'vx-lockfile', 'vx-migrate', 'vx-otel']

/** `vx-reapi`'s types reach gRPC's, which the site does not install. The
 *  pin is about core's config types, so it is ambient-typed as `any`, like
 *  the Sentry SDK in the plugins guide's pin. */
const AMBIENT = ['@vzn/vx-reapi']

/** Release notes record what shipped: a key a later release took away stays
 *  in the note that introduced it. Each excuse must still be needed. */
const RECORDS: Record<string, string> = {
  'releases/vx-0-0-325.md-0': '`run.affectedBase`, since the `VX_AFFECTED_BASE` variable only',
}

async function pages(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await pages(p)))
    else if (/\.mdx?$/.test(e.name) && !p.endsWith('docs/writing-plugins.mdx')) out.push(p)
  }
  return out
}

/** The block with its comments and string literals blanked: a
 *  `~/.vx/<id>/cache` comment or a `'Bearer …'` string is prose, not a
 *  placeholder. */
function codeOnly(block: string): string {
  return block.replace(/\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '')
}

function isConfigBlock(block: string): boolean {
  if (!/define(Project|Workspace)\(/.test(block)) return false
  // A skeleton with `<taskName>`-style placeholders or an ellipsis is a
  // shape, not a config.
  if (/<[a-zA-Z-]+>|…/.test(codeOnly(block))) return false
  const specifiers = [...block.matchAll(/from '([^']+)'/g)].map((m) => m[1]!)
  return specifiers.length > 0 && specifiers.every((s) => s.startsWith('@vzn/'))
}

it('every config block on the site type-checks against @vzn/vx', async () => {
  const blocks: { page: string; index: number; text: string }[] = []
  for (const page of await pages(DOCS)) {
    const text = await Bun.file(page).text()
    const fences = text.matchAll(/```(?:ts|tsx|typescript|js|mjs)\b[^\n]*\n([\s\S]*?)```/g)
    for (const [index, m] of [...fences].entries()) {
      if (isConfigBlock(m[1]!)) blocks.push({ page: path.relative(DOCS, page), index, text: m[1]! })
    }
  }
  expect(blocks.length).toBeGreaterThan(10)
  for (const page of ['schema.md', 'docs/workspace.mdx', 'plugins/vx-otel.md']) {
    expect(blocks.some((b) => b.page === page)).toBe(true)
  }
  for (const where of Object.keys(RECORDS)) {
    expect(blocks.some((b) => `${b.page}-${b.index}` === where)).toBe(true)
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-config-snippets-'))
  try {
    // The root's node_modules minus the plugin packages: linked whole, the
    // checker resolved `@vzn/vx-reapi` through it to the real package
    // before the ambient `any`, a read of a project the task does not own
    // (a seatbelt violation on macOS; Linux's sandbox hides it silently).
    const nm = path.join(dir, 'node_modules')
    await mkdir(path.join(nm, '@vzn'), { recursive: true })
    for (const e of await readdir(path.join(ROOT, 'node_modules'))) {
      if (e !== '@vzn') await symlink(path.join(ROOT, 'node_modules', e), path.join(nm, e))
    }
    await symlink(path.join(ROOT, 'node_modules/@vzn/vx'), path.join(nm, '@vzn/vx'), 'dir')
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
          // Straight to each package's source through the site's own
          // node_modules, which the sandbox grants (plugins-guide-snippets).
          paths: Object.fromEntries(
            TYPED.map((pkg) => [
              `@vzn/${pkg}`,
              [path.join(SITE, 'node_modules', '@vzn', pkg, 'src', 'index.ts')],
            ]),
          ),
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
    // the symlinked node_modules until the kernel kills it. `unix` prints
    // one `file:line:col: … [Error/…]` line per problem; the default
    // report's shape follows the terminal, and the sandbox's differs.
    const p = Bun.spawnSync({
      cmd: [OXLINT, '--type-aware', '--type-check', '--format=unix', ...files],
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
    const lines = out.split('\n').filter((l) => /\[Error\//.test(l))
    const of = (where: string): string => `${where.replace(/[/.]/g, '-')}.ts:`
    const errors = lines.filter((l) => !Object.keys(RECORDS).some((w) => l.includes(of(w))))
    // An excuse is dropped once its block type-checks.
    const unused = Object.keys(RECORDS).filter((w) => !lines.some((l) => l.includes(of(w))))
    // A failure that printed no error line (a crash) shows its output.
    const tail = p.exitCode !== 0 && lines.length === 0 ? out.trim().split('\n').slice(-15) : []
    expect({ errors, unused, tail }).toEqual({ errors: [], unused: [], tail: [] })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 120_000)
