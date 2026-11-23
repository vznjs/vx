// The glob tester's model (src/components/play/model/glob-tester.ts): its
// matcher agrees with Bun.Glob, and it takes the files vx takes for a task's
// inputs and outputs on the story workspace.

import { describe, expect, it } from 'bun:test'
import {
  asTrees,
  compileGlob,
  outputRequired,
  parsePatterns,
  render,
  resolveInputs,
  resolveOutputs,
  buildWrites,
} from '../src/components/play/model/glob-tester.js'

const PATTERNS = [
  '*',
  '**',
  '*.ts',
  '**/*.ts',
  '**/*.{ts,tsx}',
  '{src,lib}/**',
  'src/**',
  'src/*',
  'src/**/*.tsx',
  'src/*.test.tsx',
  '**/*.test.*',
  'a/**/b',
  '**/b',
  '?.ts',
  'src/?pp.tsx',
  '[ab].ts',
  '[a-c]*.ts',
  'src/[A-Z]*.tsx',
  '.env*',
  '*.{json,md}',
  'dist/**/*.js',
  'dist/assets/*',
  'src/**/x/*.ts',
  '{src/a,lib/b}.ts',
  'src/{App,main}.*',
  'index.html',
  'src/App.tsx',
  '*/*',
  '**/*',
]

const PATHS = [
  'a.ts',
  'b.ts',
  'c.ts',
  'd.ts',
  '.env',
  '.env.local',
  'index.html',
  'package.json',
  'README.md',
  'src',
  'src/App.tsx',
  'src/App.test.tsx',
  'src/main.ts',
  'src/.hidden',
  'src/a.ts',
  'src/deep/x/y.ts',
  'src/x/y.ts',
  'lib/b.ts',
  'lib/deep/a.ts',
  'a/b',
  'a/x/y/b',
  'b',
  'dist/index.html',
  'dist/assets/index-7C0y1bbr.js',
  'dist/assets/deep/x.js',
  'x/y/z.tsx',
]

describe('the matcher', () => {
  it('agrees with Bun.Glob on every pattern and path', () => {
    const disagree: string[] = []
    for (const p of PATTERNS) {
      const bun = new Bun.Glob(p)
      const ours = compileGlob(p)
      for (const path of PATHS)
        if (bun.match(path) !== ours(path)) disagree.push(`${p} ~ ${path}: bun ${bun.match(path)}`)
    }
    expect(disagree).toEqual([])
  })

  it('never lets a negated class take a slash (util/paths.ts rewriteGlob)', () => {
    expect(compileGlob('a[!x]b')('a/b')).toBe(false)
    expect(compileGlob('a[!x]b')('ayb')).toBe(true)
  })

  it('reads a literal as the path and its whole tree', () => {
    expect(asTrees(['dist'])).toEqual(['dist', 'dist/**'])
    expect(asTrees(['./src/'])).toEqual(['src', 'src/**'])
    expect(asTrees(['src/**'])).toEqual(['src/**'])
  })

  it('reads one entry per line, quotes and commas pasted from a config dropped', () => {
    expect(parsePatterns('  \'src/**\',\n\n"index.html"\n!src/**/*.test.tsx ')).toEqual([
      'src/**',
      'index.html',
      '!src/**/*.test.tsx',
    ])
  })
})

describe('inputs', () => {
  const web = (...entries: string[]) => resolveInputs('@demo/web', entries)

  it('takes the default globs: src and index.html', () => {
    expect(web('src/**', 'index.html').files).toEqual([
      'index.html',
      'src/App.test.tsx',
      'src/App.tsx',
      'src/main.ts',
      'src/styles.css',
    ])
  })

  it('leaves out what a ! entry names', () => {
    const r = web('src/**', '!src/**/*.test.tsx')
    expect(r.files).not.toContain('src/App.test.tsx')
    expect(r.patterns[1]).toMatchObject({ kind: 'leave-out', files: ['src/App.test.tsx'] })
  })

  it('never reaches gitignored files through a broad glob, and names a skipped file', () => {
    const r = web('**')
    expect(r.files).not.toContain('.env')
    expect(r.files.some((f) => f.startsWith('node_modules/'))).toBe(false)
    expect(r.patterns[0]!.ignoredLeftOut).toEqual(['.env'])
  })

  it('takes a gitignored file named outright', () => {
    const r = web('src/**', '.env')
    expect(r.files).toContain('.env')
    expect(r.patterns[1]!.ignoredReached).toEqual(['.env'])
  })

  it("never takes the task's own outputs, even named outright", () => {
    const r = web('dist/**', 'dist')
    expect(r.files).toEqual([])
    expect(r.patterns[0]!.ownOutputs).toContain('dist/index.html')
  })

  it('walks an ignored directory a glob is rooted in', () => {
    const r = resolveInputs('@demo/web', ['node_modules/**'], [])
    expect(r.files).toEqual(['node_modules/vite/package.json'])
  })

  it('reads a bare directory name as its tree', () => {
    expect(web('src').files).toHaveLength(4)
  })

  it('refuses a glob that leaves the project', () => {
    const r = web('../ui/src/**')
    expect(r.refused).toBe(true)
    expect(r.files).toEqual([])
    expect(r.patterns[0]!.refusal).toContain("'..' path segments are not allowed")
  })

  it('refuses a glob naming the project directory itself', () => {
    expect(web('./').patterns[0]!.refusal).toContain('names the project directory itself')
  })

  it('never takes another project’s files: globs are project-relative', () => {
    expect(resolveInputs('@demo/ui', ['**']).files.every((f) => !f.includes('App'))).toBe(true)
  })

  it('says when nothing matched, with the line vx prints', () => {
    const v = render({
      mode: 'inputs',
      project: '@demo/web',
      entries: ['lib/**'],
      written: new Set(),
    })
    expect(v.terminal).toContain('inputs matched no files (lib/**)')
  })
})

