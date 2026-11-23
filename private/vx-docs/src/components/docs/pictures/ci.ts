// The CI page's pictures (docs/ci.mdx).
import type { Picture } from '../../guide/diagram/diagram.js'

export const ciPipelines: Picture = {
  name: 'ci-pipelines',
  label:
    'A pull request runs vx pipeline pr, which runs the changed projects and what depends on them. A push to main runs vx pipeline main, which runs every project, and the cache skips what did not change.',
  caption:
    'One workflow, two pipelines: a pull request runs what it changed, main runs everything.',
  height: 200,
  boxes: [
    { id: 'pr', x: 10, y: 20, w: 150, label: 'pull request' },
    { id: 'vpr', x: 210, y: 20, w: 170, label: 'vx pipeline pr', tone: 'accent' },
    {
      id: 'rpr',
      x: 430,
      y: 16,
      w: 160,
      label: 'what changed',
      sub: '+ its dependents',
      tone: 'ok',
    },
    { id: 'main', x: 10, y: 120, w: 150, label: 'push to main' },
    { id: 'vmain', x: 210, y: 120, w: 170, label: 'vx pipeline main', tone: 'accent' },
    {
      id: 'rmain',
      x: 430,
      y: 116,
      w: 160,
      label: 'every project',
      sub: 'unchanged: cached',
      tone: 'ok',
    },
  ],
  arrows: [
    { from: 'pr', to: 'vpr' },
    { from: 'vpr', to: 'rpr' },
    { from: 'main', to: 'vmain' },
    { from: 'vmain', to: 'rmain' },
  ],
  narrow: {
    width: 340,
    height: 300,
    boxes: [
      { id: 'pr', x: 0, y: 10, w: 165, label: 'pull request' },
      { id: 'vpr', x: 0, y: 110, w: 165, label: 'vx pipeline pr', tone: 'accent' },
      {
        id: 'rpr',
        x: 0,
        y: 210,
        w: 165,
        label: 'what changed',
        sub: '+ its dependents',
        tone: 'ok',
      },
      { id: 'main', x: 175, y: 10, w: 165, label: 'push to main' },
      { id: 'vmain', x: 175, y: 110, w: 165, label: 'vx pipeline main', tone: 'accent' },
      {
        id: 'rmain',
        x: 175,
        y: 210,
        w: 165,
        label: 'every project',
        sub: 'unchanged: cached',
        tone: 'ok',
      },
    ],
    arrows: [
      { from: 'pr', to: 'vpr' },
      { from: 'vpr', to: 'rpr' },
      { from: 'main', to: 'vmain' },
      { from: 'vmain', to: 'rmain' },
    ],
  },
}

export const lockCheck: Picture = {
  name: 'lock-check',
  label:
    'vx lock evaluates every vx.config.ts into .vx/projects.lock, which you commit. Every run reads only the lock. On CI, vx lock --check evaluates the configs again and fails when they no longer match the lock.',
  caption: 'Runs read the lock. vx lock --check catches a config edited without vx lock.',
  height: 230,
  boxes: [
    { id: 'cfg', x: 10, y: 20, w: 150, label: 'vx.config.ts', sub: 'you edit' },
    { id: 'lock', x: 220, y: 24, w: 150, label: 'vx lock', tone: 'accent' },
    { id: 'file', x: 430, y: 20, w: 160, label: 'projects.lock', sub: 'committed' },
    { id: 'run', x: 430, y: 150, w: 160, label: 'every run', sub: 'reads the lock' },
    {
      id: 'check',
      x: 160,
      y: 150,
      w: 210,
      label: 'vx lock --check',
      sub: 'same? else fail',
      tone: 'warn',
    },
  ],
  arrows: [
    { from: 'cfg', to: 'lock' },
    { from: 'lock', to: 'file', label: 'writes' },
    { from: 'file', to: 'run' },
    {
      from: 'check',
      to: 'file',
      label: 'compares',
      dashed: true,
      via: [
        [400, 176],
        [400, 46],
      ],
    },
  ],
  narrow: {
    width: 340,
    height: 420,
    boxes: [
      { id: 'cfg', x: 95, y: 10, w: 150, label: 'vx.config.ts', sub: 'you edit' },
      { id: 'lock', x: 95, y: 110, w: 150, label: 'vx lock', tone: 'accent' },
      { id: 'file', x: 90, y: 210, w: 160, label: 'projects.lock', sub: 'committed' },
      { id: 'run', x: 0, y: 340, w: 160, label: 'every run', sub: 'reads the lock' },
      {
        id: 'check',
        x: 170,
        y: 340,
        w: 170,
        label: 'vx lock --check',
        sub: 'same? else fail',
        tone: 'warn',
      },
    ],
    arrows: [
      { from: 'cfg', to: 'lock' },
      { from: 'lock', to: 'file', label: 'writes' },
      { from: 'file', to: 'run' },
      { from: 'check', to: 'file', label: 'compares', dashed: true },
    ],
  },
}
