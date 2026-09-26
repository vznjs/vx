// The diagram kit's geometry (src/components/guide/diagram/diagram.ts),
// one function at a time, with numbers worked out by hand (item 841). The
// kit's laws in diagram-kit.test.ts read the built pages, so they see a
// change to this file only after a site build; these hold it directly.
import { describe, expect, it } from 'bun:test'
import {
  boxSize,
  extent,
  lanes,
  narrowOf,
  route,
  textWidth,
  type Picture,
} from '../src/components/guide/diagram/diagram.js'

// Boxes are 130 × 52 by default (60 with a sub line), so a box at (x, y)
// has its centre at (x + 65, y + 26).
const pic = (over: Partial<Picture> = {}): Picture => ({
  name: 'p',
  label: 'a picture',
  caption: '',
  boxes: [
    { id: 'a', x: 0, y: 0, label: 'a' },
    { id: 'b', x: 300, y: 0, label: 'b' },
    { id: 'c', x: 0, y: 200, label: 'c' },
    { id: 'd', x: 200, y: 200, label: 'd' },
  ],
  ...over,
})

describe('sizes', () => {
  it('a box is 130 × 52, 60 tall with a sub line, or its own size; mono text is 0.6 em a glyph', () => {
    expect([
      boxSize({ id: 'x', x: 0, y: 0, label: 'x' }),
      boxSize({ id: 'x', x: 0, y: 0, label: 'x', sub: 's' }),
      boxSize({ id: 'x', x: 0, y: 0, label: 'x', w: 10, h: 20 }),
    ]).toEqual([
      { w: 130, h: 52 },
      { w: 130, h: 60 },
      { w: 10, h: 20 },
    ])
    expect(textWidth('abcd', 10)).toBe(24)
  })
})

describe('an arrow', () => {
  it('across: leaves 3 past the border, stops 5 short, its label centred 9 above', () => {
    expect(route(pic(), { from: 'a', to: 'b' })).toEqual({
      d: 'M133.0 26.0 L295.0 26.0',
      lx: 214,
      ly: 17,
      anchor: 'middle',
      across: true,
      span: 162,
    })
  })

  it('down: its label starts 8 to the right, 4 below the middle', () => {
    expect(route(pic(), { from: 'a', to: 'c' })).toEqual({
      d: 'M65.0 55.0 L65.0 195.0',
      lx: 73,
      ly: 129,
      anchor: 'start',
      across: false,
      span: 140,
    })
  })

  it('at 45 degrees it counts as across', () => {
    expect(route(pic(), { from: 'a', to: 'd' }).across).toBe(true)
  })

  it('through waypoints: each end aims at its own neighbour, the label sits on the middle stretch', () => {
    const r = route(pic(), {
      from: 'a',
      to: 'b',
      via: [
        [65, 150],
        [365, 150],
      ],
    })
    expect([r.d, r.lx, r.ly, r.across]).toEqual([
      'M65.0 55.0 L65.0 150.0 L365.0 150.0 L365.0 57.0',
      215,
      141,
      true,
    ])
  })

  it('naming no box is refused with the picture’s name', () => {
    expect(() => route(pic(), { from: 'a', to: 'nope' })).toThrow(
      '<Diagram name="p">: an arrow names no box nope',
    )
  })
})

