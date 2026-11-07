// The output components (org/devex/log-design.md): each one's layout with
// colors off, and the colors it owns with them on.
import { describe, expect, it } from 'bun:test'
import * as ui from '../src/ui/index.js'

const OFF = { enabled: false }
const ON = { enabled: true }
const plain = (...blocks: ui.Block[]): string => ui.render(blocks, OFF)

describe('ui components', () => {
  it('status: the tone symbol, the verb, two spaces, the headline', () => {
    expect(plain(ui.status('ok', 'vx lock', '2 project configs'))).toBe(
      '✓ vx lock  2 project configs\n',
    )
    expect(plain(ui.status('warn', 'sandbox', 'x'))).toBe('! sandbox  x\n')
    expect(plain(ui.status('info', 'vx why', 'x'))).toBe('› vx why  x\n')
    const painted = ui.render([ui.status('error', 'vx lock', 'no')], ON)
    expect(painted).toContain('\x1b[1mvx lock\x1b[0m')
    expect(painted).not.toBe('✗ vx lock  no\n')
  })

  it('notice: what and why under the status, then the frame, then the fix', () => {
    expect(
      plain(
        ui.notice({
          tone: 'error',
          verb: 'vx lock',
          headline: 'lock not written',
          what: ['a#build and a#types both write dist/**'],
          why: 'one deletes the other',
          code: '> 1 | x\n    | ^',
          fix: 'give each task its own output path',
        }),
      ),
    ).toBe(
      '✗ vx lock  lock not written\n\n' +
        '  a#build and a#types both write dist/**\n' +
        '  one deletes the other\n\n' +
        '  > 1 | x\n' +
        '      | ^\n\n' +
        '  fix  give each task its own output path\n',
    )
    expect(plain(ui.notice({ tone: 'info', verb: 'vx why', headline: 'no runs' }))).toBe(
      '› vx why  no runs\n',
    )
  })

  it('report: a blank line, the title line, aligned fields; next is bold', () => {
    const rows: ui.FieldRow[] = [
      ['from', 'turbo.json'],
      ['files', 'a/vx.config.ts', 'b/vx.config.ts'],
      null,
      ['next', 'vx run build --all'],
    ]
    expect(plain(ui.report('vx-migrate 1.2.3', rows))).toBe(
      '\n  vx-migrate 1.2.3\n' +
        '  from      turbo.json\n' +
        '  files     a/vx.config.ts\n' +
        '            b/vx.config.ts\n' +
        '\n' +
        '  next      vx run build --all\n',
    )
    const painted = ui.render([ui.report('vx', rows)], ON)
    // The label is meta (dim), the value a fact (slate-300), a level above it.
    expect(painted).toContain('\x1b[2mfrom    \x1b[0m  \x1b[38;2;203;213;225mturbo.json\x1b[0m')
    expect(painted).toContain('\x1b[1mvx run build --all\x1b[0m')
  })

  it('title line: the title in the gutter, a head past it, a note flush right; no rule', () => {
    const c = { enabled: false, columns: 40 }
    expect(ui.panelTop('Tasks', c, '3')).toBe('  Tasks 3')
    expect(ui.panelTop('Tasks', c, '3', 'done')).toBe(`  Tasks 3${' '.repeat(27)}done`)
    expect(ui.panelTop('Tasks', c, undefined, undefined, 'time')).toBe(
      `  Tasks${' '.repeat(ui.GUTTER - 7)}time`,
    )
    expect(ui.panelTop('Tasks', c, '3', 'done')).not.toContain('─')
    // Off colour with no width: the same words, trimmed.
    expect(ui.panelTop('Summary', OFF, '2', 'vx 1.0')).toMatch(/^ {2}Summary 2 +vx 1\.0$/)
    const on = ui.panelTop('Tasks', { enabled: true, columns: 40 }, '3', 'done')
    // Underlined end to end in the rule's grey (SGR 4 + 58), padded to the terminal width.
    expect(on.startsWith('\x1b[4m\x1b[58;2;')).toBe(true)
    expect(Bun.stringWidth(on)).toBe(40)
    expect(Bun.stripANSI(on)).toBe(`  Tasks 3${' '.repeat(27)}done`)
    expect(on).not.toContain('─')
    // Off colour and no terminal width, the line pads to 120 before the note.
    expect(ui.panelTop('Tasks', OFF, undefined, 'n')).toBe(`  Tasks${' '.repeat(112)}n`)
  })

  it('a label longer than the column widens it', () => {
    expect(
      plain(
        ui.fields([
          ['replaced', 'a'],
          ['installed', 'b'],
        ]),
      ),
    ).toBe('  replaced   a\n  installed  b\n')
  })

  it('table: dim header, columns padded by visible width', () => {
    expect(
      plain(
        ui.table(
          ['task', 'time'],
          [
            [ui.id('a#build'), '1s'],
            ['b#test', '12s'],
          ],
        ),
      ),
    ).toBe('  task     time\n  a#build  1s\n  b#test   12s\n')
    const painted = ui.render([ui.table(['task', 'time'], [[ui.id('a#build'), '1s']])], ON)
    expect(Bun.stripANSI(painted.split('\n')[1]!)).toBe('  a#build  1s')
  })

  it('inline tokens nest inside text, blocks print a blank line apart', () => {
    expect(
      plain(ui.text(['wrote ', ui.path('dist/**'), ' for ', ui.id('a#build')]), ui.fix('vx lock')),
    ).toBe('  wrote dist/** for a#build\n\n  fix  vx lock\n')
  })

  // A refusal quotes a path or a name, which is anyone's bytes: one named
  // `ESC ]0;…` retitled the terminal from a notice.
  it('writes a control byte in any text as \\xNN, a line break kept', () => {
    const bad = 'x\x1b]0;t\x07\ry'
    const out = ui.render(
      [ui.notice({ tone: 'error', verb: 'vx', headline: bad, what: [ui.path(bad), `a\n${bad}`] })],
      ON,
    )
    expect(plain(ui.text(bad, ui.id(`${bad}#b`)))).toBe(
      '  x\\x1b]0;t\\x07\\x0dy\n  x\\x1b]0;t\\x07\\x0dy#b\n',
    )
    expect(out).toContain('x\\x1b]0;t\\x07\\x0dy')
    // oxlint-disable-next-line no-control-regex
    expect(out.replace(/\x1b\[[0-9;]*m/g, '').match(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g)).toBeNull()
  })

  // A warning carries a remote's or a plugin's words: a cache server's
  // `ESC ]0;…` retitled the terminal from the Warnings panel.
  it('writes a control byte in a warning as \\xNN, painted or not', () => {
    const bad = "[vx] plugin 'p': x\x1b]0;t\x07\ry"
    expect(ui.tagged('warn', bad, { enabled: false })).toBe(
      "[vx] plugin 'p': x\\x1b]0;t\\x07\\x0dy",
    )
    const painted = ui.tagged('warn', bad, ON)
    // oxlint-disable-next-line no-control-regex
    expect(painted.replace(/\x1b\[[0-9;]*m/g, '').match(/[\x00-\x1f\x7f-\x9f]/g)).toBeNull()
  })
})

describe('wrap', () => {
  it('breaks at a space and hangs a continuation under the value column', () => {
    // Cut by the column, `uncach|ed` split a word and the next row started
    // at the box's edge, under the label.
    expect(
      ui.wrap('  todo      add inputs and outputs, or the task always runs uncached', 40),
    ).toEqual(
      [
        '  todo      add inputs and outputs, or',
        '            the task always runs',
        '            uncached',
      ].map((r) => r.padEnd(40)),
    )
  })

  it('cuts a word longer than the row, and carries its colour on', () => {
    expect(ui.wrap('\x1b[2mabcdefghijklmnopqrstuvwxyz\x1b[0m end', 20)).toEqual([
      '\x1b[2mabcdefghijklmnopqrst\x1b[0m',
      `\x1b[2muvwxyz\x1b[0m end${' '.repeat(10)}`,
    ])
  })
})
