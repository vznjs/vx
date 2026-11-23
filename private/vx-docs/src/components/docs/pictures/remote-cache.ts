import type { Picture } from '../../guide/diagram/diagram.js'

// Remote cache page (docs/remote-cache.mdx).

export const branchReads: Picture = {
  name: 'branch-reads',
  label:
    'A push to main reads and writes main’s results. A pull request from feat-x reads and writes feat-x’s results, and reads main’s too, but never writes them.',
  caption: 'Each branch writes only its own results; a pull request also reads main’s.',
  height: 250,
  frames: [{ x: 380, y: 10, w: 190, h: 230, label: 'cache server', tone: 'link' }],
  boxes: [
    { id: 'main', x: 10, y: 50, w: 170, label: 'push to main', tone: 'accent' },
    { id: 'pr', x: 10, y: 170, w: 170, label: 'PR from feat-x', tone: 'accent' },
    { id: 'mainRes', x: 410, y: 50, w: 130, label: 'main', tone: 'ok' },
    { id: 'prRes', x: 410, y: 170, w: 130, label: 'feat-x', tone: 'ok' },
  ],
  arrows: [
    { from: 'main', to: 'mainRes', label: 'read + write' },
    { from: 'pr', to: 'prRes', label: 'read + write' },
    {
      from: 'pr',
      to: 'mainRes',
      label: 'read only',
      dashed: true,
      tone: 'link',
      via: [
        [95, 140],
        [475, 140],
      ],
    },
  ],
  narrow: {
    width: 340,
    height: 290,
    frames: [{ x: 226, y: 10, w: 114, h: 270, label: 'cache server', tone: 'link' }],
    boxes: [
      { id: 'main', x: 0, y: 50, w: 140, label: 'push to main', tone: 'accent' },
      { id: 'pr', x: 0, y: 210, w: 140, label: 'PR from feat-x', tone: 'accent' },
      { id: 'mainRes', x: 244, y: 50, w: 86, label: 'main', tone: 'ok' },
      { id: 'prRes', x: 244, y: 210, w: 86, label: 'feat-x', tone: 'ok' },
    ],
    arrows: [
      { from: 'main', to: 'mainRes', label: 'read + write' },
      { from: 'pr', to: 'prRes', label: 'read + write' },
      {
        from: 'pr',
        to: 'mainRes',
        label: 'read only',
        dashed: true,
        tone: 'link',
        via: [
          [70, 160],
          [287, 160],
        ],
      },
    ],
  },
}
