// `vx help` on a terminal: accents only, never a changed character. The
// painted text strips back to the plain reference byte for byte (the
// parsers and the cut read the plain one), each accent lands on the term
// it names, and the gate paints a TTY only.

import { describe, expect, it } from 'bun:test'
import { helpColors, helpText, paintHelp, verbHelpText } from '../src/cli/help.js'
import { detectColors, paint } from '../src/orchestrator/colors.js'

const ON = { enabled: true }
const ESC = '\x1b['
const strip = (s: string): string => Bun.stripANSI(s)
/** The text of every run painted in `hex`'s truecolor. */
function painted(text: string, hex: string): string[] {
  const seq = Bun.color(hex, 'ansi-16m')!.replace(/\[/g, '\\[')
  return [...text.matchAll(new RegExp(`${seq}([^\\x1b]*)\\x1b\\[0m`, 'g'))].map((m) => m[1]!)
}

describe('paintHelp', () => {
  it('strips back to the plain reference, whole and cut to each verb', () => {
    const plugin = ['  vx deploy            Ship it (@acme/vx-deploy)']
    const texts = [
      helpText(plugin),
      verbHelpText('run'),
      verbHelpText('cache'),
      verbHelpText('why'),
    ]
    for (const text of texts) {
      const out = paintHelp(text, ON, paint)
      expect(out).toContain(ESC)
      expect(strip(out)).toBe(text)
    }
  })

  it('is the text itself when colours are off', () => {
    const text = helpText()
    expect(paintHelp(text, { enabled: false }, paint)).toBe(text)
  })

  it('paints the terms of a section and nothing of its prose', () => {
    const artifacts = helpText()
      .split('\n\n')
      .find((b) => b.startsWith('Artifacts'))!
    expect(painted(paintHelp(artifacts, ON, paint), '#22d3ee')).toEqual([
      '--summarize[=<path>]',
      '--profile[=<path>]',
      '--report[=markdown]',
      '--report-file <path>',
      '--tag <k=v>',
    ])
    const selection = helpText()
      .split('\n\n')
      .find((b) => b.startsWith('Selection'))!
    expect(painted(paintHelp(selection, ON, paint), '#22d3ee')).toEqual([
      '(default)',
      '--all',
      '--filter <pat>',
      '--affected[=<base>]',
      'pkg#task',
    ])
  })

  it('paints a `vx <verb>` form, a plugin verb row, and not prose that opens with vx', () => {
    const text = [
      'vx — title',
      'Usage:',
      '  vx run [OPTIONS]',
      '  vx core runs tasks in-process and nothing else.',
      '  vx deploy            Ship it (@acme/vx-deploy)',
    ].join('\n')
    const out = paintHelp(text, ON, paint)
    expect(painted(out, '#06b6d4')).toEqual(['vx', 'vx run', 'vx deploy'])
    expect(out.split('\n')[3]).toBe('  vx core runs tasks in-process and nothing else.')
  })

  it('bolds a heading and dims its (for <verb>)', () => {
    expect(paintHelp('t\nSelection (for run):', ON, paint).split('\n')[1]).toBe(
      `${paint('', 'Selection', ON, { bold: true })}${paint('', ' (for run)', ON, { dim: true })}${paint('', ':', ON, { bold: true })}`,
    )
  })
})

describe('helpColors', () => {
  const on = () => ON
  const off = () => ({ enabled: false })
  it('paints a TTY the env allows, and nothing off a TTY whatever forces colour', () => {
    expect([
      helpColors({ isTTY: true }, on).enabled,
      helpColors({ isTTY: true }, off).enabled,
      helpColors({ isTTY: false }, on).enabled,
      helpColors({}, on).enabled,
    ]).toEqual([true, false, false, false])
  })

  it('NO_COLOR wins on a TTY through detectColors', () => {
    const saved = process.env['NO_COLOR']
    process.env['NO_COLOR'] = '1'
    try {
      expect(helpColors({ isTTY: true }, detectColors).enabled).toBe(false)
    } finally {
      if (saved === undefined) delete process.env['NO_COLOR']
      else process.env['NO_COLOR'] = saved
    }
  })
})
