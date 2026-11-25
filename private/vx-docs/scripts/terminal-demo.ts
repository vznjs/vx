#!/usr/bin/env bun
// The terminal demo on the README: the docs' one workspace (packages/ui, a
// Vite library, used by packages/web, a Vite app) built with real `vite
// build` under this checkout's vx, cold then warm, its real colored output
// drawn as an SVG that prints line by line. Nothing in the picture is typed by hand;
// `--check` re-runs it and fails when anything but a timing, the worker
// count or the run id differs from the committed file (core's tests/examples.unsafe.test.ts
// runs the check, the suite that may read examples/ and spawn git).
//
//   bun private/vx-docs/scripts/terminal-demo.ts          # rewrite public/demo.svg
//   bun private/vx-docs/scripts/terminal-demo.ts --check  # exit 1 if it drifted

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SITE = path.resolve(import.meta.dir, '..')
// vx and its lockfile plugin, as this project installed them.
const VZN = path.join(SITE, 'node_modules/@vzn')
const OUT = path.join(SITE, 'public/demo.svg')
const COMMAND = 'vx run build --all'

/** One styled run of text. */
type Span = { text: string; fg?: string; bold?: boolean; dim?: boolean }

// An SGR sequence: ESC [ codes m.
const SGR = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`, 'g')

/** SGR codes vx prints: reset, bold, dim, normal intensity, default fg, 24-bit fg. */
function parseAnsi(line: string): Span[] {
  const spans: Span[] = []
  let state: Omit<Span, 'text'> = {}
  let at = 0
  for (const m of line.matchAll(SGR)) {
    if (m.index > at) spans.push({ text: line.slice(at, m.index), ...state })
    at = m.index + m[0].length
    const codes = (m[1] || '0').split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!
      if (c === 0) state = {}
      else if (c === 1) state = { ...state, bold: true }
      else if (c === 2) state = { ...state, dim: true }
      else if (c === 22) state = { ...state, bold: false, dim: false }
      else if (c === 39) {
        const { fg: _, ...rest } = state
        state = rest
      } else if (c === 38 && codes[i + 1] === 2) {
        const [r, g, b] = codes.slice(i + 2, i + 5)
        state = { ...state, fg: `rgb(${r},${g},${b})` }
        i += 4
      }
    }
  }
  if (at < line.length) spans.push({ text: line.slice(at), ...state })
  return spans.filter((s) => s.text.length > 0)
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Lines appear one after another, as a terminal prints them. Each line is
// hidden only until its delay (`backwards` fill), so a renderer that runs
// no animation, or asks for reduced motion, shows the whole picture.
const STEP = 0.12
// The pause after a typed command, before its output starts.
const RUN = 0.6

function render(lines: Span[][]): string {
  const lineH = 19
  const top = 44
  // 13px monospace is 0.6em a cell: the widest line, plus the margins.
  const cells = Math.max(...lines.map((l) => Bun.stringWidth(l.map((s) => s.text).join(''))))
  const W = Math.ceil(cells * 7.8) + 36
  const H = top + lines.length * lineH + 14
  let at = 0
  const body = lines
    .map((spans, i) => {
      const delay = at
      at += spans[0]?.text === '$ ' ? RUN : STEP
      const tspans = spans
        .map((s) => {
          const attrs = [
            s.fg ? `fill="${s.fg}"` : '',
            s.bold ? 'font-weight="700"' : '',
            s.dim ? 'opacity="0.55"' : '',
          ]
            .filter(Boolean)
            .join(' ')
          return attrs ? `<tspan ${attrs}>${esc(s.text)}</tspan>` : esc(s.text)
        })
        .join('')
      return `  <text x="18" y="${top + i * lineH}" style="animation-delay:${delay.toFixed(2)}s">${tspans}</text>`
    })
    .join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="vx run build --all, first: @demo/ui#build then @demo/web#build run; again: both up to date.">
  <style>
    text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; font-size: 13px; fill: #e6edf3; white-space: pre; animation: hide 0.01s backwards; }
    @keyframes hide { from, to { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { text { animation: none; } }
  </style>
  <rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
  <circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>
${body}
</svg>
`
}

