// The Plugins page's pictures (docs/plugins.mdx).

import type { Picture } from '../../guide/diagram/diagram.js'

export const pluginsAroundRun: Picture = {
  name: 'plugins-around-run',
  label:
    '.vx/workspace.ts lists the plugins for every run. Each run always runs and caches on this machine; plugins add a cache server, an OpenTelemetry collector and CI workers.',
  caption: 'This machine is always there. Each plugin adds one more place a run can reach.',
  height: 290,
  boxes: [
    { id: 'ws', x: 10, y: 114, w: 170, label: '.vx/workspace.ts', sub: 'plugins: [...]' },
    { id: 'run', x: 240, y: 118, w: 110, label: 'vx run', tone: 'accent' },
    {
      id: 'here',
      x: 420,
      y: 10,
      w: 170,
      label: 'this machine',
      sub: 'always: run, cache',
      tone: 'ok',
    },
    { id: 'cache', x: 420, y: 80, w: 170, label: 'cache server', sub: 'vxCache()', tone: 'link' },
    { id: 'otel', x: 420, y: 150, w: 170, label: 'OpenTelemetry', sub: 'otel()', tone: 'link' },
    { id: 'ci', x: 420, y: 220, w: 170, label: 'CI workers', sub: 'dte()', tone: 'link' },
  ],
  arrows: [
    { from: 'ws', to: 'run' },
    { from: 'run', to: 'here', via: [[385, 40]] },
    { from: 'run', to: 'cache', via: [[385, 110]] },
    { from: 'run', to: 'otel', via: [[385, 180]] },
    { from: 'run', to: 'ci', via: [[385, 250]] },
  ],
  narrow: {
    width: 340,
    height: 380,
    boxes: [
      { id: 'ws', x: 0, y: 0, w: 170, label: '.vx/workspace.ts', sub: 'plugins: [...]' },
      { id: 'run', x: 30, y: 209, w: 110, label: 'vx run', tone: 'accent' },
      {
        id: 'here',
        x: 180,
        y: 90,
        w: 160,
        label: 'this machine',
        sub: 'always: run, cache',
        tone: 'ok',
      },
      {
        id: 'cache',
        x: 180,
        y: 160,
        w: 160,
        label: 'cache server',
        sub: 'vxCache()',
        tone: 'link',
      },
      { id: 'otel', x: 180, y: 230, w: 160, label: 'OpenTelemetry', sub: 'otel()', tone: 'link' },
      { id: 'ci', x: 180, y: 300, w: 160, label: 'CI workers', sub: 'dte()', tone: 'link' },
    ],
    arrows: [
      { from: 'ws', to: 'run' },
      { from: 'run', to: 'here', via: [[160, 120]] },
      { from: 'run', to: 'cache', via: [[160, 190]] },
      { from: 'run', to: 'otel', via: [[160, 260]] },
      { from: 'run', to: 'ci', via: [[160, 330]] },
    ],
  },
}
