// The Lockfiles page's pictures (docs/lockfiles.mdx).

import type { Picture } from '../../guide/diagram/diagram.js'

export const lockfileSlices: Picture = {
  name: 'lockfile-slices',
  label:
    'One bun.lock holds every project’s dependencies. The plugin gives each project only its own slice: @demo/ui gets clsx, @demo/web gets ms and @demo/ui. Each slice goes into that project’s key, so bumping ms changes only @demo/web’s key.',
  caption: 'One lockfile, one slice per project: an install re-keys only the projects it reached.',
  height: 230,
  boxes: [
    { id: 'lock', x: 10, y: 84, w: 150, label: 'bun.lock', sub: 'every install' },
    { id: 'ui', x: 230, y: 14, w: 180, label: '@demo/ui', sub: 'clsx 2.1.1' },
    { id: 'web', x: 230, y: 154, w: 180, label: '@demo/web', sub: 'ms 2.1.3 · @demo/ui' },
    { id: 'kui', x: 470, y: 14, w: 120, label: 'ui key', tone: 'ok' },
    { id: 'kweb', x: 470, y: 154, w: 120, label: 'web key', tone: 'accent' },
  ],
  arrows: [
    { from: 'lock', to: 'ui', label: 'slice', via: [[195, 40]] },
    { from: 'lock', to: 'web', label: 'slice', via: [[195, 180]] },
    { from: 'ui', to: 'kui' },
    { from: 'web', to: 'kweb' },
  ],
  narrow: {
    width: 340,
    height: 330,
    boxes: [
      { id: 'lock', x: 95, y: 10, w: 150, label: 'bun.lock', sub: 'every install' },
      { id: 'ui', x: 0, y: 130, w: 150, label: '@demo/ui', sub: 'clsx 2.1.1' },
      { id: 'web', x: 160, y: 130, w: 180, label: '@demo/web', sub: 'ms 2.1.3 · @demo/ui' },
      { id: 'kui', x: 15, y: 260, w: 120, label: 'ui key', tone: 'ok' },
      { id: 'kweb', x: 190, y: 260, w: 120, label: 'web key', tone: 'accent' },
    ],
    arrows: [
      { from: 'lock', to: 'ui', label: 'slice' },
      { from: 'lock', to: 'web', label: 'slice' },
      { from: 'ui', to: 'kui' },
      { from: 'web', to: 'kweb' },
    ],
  },
}
