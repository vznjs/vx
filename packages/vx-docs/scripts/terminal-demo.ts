#!/usr/bin/env bun
// The terminal demo on the README and the landing: examples/basic run under
// this checkout's vx, cold then warm, its real colored output drawn as an
// SVG. Nothing in the picture is typed by hand; `--check` re-runs it and
// fails when anything but a timing or the worker count differs from the
// committed file (core's tests/examples.unsafe.test.ts runs the check, the
// suite that may read examples/ and spawn git).
//
//   bun packages/vx-docs/scripts/terminal-demo.ts          # rewrite public/demo.svg
//   bun packages/vx-docs/scripts/terminal-demo.ts --check  # exit 1 if it drifted

import {
  cpSync,
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

const ROOT = path.resolve(import.meta.dir, '../../..')
const OUT = path.join(ROOT, 'packages/vx-docs/public/demo.svg')
const COMMAND = 'vx run ci --all'

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

function render(lines: Span[][]): string {
  const lineH = 19
  const top = 44
  const W = 760
  const H = top + lines.length * lineH + 14
  const body = lines
    .map((spans, i) => {
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
      return `  <text x="18" y="${top + i * lineH}">${tspans}</text>`
    })
    .join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="vx run ci --all, cold: three tasks run; again: three up-to-date.">
  <style>
    text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; font-size: 13px; fill: #e6edf3; white-space: pre; }
  </style>
  <rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
  <circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>
${body}
</svg>
`
}

/** What `--check` compares: the text and its styling, never a duration or the core count. */
function normalize(svg: string): string {
  return svg
    .replace(/height="\d+"|viewBox="[^"]*"|y="\d+"/g, '')
    .replace(/\d+(\.\d+)?(ms|s)\b/g, 'N')
    .replace(/\d+ workers/g, 'N workers')
    .replace(/ +/g, ' ')
}

function run(): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-demo-')))
  try {
    cpSync(path.join(ROOT, 'examples/basic'), root, { recursive: true })
    mkdirSync(path.join(root, 'node_modules/@vzn'), { recursive: true })
    symlinkSync(path.join(ROOT, 'packages/vx'), path.join(root, 'node_modules/@vzn/vx'))
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
    for (const pass of ['cold', 'warm']) {
      const r = Bun.spawnSync({
        cmd: [process.execPath, path.join(ROOT, 'packages/vx/src/bin.ts'), 'run', 'ci', '--all'],
        cwd: root,
        env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: undefined, CI: undefined },
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
