// The AI agents page's pictures (docs/agents.mdx).

import type { Picture } from '../../guide/diagram/diagram.js'

export const agentLoop: Picture = {
  name: 'agent-loop',
  label:
    'An agent asks vx what to run, runs it, reads the result as JSON, fixes the files it names, and runs again.',
  caption: 'Ask, run, read, fix: the loop an agent drives through vx.',
  height: 190,
  boxes: [
    { id: 'ask', x: 10, y: 30, w: 125, label: 'ask', sub: 'vx show' },
    { id: 'run', x: 165, y: 30, w: 125, label: 'run', sub: 'vx run', tone: 'accent' },
    { id: 'read', x: 320, y: 30, w: 125, label: 'read', sub: 'vx last' },
    { id: 'fix', x: 475, y: 30, w: 115, label: 'fix', sub: 'edit files', tone: 'warn' },
  ],
  arrows: [
    { from: 'ask', to: 'run' },
    { from: 'run', to: 'read' },
    { from: 'read', to: 'fix' },
    {
      from: 'fix',
      to: 'run',
      label: 'run again',
      dashed: true,
      via: [
        [532, 150],
        [227, 150],
      ],
    },
  ],
  narrow: {
    width: 340,
    height: 240,
    boxes: [
      { id: 'ask', x: 0, y: 10, w: 140, label: 'ask', sub: 'vx show' },
      { id: 'run', x: 200, y: 10, w: 140, label: 'run', sub: 'vx run', tone: 'accent' },
      { id: 'read', x: 200, y: 160, w: 140, label: 'read', sub: 'vx last' },
      { id: 'fix', x: 0, y: 160, w: 140, label: 'fix', sub: 'edit files', tone: 'warn' },
    ],
    arrows: [
      { from: 'ask', to: 'run' },
      { from: 'run', to: 'read' },
      { from: 'read', to: 'fix' },
      { from: 'fix', to: 'run', label: 'run again', dashed: true },
    ],
  },
}