/**
 * What `--check` compares: the text and its styling, never a duration, a
 * row's cpu or memory, the core count or the run id.
 */
export function normalize(svg: string): string {
  return (
    svg
      .replace(/height="\d+"|viewBox="[^"]*"|y="\d+"|style="animation-delay:[^"]*"/g, '')
      .replace(/\d+(\.\d+)?(ms|s)\b/g, 'N')
      // How far a row ran from its usual time is a timing, its sign and
      // colour with it.
      .replace(/<tspan[^>]*>[+\u2212]N<\/tspan>/g, '±N')
      // A row's cpu and peak memory are measured, as a duration is.
      .replace(/\d+%/g, 'N%')
      .replace(/\d+(\.\d+)?(B|KB|MB|GB)\b/g, 'N B')
      .replace(/\d+ workers?\b/g, 'N workers')
      .replace(/run [0-9a-f]{8}-[0-9a-f-]+/g, 'run ID')
      // The footer drops a spread value equal to one already on the row, so
      // which of max/avg/min print is a timing too.
      .replace(
        / <tspan opacity="[\d.]+">·<\/tspan> <tspan opacity="[\d.]+">(?:max|avg|min) N<\/tspan>/g,
        '',
      )
      .replace(/ +/g, ' ')
  )
}

const PROJECT = `import type { ProjectConfig } from '@vzn/vx/config'

export default {
  tasks: {
    build: {
      dependsOn: ['^build'],
      exec: { command: 'vite build' },
      inputs: { files: ['src/**', 'index.html', 'vite.config.ts'] },
      outputs: { files: ['dist/**'] },
      cache: true,
    },
  },
} satisfies ProjectConfig
`

/** The docs' demo workspace, file by file. */
const FILES: Record<string, string> = {
  'package.json': '{ "name": "demo", "private": true, "workspaces": ["packages/*"] }\n',
  '.gitignore': 'node_modules\ndist\n',
  '.vx/workspace.ts': `import type { WorkspaceConfig } from '@vzn/vx/config'
import { bun } from '@vzn/vx-lockfile'

export default { plugins: [bun()] } satisfies WorkspaceConfig
`,
  'packages/ui/package.json':
    '{ "name": "@demo/ui", "version": "1.0.0", "type": "module", "exports": "./dist/index.js" }\n',
  'packages/ui/vite.config.ts': `import { defineConfig } from 'vite'

export default defineConfig({
  build: { lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'index' } },
})
`,
  'packages/ui/src/index.ts': `export function button(label: string): string {
  return \`<button>\${label}</button>\`
}
`,
  'packages/ui/vx.config.ts': PROJECT,
  'packages/web/package.json':
    '{ "name": "@demo/web", "version": "1.0.0", "type": "module", "dependencies": { "@demo/ui": "workspace:*" } }\n',
  'packages/web/vite.config.ts': `import { defineConfig } from 'vite'

export default defineConfig({})
`,
  'packages/web/index.html':
    '<!doctype html>\n<div id="app"></div>\n<script type="module" src="/src/index.ts"></script>\n',
  'packages/web/src/index.ts': `import { button } from '@demo/ui'

document.querySelector('#app')!.innerHTML = button('Hello')
`,
  'packages/web/vx.config.ts': PROJECT,
  // The workspace links \`bun install\` records, which bun() reads its edges from.
  'bun.lock': JSON.stringify({
    lockfileVersion: 1,
    workspaces: {
      '': { name: 'demo' },
      'packages/ui': { name: '@demo/ui', version: '1.0.0' },
      'packages/web': {
        name: '@demo/web',
        version: '1.0.0',
        dependencies: { '@demo/ui': 'workspace:*' },
      },
    },
    packages: {
      '@demo/ui': ['@demo/ui@workspace:packages/ui'],
      '@demo/web': ['@demo/web@workspace:packages/web'],
    },
  }),
}

/** The vite the site builds with: astro's, so the demo adds no dependency. */
function vite(): string {
  const astro = path.dirname(Bun.resolveSync('astro/package.json', SITE))
  return path.dirname(Bun.resolveSync('vite/package.json', astro))
}

