// The Workspace page's pictures (docs/workspace.mdx).

import type { Picture } from '../../guide/diagram/diagram.js'

export const workspaceLock: Picture = {
  name: 'workspace-lock',
  label:
    'vx lock reads every vx.config.ts once and writes .vx/projects.lock. vx run and vx watch read only that lock, never the configs.',
  caption: 'Configs are read once, by vx lock. Every run reads the lock.',
  height: 220,
  boxes: [
    { id: 'cfg', x: 10, y: 20, w: 160, label: 'vx.config.ts', sub: 'one per project' },
    { id: 'lock', x: 240, y: 24, w: 110, label: 'vx lock', tone: 'accent' },
    { id: 'file', x: 420, y: 20, w: 170, label: 'projects.lock', sub: 'you commit it' },
    { id: 'run', x: 420, y: 150, w: 170, label: 'vx run', sub: 'reads only the lock', tone: 'ok' },
  ],
  arrows: [
    { from: 'cfg', to: 'lock', label: 'reads' },
    { from: 'lock', to: 'file', label: 'writes' },
    { from: 'file', to: 'run' },
  ],
  narrow: {
    width: 340,
    height: 370,
    boxes: [
      { id: 'cfg', x: 90, y: 10, w: 160, label: 'vx.config.ts', sub: 'one per project' },
      { id: 'lock', x: 115, y: 110, w: 110, label: 'vx lock', tone: 'accent' },
      { id: 'file', x: 85, y: 200, w: 170, label: 'projects.lock', sub: 'you commit it' },
      { id: 'run', x: 85, y: 300, w: 170, label: 'vx run', sub: 'reads only the lock', tone: 'ok' },
    ],
    arrows: [
      { from: 'cfg', to: 'lock', label: 'reads' },
      { from: 'lock', to: 'file', label: 'writes' },
      { from: 'file', to: 'run' },
    ],
  },
}