describe('the drawn stretch', () => {
  it('pads 14 around the boxes, notes, frames, waypoints and arrow labels', () => {
    const one = (over: Partial<Picture>) =>
      extent({ name: 'p', label: 'l', caption: '', boxes: [], ...over })
    const box = { id: 'a', x: 0, y: 100, label: 'a' }
    expect(one({ boxes: [box] })).toEqual({ top: 86, height: 80 })
    // A note's text runs 0.8 of its size above its baseline and 0.3 below.
    expect(one({ boxes: [box], notes: [{ x: 0, y: 200, text: 'n' }] })).toEqual({
      top: 86,
      height: 132,
    })
    expect(one({ boxes: [box], frames: [{ x: 0, y: 30, w: 10, h: 10, label: 'f' }] })).toEqual({
      top: 16,
      height: 150,
    })
    const b2 = { id: 'b', x: 300, y: 100, label: 'b' }
    expect(
      one({
        boxes: [box, b2],
        arrows: [
          {
            from: 'a',
            to: 'b',
            via: [
              [65, 220],
              [365, 220],
            ],
          },
        ],
      }),
    ).toEqual({ top: 86, height: 148 })
    expect(one({ boxes: [box, b2], arrows: [{ from: 'a', to: 'b', label: 'x' }] })).toEqual({
      top: 86,
      height: 80,
    })
    // A label on a stretch above the boxes reaches past its waypoints:
    // 9 above y = 40, its text 0.8 of 13 above that.
    const over = (label?: string) =>
      one({
        boxes: [box, b2],
        arrows: [
          {
            from: 'a',
            to: 'b',
            via: [
              [65, 40],
              [365, 40],
            ],
            ...(label ? { label } : {}),
          },
        ],
      })
    expect([over(), over('x')]).toEqual([
      { top: 26, height: 140 },
      { top: 7, height: 159 },
    ])
    expect(one({ boxes: [box], arrows: [], notes: [{ x: 0, y: 60, text: 'n' }] })).toEqual({
      top: 35,
      height: 131,
    })
  })

  it('stops at the top and at the picture’s height', () => {
    expect(
      extent({ name: 'p', label: 'l', caption: '', boxes: [{ id: 'a', x: 0, y: 5, label: 'a' }] }),
    ).toEqual({
      top: 0,
      height: 71,
    })
    expect(
      extent({
        name: 'p',
        label: 'l',
        caption: '',
        boxes: [{ id: 'a', x: 0, y: 230, label: 'a' }],
      }),
    ).toEqual({
      top: 216,
      height: 44,
    })
  })
})

describe('lanes', () => {
  it('a row per lane, its name to the left; a bar too narrow drops its label and sub, keeps its title', () => {
    const { boxes, notes } = lanes(
      [
        {
          name: 'w1',
          bars: [
            { start: 0, end: 10, label: 'build', sub: '1.2s', tone: 'accent' },
            { start: 10, end: 11, label: 'lint', sub: 'x', title: 'lint' },
          ],
        },
        {
          name: 'w2',
          bars: [{ start: 0, end: 10, label: 'test', sub: 'a sub far too wide', id: 't' }],
        },
      ],
      { x: 100, y: 10, scale: 10, row: 50 },
    )
    expect(notes).toEqual([
      { x: 90, y: 35, text: 'w1', anchor: 'end' },
      { x: 90, y: 85, text: 'w2', anchor: 'end' },
    ])
    expect(boxes).toEqual([
      { id: 'w1/0', x: 100, y: 10, w: 97, h: 40, label: 'build', sub: '1.2s', tone: 'accent' },
      { id: 'w1/1', x: 200, y: 10, w: 7, h: 40, label: '', title: 'lint' },
      { id: 't', x: 100, y: 60, w: 97, h: 40, label: 'test' },
    ])
  })

  it('a label that fits only without its 6 of margin is dropped', () => {
    // 'abcd' is 36 wide at 15; the bar is 3 × 13.6 − 3 = 37.8 wide.
    const { boxes } = lanes([{ name: 'l', bars: [{ start: 0, end: 3, label: 'abcd' }] }], {
      x: 0,
      y: 0,
      scale: 13.6,
      row: 50,
    })
    expect(boxes[0]!.label).toBe('')
  })
})

describe('the phone layout', () => {
  it('is a picture of its own under a name of its own, or none', () => {
    expect(narrowOf(pic())).toBeUndefined()
    const phone = narrowOf(pic({ width: 700, narrow: { width: 340, boxes: [] } }))
    expect([phone?.name, phone?.width, phone?.boxes, 'narrow' in phone!]).toEqual([
      'p-narrow',
      340,
      [],
      false,
    ])
  })
})
