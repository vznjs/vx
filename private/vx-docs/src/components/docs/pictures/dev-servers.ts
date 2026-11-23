// The Dev servers page's pictures (docs/dev-servers.mdx).

import type { Picture } from '../../guide/diagram/diagram.js'

const STEPS: [id: string, label: string, sub: string, tone?: 'accent' | 'ok' | 'muted'][] = [
  ['start', 'start', 'vite'],
  ['wait', 'wait', "for 'Local:'", 'accent'],
  ['ready', 'ready', 'checks run', 'ok'],
  ['stop', 'stop', 'run ends', 'muted'],
]
const arrows = STEPS.slice(1).map(([to], i) => ({ from: STEPS[i]![0], to }))

export const serverLife: Picture = {
  name: 'server-life',
  label:
    'A dev server starts, vx waits for its readyWhen line, then its dependents run, and vx stops it when the run ends.',
  caption: 'A dev server in a run: start, wait for the line, run what needs it, stop.',
  height: 120,
  boxes: STEPS.map(([id, label, sub, tone], i) => ({
    id,
    x: 10 + i * 150,
    y: 30,
    w: 130,
    label,
    sub,
    ...(tone === undefined ? {} : { tone }),
  })),
  arrows,
  narrow: {
    width: 340,
    height: 380,
    boxes: STEPS.map(([id, label, sub, tone], i) => ({
      id,
      x: 95,
      y: 10 + i * 95,
      w: 150,
      label,
      sub,
      ...(tone === undefined ? {} : { tone }),
    })),
    arrows,
  },
}
