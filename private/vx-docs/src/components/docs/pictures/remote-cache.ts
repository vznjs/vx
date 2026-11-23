import type { Picture } from '../../guide/diagram/diagram.js'

// Remote cache page (docs/remote-cache.mdx).

export const branchReads: Picture = {
  name: 'branch-reads',
  label:
    'A push to main reads and writes main’s results. Pull request #12 reads and writes its own results, and reads main’s too, but never writes them.',
  caption: 'main writes main; a pull request writes only its own results and also reads main’s.',
  height: 250,
  frames: [{ x: 380, y: 10, w: 190, h: 230, label: 'cache server', tone: 'link' }],
  boxes: [
    { id: 'main', x: 10, y: 50, w: 170, label: 'push to main', tone: 'accent' },
    { id: 'pr', x: 10, y: 170, w: 170, label: 'PR #12', tone: 'accent' },
    { id: 'mainRes', x: 410, y: 50, w: 130, label: 'main', tone: 'ok' },
    { id: 'prRes', x: 410, y: 170, w: 130, label: 'PR #12', tone: 'ok' },
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
    frames: [{ x: 216, y: 10, w: 124, h: 270, label: 'cache server', tone: 'link' }],
    boxes: [
      { id: 'main', x: 0, y: 50, w: 130, label: 'push to main', tone: 'accent' },
      { id: 'pr', x: 0, y: 210, w: 130, label: 'PR #12', tone: 'accent' },
      { id: 'mainRes', x: 240, y: 50, w: 90, label: 'main', tone: 'ok' },
      { id: 'prRes', x: 240, y: 210, w: 90, label: 'PR #12', tone: 'ok' },
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
          [65, 160],
          [285, 160],
        ],
      },
    ],
  },
}
