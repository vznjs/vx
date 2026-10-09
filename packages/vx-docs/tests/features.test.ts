// The feature pages (src/features/features.ts → src/pages/features/): the
// data's copy rules and its commands against core's own CLI, the config
// examples type-checked against the packages they import, and the built hub
// and pages against the data.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { acceptedFlags, CORE_VERBS } from '../../vx/src/cli/help.js'
import { translateForeign } from '../../vx/src/cli/foreign-flags.js'
import { CATEGORIES, FEATURES } from '../src/features/features.js'

const SITE = path.resolve(import.meta.dir, '..')
const ROOT = path.resolve(SITE, '../..')
const DIST = path.join(SITE, 'dist')
const ASSETS = path.join(SITE, 'src/assets/features')
const BASE = (process.env['BASE_PATH'] ?? '/vx').replace(/\/?$/, '/')
const PLUGIN_VERBS = ['mcp']

/** Every piece of copy a feature shows. */
const copy = (f: (typeof FEATURES)[number]): string[] => [f.title, f.hook, ...f.body, f.imageAlt]

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('the feature data', () => {
  it('has a unique slug per feature, every category used, in category order', () => {
    const slugs = FEATURES.map((f) => f.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(slugs.filter((s) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s))).toEqual([])
    expect(FEATURES.length).toBeGreaterThanOrEqual(30)
    const order = CATEGORIES.map((c) => c.id)
    const seen = FEATURES.map((f) => order.indexOf(f.category))
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(order.filter((c) => !FEATURES.some((f) => f.category === c))).toEqual([])
  })

  it('gives each a one-sentence hook, two to four paragraphs, an image on disk', () => {
    const bad: string[] = []
    for (const f of FEATURES) {
      if ((f.hook.match(/[.?](?:\s|$)/g) ?? []).length > 1) bad.push(`${f.slug}: hook`)
      if (f.body.length < 2 || f.body.length > 4) bad.push(`${f.slug}: ${f.body.length} paragraphs`)
      if (!existsSync(path.join(ASSETS, f.image))) bad.push(`${f.slug}: no ${f.image}`)
    }
    expect(bad).toEqual([])
    const used = new Set(FEATURES.map((f) => f.image))
    expect(readdirSync(ASSETS).filter((f) => !used.has(f))).toEqual([])
  })

  // The site's copy rules: plain words, speed as "N× faster", and Turbo or
  // Nx only as the origin of a migration.
  it('says nothing loud, no percentage, no “unchanged” Turbo or Nx repo', () => {
    const bad: string[] = []
    for (const f of FEATURES) {
      for (const s of copy(f)) {
        if (/!/.test(s)) bad.push(`${f.slug}: "!" in ${s}`)
        if (/\d\s?%(?!\w)/.test(s) && !s.includes('--concurrency 50%'))
          bad.push(`${f.slug}: a percentage in ${s}`)
        if (/\b(?:blazing|lightning|magic|seamless|revolutionary|game-?changing)/i.test(s))
          bad.push(`${f.slug}: ${s}`)
        if (/unchanged/i.test(s)) bad.push(`${f.slug}: "unchanged" in ${s}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('links docs under the base, and only https outside it', () => {
    const bad = FEATURES.flatMap((f) =>
      [f.docs, ...(f.deepDive ? [f.deepDive] : [])]
        .filter(
          (l) =>
            l.href.startsWith('/') || /^[a-z]+:/.test(l.href) !== l.href.startsWith('https://'),
        )
        .map((l) => `${f.slug}: ${l.href}`),
    )
    expect(bad).toEqual([])
    expect(FEATURES.filter((f) => /^https?:/.test(f.docs.href)).map((f) => f.slug)).toEqual([])
  })

  it('scopes retained benchmark claims without renaming the fastest route', () => {
    const feature = FEATURES.find((f) => f.slug === 'fastest')!
    expect(feature.title).toBe('Measured scheduling trade-offs')
    expect(feature.hook).toBe(
      'Two synthetic workloads show different scheduling trade-offs, not a universal speed ranking.',
    )
    expect(CATEGORIES.find((c) => c.id === 'speed')!.line).toBe(
      'Runner costs and scheduling trade-offs on stated workloads.',
    )
    const claims = copy(feature).join(' ')
    expect(claims).not.toMatch(/\bfastest\b|less time added to every run|34× less/i)
    for (const scope of [
      '2026-10-04',
      'one repetition per runner/state',
      '2,180 executable tasks and 1,090 groups',
      '1.3555× end-to-end versus 34.609× excess',
      'scheduling delay and idle workers',
      '2026-10-08',
      'b8238866',
      'all five retained rounds',
      '1.492× end-to-end versus 117.321× baseline-subtracted excess',
      '86.29344×',
      'preliminary case',
      'not pooled',
      'unique transitive-dependent count',
      'These dated results do not predict the performance of later core changes',
    ])
      expect(claims).toContain(scope)
    expect(feature.docs.href).toBe('benchmarks/#synthetic-scheduling-counterexample')
    expect(feature.image).toBe('fastest.png')
  })

  it('qualifies the daemon state and CPU accounting behind the retained no-daemon quote', () => {
    const feature = FEATURES.find((f) => f.slug === 'no-daemon')!
    const claims = copy(feature).join(' ')
    expect(claims).toContain('2026-10-04')
    expect(claims).toContain('393 ms versus Nx’s 6.45 s')
    expect(claims).toContain('one repetition per runner/state')
    expect(claims).toContain('`CI=1` turns Nx’s daemon off')
    expect(claims).toContain('does not measure Nx’s daemon-on developer path')
    expect(claims).toContain(
      'waited-for descendants, including task shells, but not detached daemons',
    )
    expect(feature.docs.href).toBe('benchmarks/#synthetic-scheduling-counterexample')
  })

  it('describes duration-aware ordering as an optional policy, not the core default', () => {
    const feature = FEATURES.find((f) => f.slug === 'critical-path')!
    const claims = copy(feature).join(' ')
    expect(claims).toContain('When explicitly declared')
    expect(claims).toContain('Default core instead counts unique transitive dependents')
    expect(claims).toContain('Neither policy guarantees the shortest schedule')
  })

  it('keeps the reproducible benchmark image scoped and at the existing dimensions', () => {
    const svg = readFileSync(path.join(SITE, 'src/features/fastest.svg'), 'utf8')
    expect(svg).toContain('Measured scheduling')
    expect(svg).toContain('Retained synthetic layered run: 2026-10-04')
    expect(svg).toContain('BASELINE-SUBTRACTED EXCESS')
    expect(svg).toContain('/benchmarks/#synthetic-scheduling-counterexample')
    expect(svg).not.toMatch(/fastest task runner|less overhead on a cold build/i)
    const png = readFileSync(path.join(ASSETS, 'fastest.png'))
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1600, 900])
  })

  it('keeps the shared cover footer neutral and contextualizes the other timing illustrations', () => {
    const sources = path.join(SITE, 'scripts/feature-covers')
    const footer = readFileSync(path.join(sources, 'footer.svg'), 'utf8')
    expect(footer).toContain('A task runner and build cache for JS monorepos.')
    expect(footer).not.toMatch(/fastest|less time added/i)
    const daemon = readFileSync(path.join(sources, 'no-daemon.svg'), 'utf8')
    expect(daemon).toContain('2026-10-04')
    expect(daemon).toContain('one repetition')
    expect(daemon).toContain('393 ms')
    expect(daemon).toContain('6.45 s')
    expect(daemon).toContain('463 ms')
    expect(daemon).toContain("Nx's daemon was off under CI=1")
    expect(daemon).toContain('detached daemons are excluded')
    const history = readFileSync(path.join(sources, 'critical-path.svg'), 'utf8')
    expect(history).toContain('OPT-IN')
    expect(history).toContain('Core default: unique transitive-dependent count')
    expect(history).toContain('WALL 100%')
    expect(history).toContain('WALL 60%')
    expect(history).toContain('not measured CLI timings')
    const watch = readFileSync(path.join(sources, 'watch-context.svg'), 'utf8')
    expect(watch).toContain('not a general guarantee')
    const quickstart = readFileSync(path.join(sources, 'quickstart-context.svg'), 'utf8')
    expect(quickstart).toContain('No general timing guarantee')
    for (const svg of [daemon, history, watch, quickstart]) {
      expect(svg).toContain('/benchmarks/#synthetic-scheduling-counterexample')
      expect(svg).not.toMatch(/still fastest|fastest task runner/i)
    }
    expect(FEATURES.find((f) => f.slug === 'keys-from-git')!.body.join(' ')).toContain(
      'not a bound on end-to-end latency',
    )
    expect(FEATURES.find((f) => f.slug === 'quickstart')!.body.join(' ')).toContain(
      'whole-run time depends on the graph, cache state and machine',
    )
    for (const file of new Set(FEATURES.map((f) => f.image))) {
      const png = readFileSync(path.join(ASSETS, file))
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1600, 900])
    }
  })

  // Every `vx <verb> …` a page shows is a verb vx has, with flags it takes:
  // core's help text decides, after the Turbo and Nx aliases are rewritten.
  it('shows only verbs and flags core accepts', () => {
    const bad: string[] = []
    let seen = 0
    for (const f of FEATURES) {
      if (f.example.lang !== 'sh') continue
      for (const raw of f.example.code.split('\n')) {
        const line = raw
          .replace(/\s+#.*$/, '')
          .replace(/\)"$/, '')
          .replace(/\s>\s.*$/, '')
        const m = /(?:^|\s|\$\()(?:npx )?vx ([a-z]+)(.*)$/.exec(line)
        if (m === null) continue
        seen++
        const verb = m[1]!
        if (!CORE_VERBS.includes(verb as never) && !PLUGIN_VERBS.includes(verb)) {
          bad.push(`${f.slug}: vx ${verb}`)
          continue
        }
        let args = m[2]!.trim().split(/\s+/).filter(Boolean)
        if (verb === 'run' || verb === 'watch') {
          const t = translateForeign(args)
          if (!Array.isArray(t)) {
            bad.push(`${f.slug}: ${t.error}`)
            continue
          }
          args = t
        }
        const flags = acceptedFlags(verb)
        for (const a of args.filter((a) => a.startsWith('-')))
          if (!flags.includes(a.split('=')[0]!)) bad.push(`${f.slug}: vx ${verb} ${a}`)
      }
    }
    expect(bad).toEqual([])
    expect(seen).toBeGreaterThan(25)
  })

  it('names only environment variables core reads', () => {
    const src = readdirSync(path.join(ROOT, 'packages/vx/src'), {
      recursive: true,
      encoding: 'utf8',
    })
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(path.join(ROOT, 'packages/vx/src', f), 'utf8'))
      .join('\n')
    const names = new Set(
      FEATURES.flatMap((f) => [
        ...`${f.example.code} ${f.body.join(' ')}`.matchAll(/\bVX_[A-Z_]+/g),
      ]).map((m) => m[0]),
    )
    expect(names.size).toBeGreaterThan(0)
    // `process.env['VX_X']` or `process.env.VX_X`: a read, not a mention.
    expect(
      [...names].filter((n) => !src.includes(`env['${n}']`) && !src.includes(`env.${n} `)),
    ).toEqual([])
  })

  // A config example is code a reader pastes: it type-checks against the
  // packages it imports, the schema from `@vzn/vx/config`.
  it('every config example type-checks', async () => {
    const blocks = FEATURES.filter((f) => f.example.lang === 'ts').map((f) => f.example.code)
    expect(blocks.length).toBeGreaterThan(8)
    for (const b of blocks) {
      if (/\bdefine(?:Project|Workspace)\b/.test(b))
        expect(b).toMatch(/^import \{ define(?:Project|Workspace) \} from '@vzn\/vx\/config'$/m)
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-feature-examples-'))
    try {
      await symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
      const plugins = [
        'vx-ci',
        'vx-lockfile',
        'vx-mcp',
        'vx-otel',
        'vx-reapi',
        'vx-schedule-history',
      ]
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
            // Through the site's own node_modules, where Bun links its
            // devDependencies and the sandbox grants them (see
            // plugins-guide-snippets.test.ts).
            paths: Object.fromEntries(
              plugins.map((pkg) => [
                `@vzn/${pkg}`,
                [path.join(SITE, 'node_modules', '@vzn', pkg, 'src', 'index.ts')],
              ]),
            ),
          },
          include: ['*.ts', '*.d.ts'],
        }),
      )
      // The preset a config imports is the reader's own.
      await writeFile(
        path.join(dir, 'ambient.d.ts'),
        "declare module '@acme/vx-presets' {\n  export function viteBuild(o: { outDir: string }): { exec: { command: string } }\n}\n",
      )
      const files: string[] = []
      for (const [i, block] of blocks.entries()) {
        const file = path.join(dir, `example-${String(i).padStart(2, '0')}.ts`)
        await writeFile(file, block)
        files.push(file)
      }
      const p = Bun.spawnSync({
        cmd: [
          path.join(ROOT, 'node_modules/.bin/oxlint'),
          '--type-aware',
          '--type-check',
          ...files,
        ],
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
  }, 60_000)
})

describe('the built feature pages', () => {
  const page = (rel: string): string => readFileSync(path.join(DIST, rel, 'index.html'), 'utf8')

  it('the hub lists every feature under its category, in order', () => {
    const hub = page('features/')
    const sections = [...hub.matchAll(/<section class="fcat" id="([a-z]+)">([\s\S]*?)<\/section>/g)]
    expect(sections.map((m) => m[1])).toEqual(CATEGORIES.map((c) => c.id))
    for (const [, id, body] of sections) {
      const links = [...body!.matchAll(/<a class="fcard" href="([^"]+)"/g)].map((m) => m[1])
      expect(links).toEqual(
        FEATURES.filter((f) => f.category === id).map((f) => `${BASE}features/${f.slug}/`),
      )
    }
  })

  it('each page shows its title, hook, docs link, and the rest of its category', () => {
    const bad: string[] = []
    for (const f of FEATURES) {
      const html = page(`features/${f.slug}/`)
      const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => text(m[1]!))
      if (JSON.stringify(h1) !== JSON.stringify([f.title]))
        bad.push(`${f.slug}: h1 ${JSON.stringify(h1)}`)
      const lede = /<p class="lede"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1]
      if (lede === undefined || text(lede) !== f.hook.replace(/`/g, '')) bad.push(`${f.slug}: lede`)
      const docs = f.docs.href.startsWith('https://') ? f.docs.href : `${BASE}${f.docs.href}`
      if (!html.includes(`href="${docs}"`)) bad.push(`${f.slug}: no docs link`)
      const more = /<section class="fmore">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? ''
      const cards = [...more.matchAll(/<a class="fcard" href="([^"]+)"/g)].map((m) => m[1])
      const want = FEATURES.filter((x) => x.category === f.category && x !== f).map(
        (x) => `${BASE}features/${x.slug}/`,
      )
      if (JSON.stringify(cards) !== JSON.stringify(want))
        bad.push(`${f.slug}: more ${JSON.stringify(cards)}`)
    }
    expect(bad).toEqual([])
  })

  // The sources are 1600×900 PNGs; a page ships resized WebP only.
  it('ships every feature image as resized WebP, never the source PNG', () => {
    const rels = ['', 'features/', ...FEATURES.map((f) => `features/${f.slug}/`)]
    const bad: string[] = []
    let imgs = 0
    for (const rel of rels) {
      for (const m of page(rel).matchAll(/<img\b[^>]*>/g)) {
        const tag = m[0]
        const src = /\ssrc="([^"]+)"/.exec(tag)?.[1] ?? ''
        if (!src.includes('/_astro/')) continue
        imgs++
        const srcset = /\ssrcset="([^"]+)"/.exec(tag)?.[1] ?? ''
        const urls = [src, ...srcset.split(',').map((s) => s.trim().split(' ')[0]!)]
        if (urls.some((u) => !u.endsWith('.webp'))) bad.push(`${rel}: ${src}`)
        if (!/\ssizes="[^"]+"/.test(tag)) bad.push(`${rel}: no sizes on ${src}`)
      }
    }
    expect(bad).toEqual([])
    expect(imgs).toBeGreaterThan(FEATURES.length * 2)
    const names = new Set(FEATURES.map((f) => f.image.replace(/\.png$/, '')))
    const pngs = readdirSync(path.join(DIST, '_astro')).filter(
      (f) => f.endsWith('.png') && names.has(f.split('.')[0]!),
    )
    expect(pngs).toEqual([])
  })
})