describe('outputs', () => {
  const all = new Set(buildWrites('@demo/web'))
  const none = new Set<string>()

  it('requires a literal, lets a wildcard match nothing (decided 2026-11-23)', () => {
    expect(outputRequired('dist')).toBe(true)
    expect(outputRequired('dist/index.js')).toBe(true)
    expect(outputRequired('./dist/')).toBe(true)
    expect(outputRequired('dist/**')).toBe(false)
    expect(outputRequired('.next/**')).toBe(false)
    expect(outputRequired('dist/*.{js,css}')).toBe(false)
  })

  it('saves what the build wrote', () => {
    const r = resolveOutputs('@demo/web', ['dist/**'], all)
    expect(r.failed).toBe(false)
    expect(r.saved).toEqual(['dist/assets/index-7C0y1bbr.js', 'dist/index.html'])
  })

  it('fails a lone wildcard that matched nothing: outputs need one file', () => {
    const r = resolveOutputs('@demo/web', ['dist/**'], none)
    expect(r.failed).toBe(true)
    expect(r.missing).toEqual(['dist/**'])
    expect(r.patterns[0]!.kind).toBe('missing')
  })

  it('passes an empty wildcard beside a literal that was found', () => {
    const r = resolveOutputs('@demo/web', ['dist/**', 'package.json'], none)
    expect(r.failed).toBe(false)
    expect(r.patterns.map((p) => p.kind)).toEqual(['optional', 'found'])
  })

  it('passes two wildcards when one is empty', () => {
    const r = resolveOutputs('@demo/web', ['dist/**', '.vite/**'], all)
    expect(r.failed).toBe(false)
    expect(r.patterns.map((p) => p.kind)).toEqual(['found', 'optional'])
  })

  it('names every entry, literals first, when nothing matched', () => {
    const r = resolveOutputs('@demo/web', ['dist/**', 'dist/index.js'], none)
    expect(r.missing).toEqual(['dist/index.js', 'dist/**'])
  })

  it('fails when a literal is missing, and saves nothing', () => {
    const r = resolveOutputs('@demo/web', ['dist/**', 'dist/index.js'], all)
    expect(r.failed).toBe(true)
    expect(r.missing).toEqual(['dist/index.js'])
    expect(r.saved).toEqual([])
    const v = render({
      mode: 'outputs',
      project: '@demo/web',
      entries: ['dist/index.js'],
      written: all,
    })
    expect(v.terminal).toContain(
      'outputs matched no files (dist/index.js) — the command exited 0 but never wrote it, so the task fails',
    )
    expect(v.terminal).toContain('failed (exited 0, no file matched dist/index.js)')
  })

  it('takes a literal directory as found once the build wrote into it', () => {
    expect(resolveOutputs('@demo/web', ['dist'], all).patterns[0]!.kind).toBe('found')
    expect(resolveOutputs('@demo/web', ['dist'], none).patterns[0]!.kind).toBe('missing')
  })

  it('keeps a ! entry out of the save', () => {
    const r = resolveOutputs('@demo/web', ['dist/**', '!dist/assets/**'], all)
    expect(r.saved).toEqual(['dist/index.html'])
  })

  it('leaves node_modules alone unless a glob names it', () => {
    expect(resolveOutputs('@demo/web', ['**/*.json'], all).saved).toEqual(['package.json'])
  })
})