function run(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-demo-')))
  // Its own home: the shared store is `~/.vx/<repo id>`, and an earlier
  // demo's commit can carry the same id, so its cold run would hit.
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-demo-home-')))
  try {
    for (const [file, text] of Object.entries(FILES)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), text)
    }
    const modules = path.join(root, 'node_modules')
    mkdirSync(path.join(modules, '@vzn'), { recursive: true })
    mkdirSync(path.join(modules, '@demo'), { recursive: true })
    mkdirSync(path.join(modules, '.bin'), { recursive: true })
    symlinkSync(realpathSync(path.join(VZN, 'vx')), path.join(modules, '@vzn/vx'))
    symlinkSync(realpathSync(path.join(VZN, 'vx-lockfile')), path.join(modules, '@vzn/vx-lockfile'))
    symlinkSync(path.join(root, 'packages/ui'), path.join(modules, '@demo/ui'))
    symlinkSync(path.join(root, 'packages/web'), path.join(modules, '@demo/web'))
    symlinkSync(vite(), path.join(modules, 'vite'))
    symlinkSync('../vite/bin/vite.js', path.join(modules, '.bin/vite'))
    // And the README's `vx lock` after it: a run keys from what it records.
    const lock = Bun.spawnSync({
      cmd: [process.execPath, path.join(VZN, 'vx/src/bin.ts'), 'lock'],
      cwd: root,
      env: { ...process.env, HOME: home },
    })
    if (lock.exitCode !== 0) throw new Error(`vx lock: ${lock.stderr.toString()}`)
    for (const args of [
      ['init', '-q'],
      ['add', '-A'],
      ['commit', '-qm', 'init'],
    ]) {
      const g = Bun.spawnSync({
        cmd: ['git', '-c', 'user.email=demo@vx', '-c', 'user.name=demo', ...args],
        cwd: root,
      })
      if (g.exitCode !== 0) throw new Error(`git ${args[0]}: ${g.stderr.toString()}`)
    }
    const lines: Span[][] = []
    // An unshown run first, saving nothing: its timings are the history the
    // shown rows' `usual` reads, as on any repo vx has run in before. The
    // demo's cold run still misses.
    const history = Bun.spawnSync({
      cmd: [
        process.execPath,
        path.join(VZN, 'vx/src/bin.ts'),
        'run',
        'build',
        '--all',
        '--no-cache',
      ],
      cwd: root,
      env: { ...process.env, HOME: home, CI: undefined },
    })
    if (history.exitCode !== 0) throw new Error(`history run failed: ${history.stderr.toString()}`)
    for (const pass of ['cold', 'warm']) {
      const r = Bun.spawnSync({
        cmd: [process.execPath, path.join(VZN, 'vx/src/bin.ts'), 'run', 'build', '--all'],
        cwd: root,
        env: { ...process.env, HOME: home, FORCE_COLOR: '1', NO_COLOR: undefined, CI: undefined },
      })
      if (r.exitCode !== 0) throw new Error(`${pass} run failed: ${r.stderr.toString()}`)
      // The source checkout reports version 0.0.0; the rule keeps its width.
      const out = (r.stdout.toString() + r.stderr.toString()).replace('vx 0.0.0', 'vx ─────')
      if (lines.length > 0) lines.push([])
      lines.push([
        { text: '$ ', fg: 'rgb(125,133,144)' },
        { text: COMMAND, bold: true },
      ])
      for (const l of out.replace(/^\n+|\n+$/g, '').split('\n')) lines.push(parseAnsi(l))
    }
    return render(lines)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const svg = run()
  if (process.argv.includes('--check')) {
    const committed = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
    if (normalize(committed) !== normalize(svg)) {
      process.stderr.write(
        'terminal-demo.ts --check: public/demo.svg no longer matches a real run; regenerate it\n',
      )
      process.exit(1)
    }
    process.stdout.write('demo.svg matches a real run\n')
  } else {
    writeFileSync(OUT, svg)
    process.stdout.write('public/demo.svg rewritten\n')
  }
}
